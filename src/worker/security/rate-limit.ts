import type { KeyedHasher } from '../lib/crypto';
import { ApiError } from '../lib/http';
import type { Repository } from '../db';

/**
 * Fixed-window rate limiting for the public endpoints that cost money
 * (Issue #1 section 57).
 *
 * Counters live in D1 rather than in an isolate: a Worker runs in many isolates
 * at once, so an in-memory counter limits nothing. At one or two applications a
 * day the write volume is negligible.
 *
 * The stored bucket is a keyed hash of `<scope>:<identifier>`, so a client IP
 * address never lands in the database in clear text.
 *
 * This is the application-level limit. It does not replace a Cloudflare
 * rate-limiting rule at the edge, which is what stops traffic before it reaches
 * the Worker at all - see docs/deployment.md.
 */

const MESSAGE = 'มีคำขอมากเกินไปในช่วงเวลาสั้น ๆ กรุณารอสักครู่แล้วลองอีกครั้ง';

/** Windows kept beyond the current one before cleanup removes them. */
const RETAINED_WINDOWS = 2;

export interface RateLimitPolicy {
  /** Names the counter, e.g. `ocr`. Part of the hashed bucket. */
  scope: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  periodSeconds: number;
}

/** Sensible defaults for a service handling one or two applications a day. */
export const OCR_POLICY: RateLimitPolicy = { scope: 'ocr', limit: 10, periodSeconds: 600 };
export const PAYMENT_POLICY: RateLimitPolicy = { scope: 'payment', limit: 10, periodSeconds: 600 };
export const PHOTO_POLICY: RateLimitPolicy = { scope: 'photo', limit: 20, periodSeconds: 600 };

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests used in the current window, including this one. */
  used: number;
  limit: number;
  /** Unix seconds when the current window ends. */
  resetAt: number;
}

export interface RateLimiter {
  /** Counts one request against `policy` for `identifier`. */
  consume(policy: RateLimitPolicy, identifier: string): Promise<RateLimitDecision>;
}

export interface RateLimiterOptions {
  now?: () => Date;
}

export function createRateLimiter(
  db: Repository,
  hasher: KeyedHasher,
  options: RateLimiterOptions = {},
): RateLimiter {
  const now = options.now ?? (() => new Date());

  return {
    async consume(policy, identifier) {
      const seconds = Math.floor(now().getTime() / 1000);
      const windowStart = Math.floor(seconds / policy.periodSeconds) * policy.periodSeconds;
      const bucket = await hasher.hash(`${policy.scope}:${identifier}`);

      const used = await db.rateLimits.increment({
        bucket,
        windowStart,
        // Anything older than this cannot be consulted again, so it can go.
        expireBefore: windowStart - policy.periodSeconds * RETAINED_WINDOWS,
      });

      return {
        allowed: used <= policy.limit,
        used,
        limit: policy.limit,
        resetAt: windowStart + policy.periodSeconds,
      };
    },
  };
}

/**
 * Identifies the caller for rate-limiting purposes.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client
 * on a request that actually arrived through the edge. When it is absent - only
 * in local development - every caller shares one bucket, which is stricter
 * rather than looser.
 */
export function clientIdentifier(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown-client';
}

/**
 * Consumes one request and throws `ApiError` when the limit is exceeded.
 *
 * `Retry-After` is not included in the thrown error because the response body
 * is built by the central handler; routes that want the header can read
 * `resetAt` from `consume` directly.
 */
export async function assertWithinRateLimit(
  limiter: RateLimiter,
  policy: RateLimitPolicy,
  identifier: string,
): Promise<RateLimitDecision> {
  const decision = await limiter.consume(policy, identifier);
  if (!decision.allowed) {
    throw new ApiError('RATE_LIMITED', MESSAGE);
  }
  return decision;
}
