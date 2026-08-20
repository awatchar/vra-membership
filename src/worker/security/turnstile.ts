import { ApiError } from '../lib/http';

/**
 * Cloudflare Turnstile verification (Issue #1 section 57).
 *
 * Every endpoint that costs money - OCR, slip verification, photo upload - is
 * gated on a token that only a real browser session can produce, and the token
 * is verified **before** the provider is called. Verifying afterwards would
 * still let an attacker run up the bill.
 *
 * The site key is public and lives in the client bundle. The secret key never
 * leaves the Worker.
 *
 * Verification is behind an interface for the same reason the providers are:
 * automated tests must not call Cloudflare, and a test needs to be able to
 * simulate a rejected token.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

const MESSAGES = {
  missing: 'ไม่พบการยืนยันว่าคุณไม่ใช่บอท กรุณาลองใหม่อีกครั้ง',
  failed: 'การยืนยันว่าคุณไม่ใช่บอทไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  unavailable: 'ไม่สามารถยืนยันคำขอได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
} as const;

export type TurnstileOutcome =
  | { ok: true }
  /** The token was absent, malformed, expired, replayed or for another site. */
  | { ok: false; reason: 'REJECTED' }
  /** Cloudflare could not be reached or replied unusably. */
  | { ok: false; reason: 'UNAVAILABLE' };

export interface TurnstileVerifier {
  readonly name: string;
  verify(input: { token: string; remoteIp?: string | null }): Promise<TurnstileOutcome>;
}

/** Header the client uses to carry the token on non-form requests. */
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';

export function createTurnstileVerifier(secretKey: string): TurnstileVerifier {
  return {
    name: 'turnstile',
    async verify({ token, remoteIp }) {
      if (token.length === 0) {
        return { ok: false, reason: 'REJECTED' };
      }

      const body = new FormData();
      body.append('secret', secretKey);
      body.append('response', token);
      if (remoteIp) body.append('remoteip', remoteIp);
      // Cloudflare deduplicates by idempotency key, which is what makes a
      // replayed token detectable on their side.
      body.append('idempotency_key', crypto.randomUUID());

      let response: Response;
      try {
        response = await fetch(SITEVERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' };
      }

      if (!response.ok) {
        return { ok: false, reason: 'UNAVAILABLE' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' };
      }

      // Only the boolean is read. Cloudflare's error codes and the hostname it
      // echoes back are provider detail that must not reach a log or a client.
      const success =
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { success?: unknown }).success;

      return success === true ? { ok: true } : { ok: false, reason: 'REJECTED' };
    },
  };
}

export interface MockTurnstileOptions {
  outcome?: TurnstileOutcome;
}

/** Accepts any non-empty token unless configured otherwise. */
export function createMockTurnstileVerifier(options: MockTurnstileOptions = {}): TurnstileVerifier {
  return {
    name: 'mock-turnstile',
    async verify({ token }) {
      if (options.outcome) return options.outcome;
      return token.length > 0 ? { ok: true } : { ok: false, reason: 'REJECTED' };
    },
  };
}

/**
 * Verifies the token on a request, throwing `ApiError` when it does not pass.
 *
 * An unreachable Cloudflare is reported as `PROVIDER_UNAVAILABLE`, not as a
 * rejection: failing closed is correct, but telling the applicant they look
 * like a bot when the real problem is on our side is not.
 */
export async function assertHumanRequest(
  verifier: TurnstileVerifier,
  request: Request,
): Promise<void> {
  const token = request.headers.get(TURNSTILE_TOKEN_HEADER) ?? '';
  if (token.length === 0) {
    throw new ApiError('FORBIDDEN', MESSAGES.missing);
  }

  const outcome = await verifier.verify({
    token,
    remoteIp: request.headers.get('cf-connecting-ip'),
  });

  if (outcome.ok) return;
  if (outcome.reason === 'UNAVAILABLE') {
    throw new ApiError('PROVIDER_UNAVAILABLE', MESSAGES.unavailable);
  }
  throw new ApiError('FORBIDDEN', MESSAGES.failed);
}
