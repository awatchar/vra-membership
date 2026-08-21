import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../src/worker/lib/http';
import { timingSafeEqual } from '../../src/worker/lib/crypto';
import {
  assertCsrfProtected,
  assertCsrfToken,
  assertSameOrigin,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfCookie,
  generateCsrfToken,
  readCookie,
} from '../../src/worker/security/csrf';
import {
  assertHumanRequest,
  createMockTurnstileVerifier,
  TURNSTILE_TOKEN_HEADER,
} from '../../src/worker/security/turnstile';
import {
  parseJsonBody,
  parseWithSchema,
  ValidationError,
  validationErrorBody,
} from '../../src/worker/security/validation';

const APP_ORIGIN = 'https://member.vra.or.th';

function post(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/admin/applications/x/nbtc-complete`, {
    method: 'POST',
    headers: { origin: APP_ORIGIN, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/* ------------------------------------------------------------- Turnstile --- */

describe('assertHumanRequest', () => {
  it('passes a request with a valid token', async () => {
    const request = post({ [TURNSTILE_TOKEN_HEADER]: 'a-token' });

    await expect(
      assertHumanRequest(createMockTurnstileVerifier(), request),
    ).resolves.toBeUndefined();
  });

  it('rejects a request with no token', async () => {
    const error = await assertHumanRequest(createMockTurnstileVerifier(), post()).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('FORBIDDEN');
  });

  it('rejects a token the verifier refuses', async () => {
    const verifier = createMockTurnstileVerifier({
      outcome: { ok: false, reason: 'REJECTED' },
    });

    const error = await assertHumanRequest(
      verifier,
      post({ [TURNSTILE_TOKEN_HEADER]: 'stale-token' }),
    ).catch((reason: unknown) => reason);

    expect((error as ApiError).code).toBe('FORBIDDEN');
  });

  it('distinguishes an unreachable verifier from a rejected token', async () => {
    // Failing closed is right, but telling the applicant they look like a bot
    // when Cloudflare is down would send them chasing the wrong problem.
    const verifier = createMockTurnstileVerifier({
      outcome: { ok: false, reason: 'UNAVAILABLE' },
    });

    const error = await assertHumanRequest(
      verifier,
      post({ [TURNSTILE_TOKEN_HEADER]: 'a-token' }),
    ).catch((reason: unknown) => reason);

    expect((error as ApiError).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('never reveals the token or provider detail in the message', async () => {
    const verifier = createMockTurnstileVerifier({
      outcome: { ok: false, reason: 'REJECTED' },
    });
    const token = 'secret-looking-token-value';

    const error = await assertHumanRequest(
      verifier,
      post({ [TURNSTILE_TOKEN_HEADER]: token }),
    ).catch((reason: unknown) => reason);

    expect((error as ApiError).publicMessage).not.toContain(token);
  });
});

/* ------------------------------------------------------------------ CSRF --- */

describe('constant-time comparison', () => {
  it('accepts equal values and rejects differing ones', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects values of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('rejects a value that only shares a prefix', () => {
    // The property that matters is that a partially correct guess is not
    // treated as closer to correct.
    expect(timingSafeEqual('token-aaaa', 'token-bbbb')).toBe(false);
  });
});

describe('generateCsrfToken', () => {
  it('produces a long random hex token', () => {
    const token = generateCsrfToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCsrfToken()).not.toBe(token);
  });
});

describe('csrfCookie', () => {
  it('is scoped to the site and not sent cross-site', () => {
    const cookie = csrfCookie('token-value', { secure: true });

    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=token-value`);
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    // Readable by scripts on purpose: the browser has to echo it into a header,
    // and the token authorises nothing by itself.
    expect(cookie).not.toContain('HttpOnly');
  });

  it('omits Secure for local development over http', () => {
    expect(csrfCookie('token-value', { secure: false })).not.toContain('Secure');
  });
});

describe('readCookie', () => {
  it('reads a cookie from a multi-value header', () => {
    const request = new Request(APP_ORIGIN, {
      headers: { cookie: `other=1; ${CSRF_COOKIE_NAME}=wanted; another=2` },
    });

    expect(readCookie(request, CSRF_COOKIE_NAME)).toBe('wanted');
  });

  it('does not match a cookie whose name merely ends with the target', () => {
    const request = new Request(APP_ORIGIN, {
      headers: { cookie: `not_${CSRF_COOKIE_NAME}=wrong` },
    });

    expect(readCookie(request, CSRF_COOKIE_NAME)).toBeNull();
  });

  it('returns null when there is no cookie header', () => {
    expect(readCookie(new Request(APP_ORIGIN), CSRF_COOKIE_NAME)).toBeNull();
  });
});

describe('assertSameOrigin', () => {
  it('allows a request from the application origin', () => {
    expect(() => assertSameOrigin(post(), APP_ORIGIN)).not.toThrow();
  });

  it('rejects a request from another origin', () => {
    const request = new Request(`${APP_ORIGIN}/api/admin/x`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });

    expect(() => assertSameOrigin(request, APP_ORIGIN)).toThrow(ApiError);
  });

  it('rejects a state-changing request with no Origin at all', () => {
    // An admin action always comes from the app's own pages, so a missing
    // Origin has no legitimate caller and is treated as a failure.
    const request = new Request(`${APP_ORIGIN}/api/admin/x`, { method: 'POST' });

    expect(() => assertSameOrigin(request, APP_ORIGIN)).toThrow(ApiError);
  });

  it('ignores safe methods', () => {
    const request = new Request(`${APP_ORIGIN}/api/admin/x`, { method: 'GET' });

    expect(() => assertSameOrigin(request, APP_ORIGIN)).not.toThrow();
  });

  it('compares origins, not full URLs', () => {
    const request = new Request(`${APP_ORIGIN}/api/admin/x`, {
      method: 'POST',
      headers: { origin: `${APP_ORIGIN}` },
    });

    expect(() => assertSameOrigin(request, `${APP_ORIGIN}/apply`)).not.toThrow();
  });
});

describe('assertCsrfToken', () => {
  const token = 'a'.repeat(64);

  it('accepts a matching cookie and header', () => {
    const request = post({
      cookie: `${CSRF_COOKIE_NAME}=${token}`,
      [CSRF_HEADER_NAME]: token,
    });

    expect(() => assertCsrfToken(request)).not.toThrow();
  });

  it('rejects a request with the cookie but no header', () => {
    // This is the cross-site case: the browser sends the cookie, but the
    // attacking page cannot read it to produce the header.
    const request = post({ cookie: `${CSRF_COOKIE_NAME}=${token}` });

    expect(() => assertCsrfToken(request)).toThrow(ApiError);
  });

  it('rejects a request with the header but no cookie', () => {
    const request = post({ [CSRF_HEADER_NAME]: token });

    expect(() => assertCsrfToken(request)).toThrow(ApiError);
  });

  it('rejects mismatched values', () => {
    const request = post({
      cookie: `${CSRF_COOKIE_NAME}=${token}`,
      [CSRF_HEADER_NAME]: 'b'.repeat(64),
    });

    expect(() => assertCsrfToken(request)).toThrow(ApiError);
  });

  it('ignores safe methods', () => {
    const request = new Request(`${APP_ORIGIN}/api/admin/x`, { method: 'GET' });

    expect(() => assertCsrfToken(request)).not.toThrow();
  });
});

describe('assertCsrfProtected', () => {
  const token = 'c'.repeat(64);

  it('needs both the origin and the token to pass', () => {
    const good = post({ cookie: `${CSRF_COOKIE_NAME}=${token}`, [CSRF_HEADER_NAME]: token });
    expect(() => assertCsrfProtected(good, APP_ORIGIN)).not.toThrow();

    const noToken = post();
    expect(() => assertCsrfProtected(noToken, APP_ORIGIN)).toThrow(ApiError);

    const badOrigin = new Request(`${APP_ORIGIN}/api/admin/x`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        cookie: `${CSRF_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: token,
      },
    });
    expect(() => assertCsrfProtected(badOrigin, APP_ORIGIN)).toThrow(ApiError);
  });
});

/* ------------------------------------------------------------ validation --- */

const applicantSchema = z
  .object({
    membershipType: z.enum(['FIVE_YEAR', 'LIFETIME']),
    email: z.string().email(),
    postcode: z.string().regex(/^\d{5}$/),
  })
  .strict();

describe('parseWithSchema', () => {
  it('returns the parsed value', () => {
    expect(
      parseWithSchema(applicantSchema, {
        membershipType: 'FIVE_YEAR',
        email: 'member@example.test',
        postcode: '10200',
      }),
    ).toEqual({
      membershipType: 'FIVE_YEAR',
      email: 'member@example.test',
      postcode: '10200',
    });
  });

  it('rejects an unknown field rather than stripping it', () => {
    // `amount` must never be accepted from a client, and silently dropping it
    // would hide that the caller misunderstood the contract.
    const error = (() => {
      try {
        parseWithSchema(applicantSchema, {
          membershipType: 'FIVE_YEAR',
          email: 'member@example.test',
          postcode: '10200',
          amount: 1,
        });
        return null;
      } catch (reason) {
        return reason;
      }
    })();

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('reports the field path of each failure', () => {
    const error = (() => {
      try {
        parseWithSchema(applicantSchema, {
          membershipType: 'MONTHLY',
          email: 'not-an-email',
          postcode: 'abcde',
        });
        return null;
      } catch (reason) {
        return reason as ValidationError;
      }
    })()!;

    expect(error.fields.map((field) => field.field).sort()).toEqual([
      'email',
      'membershipType',
      'postcode',
    ]);
  });

  it('never echoes a submitted value, which would leak personal data', () => {
    const citizenId = '1234567890121';
    const email = 'member@example.test';

    const error = (() => {
      try {
        parseWithSchema(applicantSchema, {
          membershipType: citizenId,
          email,
          postcode: citizenId,
        });
        return null;
      } catch (reason) {
        return reason as ValidationError;
      }
    })()!;

    const serialised = JSON.stringify(validationErrorBody(error, 'req-1'));
    expect(serialised).not.toContain(citizenId);
    expect(serialised).not.toContain(email);
  });

  it('reports one error per field, not one per rule', () => {
    const error = (() => {
      try {
        parseWithSchema(applicantSchema, { membershipType: 'FIVE_YEAR', email: 1, postcode: 1 });
        return null;
      } catch (reason) {
        return reason as ValidationError;
      }
    })()!;

    expect(new Set(error.fields.map((field) => field.field)).size).toBe(error.fields.length);
  });
});

describe('parseJsonBody', () => {
  function jsonRequest(body: string, contentType = 'application/json'): Request {
    return new Request(`${APP_ORIGIN}/api/applications`, {
      method: 'POST',
      headers: { 'content-type': contentType, origin: APP_ORIGIN },
      body,
    });
  }

  it('parses a valid body', async () => {
    const request = jsonRequest(
      JSON.stringify({
        membershipType: 'LIFETIME',
        email: 'member@example.test',
        postcode: '10200',
      }),
    );

    await expect(parseJsonBody(request, applicantSchema)).resolves.toMatchObject({
      membershipType: 'LIFETIME',
    });
  });

  it('rejects a non-JSON content type', async () => {
    const request = jsonRequest('membershipType=FIVE_YEAR', 'application/x-www-form-urlencoded');

    const error = await parseJsonBody(request, applicantSchema).catch((reason: unknown) => reason);
    expect((error as ApiError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a malformed body without quoting it', async () => {
    const malformed = '{"email": "member@example.test", broken';
    const request = jsonRequest(malformed);

    const error = await parseJsonBody(request, applicantSchema).catch((reason: unknown) => reason);
    expect((error as ApiError).code).toBe('BAD_REQUEST');
    expect((error as ApiError).publicMessage).not.toContain('member@example.test');
  });

  it('accepts a content type with a charset parameter', async () => {
    const request = jsonRequest(
      JSON.stringify({
        membershipType: 'FIVE_YEAR',
        email: 'member@example.test',
        postcode: '10200',
      }),
      'application/json; charset=utf-8',
    );

    await expect(parseJsonBody(request, applicantSchema)).resolves.toBeDefined();
  });
});
