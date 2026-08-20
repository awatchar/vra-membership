import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createKeyedHasher } from '../../src/worker/lib/crypto';
import { ApiError } from '../../src/worker/lib/http';
import {
  assertWithinRateLimit,
  clientIdentifier,
  createRateLimiter,
} from '../../src/worker/security/rate-limit';
import type { RateLimitPolicy } from '../../src/worker/security/rate-limit';
import { repository, TEST_KEY } from '../support/fixtures';

const POLICY: RateLimitPolicy = { scope: 'ocr', limit: 3, periodSeconds: 60 };

async function limiter(now: () => Date = () => new Date('2026-08-20T10:00:00.000Z')) {
  const hasher = await createKeyedHasher(TEST_KEY, 'vra:rate-limit:test');
  return createRateLimiter(repository(), hasher, { now });
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit and refuses the next one', async () => {
    const rateLimiter = await limiter();

    for (let attempt = 1; attempt <= POLICY.limit; attempt += 1) {
      const decision = await rateLimiter.consume(POLICY, '203.0.113.1');
      expect(decision.allowed).toBe(true);
      expect(decision.used).toBe(attempt);
    }

    const refused = await rateLimiter.consume(POLICY, '203.0.113.1');
    expect(refused.allowed).toBe(false);
    expect(refused.used).toBe(POLICY.limit + 1);
  });

  it('counts each identifier separately', async () => {
    const rateLimiter = await limiter();

    for (let attempt = 0; attempt < POLICY.limit; attempt += 1) {
      await rateLimiter.consume(POLICY, '203.0.113.1');
    }

    await expect(rateLimiter.consume(POLICY, '203.0.113.2')).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it('counts each scope separately', async () => {
    const rateLimiter = await limiter();

    for (let attempt = 0; attempt < POLICY.limit; attempt += 1) {
      await rateLimiter.consume(POLICY, '203.0.113.1');
    }

    await expect(
      rateLimiter.consume({ ...POLICY, scope: 'payment' }, '203.0.113.1'),
    ).resolves.toMatchObject({ allowed: true, used: 1 });
  });

  it('starts a fresh window when the period rolls over', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const rateLimiter = await limiter(() => now);

    for (let attempt = 0; attempt < POLICY.limit; attempt += 1) {
      await rateLimiter.consume(POLICY, '203.0.113.1');
    }
    await expect(rateLimiter.consume(POLICY, '203.0.113.1')).resolves.toMatchObject({
      allowed: false,
    });

    now = new Date('2026-08-20T10:01:00.000Z');
    await expect(rateLimiter.consume(POLICY, '203.0.113.1')).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it('keeps counting within the same window regardless of position in it', async () => {
    let now = new Date('2026-08-20T10:00:05.000Z');
    const rateLimiter = await limiter(() => now);

    await rateLimiter.consume(POLICY, '203.0.113.1');
    now = new Date('2026-08-20T10:00:59.000Z');

    await expect(rateLimiter.consume(POLICY, '203.0.113.1')).resolves.toMatchObject({ used: 2 });
  });

  it('reports when the window resets', async () => {
    const rateLimiter = await limiter(() => new Date('2026-08-20T10:00:30.000Z'));

    const decision = await rateLimiter.consume(POLICY, '203.0.113.1');
    expect(decision.resetAt).toBe(
      Math.floor(new Date('2026-08-20T10:01:00.000Z').getTime() / 1000),
    );
  });

  it('counts concurrent requests without losing any', async () => {
    // A read-then-write counter would let several requests read the same value
    // and write back the same total, so the limit would never be reached.
    const rateLimiter = await limiter();

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => rateLimiter.consume(POLICY, '203.0.113.9')),
    );

    expect(decisions.map((decision) => decision.used).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(POLICY.limit);
  });

  it('deletes windows that can no longer be consulted', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const rateLimiter = await limiter(() => now);
    await rateLimiter.consume(POLICY, '203.0.113.1');

    // Three periods later, the first window is beyond the retained range.
    now = new Date('2026-08-20T10:03:00.000Z');
    await rateLimiter.consume(POLICY, '203.0.113.1');

    const { results } = await env.DB.prepare('select count(*) as rows from rate_limits').all<{
      rows: number;
    }>();
    expect(results[0]!.rows).toBe(1);
  });
});

describe('privacy of the stored bucket', () => {
  it('never stores the identifier in clear text', async () => {
    const address = '203.0.113.44';
    const rateLimiter = await limiter();

    await rateLimiter.consume(POLICY, address);

    const { results } = await env.DB.prepare('select bucket from rate_limits').all<{
      bucket: string;
    }>();
    expect(results).toHaveLength(1);
    // A client IP is personal data; a counter only ever needs a hash of it.
    expect(results[0]!.bucket).not.toContain(address);
    expect(results[0]!.bucket).not.toContain('ocr');
  });

  it('produces a different bucket under a different key', async () => {
    const first = createRateLimiter(
      repository(),
      await createKeyedHasher(TEST_KEY, 'vra:rate-limit:test'),
      {},
    );
    const second = createRateLimiter(
      repository(),
      await createKeyedHasher(`${TEST_KEY}-other`, 'vra:rate-limit:test'),
      {},
    );

    await first.consume(POLICY, '203.0.113.1');
    await second.consume(POLICY, '203.0.113.1');

    const { results } = await env.DB.prepare(
      'select count(distinct bucket) as buckets from rate_limits',
    ).all<{ buckets: number }>();
    expect(results[0]!.buckets).toBe(2);
  });
});

describe('clientIdentifier', () => {
  it('uses the Cloudflare-supplied client address', () => {
    const request = new Request('http://localhost/api/ocr', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });

    expect(clientIdentifier(request)).toBe('203.0.113.7');
  });

  it('falls back to a single shared bucket when the header is absent', () => {
    // Sharing one bucket is stricter than letting an unidentified caller
    // through, which is the right way to fail.
    expect(clientIdentifier(new Request('http://localhost/api/ocr'))).toBe('unknown-client');
  });

  it('ignores a client-supplied X-Forwarded-For', () => {
    // Only CF-Connecting-IP is set by the edge; trusting a header the client
    // controls would make the limit trivially bypassable.
    const request = new Request('http://localhost/api/ocr', {
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });

    expect(clientIdentifier(request)).toBe('unknown-client');
  });
});

describe('assertWithinRateLimit', () => {
  it('returns the decision while under the limit', async () => {
    const rateLimiter = await limiter();

    await expect(assertWithinRateLimit(rateLimiter, POLICY, '203.0.113.1')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('throws RATE_LIMITED once over the limit', async () => {
    const rateLimiter = await limiter();
    for (let attempt = 0; attempt < POLICY.limit; attempt += 1) {
      await rateLimiter.consume(POLICY, '203.0.113.1');
    }

    const error = await assertWithinRateLimit(rateLimiter, POLICY, '203.0.113.1').catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('RATE_LIMITED');
  });

  it('does not reveal the identifier in the message', async () => {
    const address = '203.0.113.55';
    const rateLimiter = await limiter();
    for (let attempt = 0; attempt < POLICY.limit; attempt += 1) {
      await rateLimiter.consume(POLICY, address);
    }

    const error = await assertWithinRateLimit(rateLimiter, POLICY, address).catch(
      (reason: unknown) => reason,
    );
    expect((error as ApiError).publicMessage).not.toContain(address);
  });
});
