import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { TURNSTILE_TOKEN_HEADER } from '../../src/worker/security/turnstile';
import { OCR_POLICY } from '../../src/worker/security/rate-limit';

/**
 * `POST /api/ocr` behaviour end to end through the worker, with the mock OCR
 * provider and the mock Turnstile verifier.
 *
 * The most important assertions here are the negative ones: after a successful
 * OCR call, the database and the bucket must be exactly as empty as before.
 * That is the guarantee in Issue #1 section 6 and it cannot be verified by
 * reading the code alone.
 */

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];

function cardImage(sizeBytes = 512): Uint8Array {
  const bytes = new Uint8Array(Math.max(sizeBytes, JPEG_HEADER.length));
  bytes.set(JPEG_HEADER, 0);
  return bytes;
}

/**
 * A valid JPEG that is too small to be a card. It passes file validation - the
 * magic bytes are right - and is then rejected by the provider, which is the
 * only way to reach the OCR failure path from outside.
 */
function tooSmallToBeACard(): Uint8Array {
  return cardImage(JPEG_HEADER.length);
}

function ocrRequest(
  body: Uint8Array | null,
  headers: Record<string, string> = { [TURNSTILE_TOKEN_HEADER]: 'test-token' },
  clientIp = '203.0.113.10',
): Request {
  return new Request('http://localhost/api/ocr', {
    method: 'POST',
    headers: { 'cf-connecting-ip': clientIp, ...headers },
    ...(body ? { body: body as BodyInit } : {}),
  });
}

async function storageCounts(): Promise<{ rows: number; objects: number }> {
  const { results } = await env.DB.prepare(
    `select
       (select count(*) from applications) +
       (select count(*) from addresses) +
       (select count(*) from payments) +
       (select count(*) from receipts) +
       (select count(*) from emails) +
       (select count(*) from application_events) as rows`,
  ).all<{ rows: number }>();
  const listing = await env.MEMBER_PHOTOS.list();
  return { rows: results[0]!.rows, objects: listing.objects.length };
}

describe('POST /api/ocr', () => {
  it('returns the mapped card data', async () => {
    const response = await exports.default.fetch(ocrRequest(cardImage()));

    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      citizenId: '1234567890121',
      titleTh: 'นาย',
      province: 'กรุงเทพมหานคร',
    });
  });

  it('tells browsers and proxies not to store the response', async () => {
    // The body is a person's identity data; it must not sit in a cache.
    const response = await exports.default.fetch(ocrRequest(cardImage()));

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never has a postal code to return', async () => {
    const response = await exports.default.fetch(ocrRequest(cardImage()));
    const text = await response.text();

    expect(text).not.toContain('postalCode');
    expect(text).not.toContain('postal_code');
  });

  it('writes nothing to the database or the bucket', async () => {
    const before = await storageCounts();

    const response = await exports.default.fetch(ocrRequest(cardImage()));
    expect(response.status).toBe(200);

    // Reading a card must leave no trace: an abandoned OCR attempt leaves no
    // data behind at all (Issue #1 section 6).
    await expect(storageCounts()).resolves.toEqual(before);
  });

  it('writes nothing even when OCR fails', async () => {
    const before = await storageCounts();

    // A valid JPEG that is too small to be a card: the provider rejects it.
    await exports.default.fetch(ocrRequest(tooSmallToBeACard()));

    await expect(storageCounts()).resolves.toEqual(before);
  });
});

describe('POST /api/ocr abuse controls', () => {
  it('refuses a request with no Turnstile token', async () => {
    const response = await exports.default.fetch(ocrRequest(cardImage(), {}));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('refuses before reading the body, so an abusive upload costs nothing', async () => {
    const before = await storageCounts();

    // Ten megabytes with no token: the rejection must not depend on reading it.
    const response = await exports.default.fetch(ocrRequest(new Uint8Array(10 * 1024 * 1024), {}));

    expect(response.status).toBe(403);
    await expect(storageCounts()).resolves.toEqual(before);
  });

  it('rate limits a client that keeps calling', async () => {
    const ip = '203.0.113.77';
    let lastStatus = 0;

    for (let attempt = 0; attempt <= OCR_POLICY.limit; attempt += 1) {
      const response = await exports.default.fetch(
        ocrRequest(cardImage(), { [TURNSTILE_TOKEN_HEADER]: 'test-token' }, ip),
      );
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('counts the rate limit per client, not globally', async () => {
    for (let attempt = 0; attempt < OCR_POLICY.limit; attempt += 1) {
      await exports.default.fetch(
        ocrRequest(cardImage(), { [TURNSTILE_TOKEN_HEADER]: 'test-token' }, '203.0.113.81'),
      );
    }

    const other = await exports.default.fetch(
      ocrRequest(cardImage(), { [TURNSTILE_TOKEN_HEADER]: 'test-token' }, '203.0.113.82'),
    );
    expect(other.status).toBe(200);
  });
});

describe('POST /api/ocr file validation', () => {
  it('rejects a file that is not an image, whatever it claims to be', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

    const response = await exports.default.fetch(
      ocrRequest(pdf, {
        [TURNSTILE_TOKEN_HEADER]: 'test-token',
        'content-type': 'image/jpeg',
      }),
    );

    expect(response.status).toBe(415);
  });

  it('rejects an oversized upload', async () => {
    // Over the 2 MB ceiling, which is set to iApp's most conservative
    // documented limit so a size problem is reported as a size problem.
    const large = new Uint8Array(3 * 1024 * 1024);
    large.set(JPEG_HEADER, 0);

    const response = await exports.default.fetch(ocrRequest(large));

    expect(response.status).toBe(413);
  });

  it('accepts an image just under the ceiling', async () => {
    const response = await exports.default.fetch(ocrRequest(cardImage(2 * 1024 * 1024 - 1)));

    expect(response.status).toBe(200);
  });

  it('rejects a request with no body', async () => {
    const response = await exports.default.fetch(ocrRequest(null));

    expect(response.status).toBe(400);
  });
});

describe('POST /api/ocr failure reporting', () => {
  it('reports a machine-readable reason so the client can offer manual entry', async () => {
    const response = await exports.default.fetch(ocrRequest(tooSmallToBeACard()));

    expect(response.status).toBe(422);
    const body = await response.json<{
      error: { code: string; reason: string; message: string };
    }>();
    expect(body.error.code).toBe('OCR_FAILED');
    expect(body.error.reason).toBe('PROVIDER_REJECTED_IMAGE');
    // The message has to tell the applicant what to do next; Issue #1 section 64
    // requires manual entry as the fallback.
    expect(body.error.message).toContain('กรอกข้อมูลด้วยตนเอง');
  });

  it('never exposes provider detail in a failure message', async () => {
    const response = await exports.default.fetch(ocrRequest(tooSmallToBeACard()));
    const text = await response.text();

    for (const leak of ['iapp', 'api.iapp.co.th', 'apikey', 'detection_score']) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });
});
