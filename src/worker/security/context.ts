import type { Repository } from '../db';
import { requireSecret } from '../env';
import type { WorkerEnv } from '../env';
import { createKeyedHasher } from '../lib/crypto';
import type { KeyedHasher } from '../lib/crypto';
import { createRateLimiter } from './rate-limit';
import type { RateLimiter } from './rate-limit';
import { createMockTurnstileVerifier, createTurnstileVerifier } from './turnstile';
import type { TurnstileVerifier } from './turnstile';

/**
 * Assembles the per-request security services.
 *
 * Turnstile follows the same rule as the business providers: `mock` mode gets a
 * deterministic stand-in so no test reaches Cloudflare, and `live` mode requires
 * the secret rather than falling back to a mock.
 */

const RATE_LIMIT_HASH_INFO = 'vra:rate-limit:v1';

/**
 * Derived HMAC keys are cached per isolate, keyed by the secret they came from.
 *
 * HKDF on every request would be wasteful, and the key material is already in
 * this isolate's memory as an environment variable, so keeping the derived key
 * beside it exposes nothing new.
 */
let cachedHasher: { keyMaterial: string; hasher: KeyedHasher } | null = null;

async function rateLimitHasher(env: WorkerEnv): Promise<KeyedHasher> {
  const keyMaterial = resolveHashKey(env);
  if (cachedHasher?.keyMaterial === keyMaterial) {
    return cachedHasher.hasher;
  }

  const hasher = await createKeyedHasher(keyMaterial, RATE_LIMIT_HASH_INFO);
  cachedHasher = { keyMaterial, hasher };
  return hasher;
}

/** Random key material for development, generated once per isolate. */
let developmentHashKey: string | null = null;

/**
 * Key material for hashing rate-limit identifiers.
 *
 * Production reuses `PII_ENCRYPTION_KEY` through a distinct HKDF label. In
 * development the secret is usually absent, and rather than fall back to an
 * unkeyed hash - which would let anyone holding the database brute-force the
 * IPv4 space back to plaintext addresses - a random per-isolate key is used.
 * Counters then reset when the isolate does, which is acceptable locally and
 * cannot happen in production because the secret is required there.
 */
function resolveHashKey(env: WorkerEnv): string {
  if (env.PROVIDER_MODE === 'live') {
    return requireSecret(env, 'PII_ENCRYPTION_KEY');
  }

  const configured = env['PII_ENCRYPTION_KEY'];
  if (typeof configured === 'string' && configured.length >= 32) {
    return configured;
  }

  developmentHashKey ??= `development-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
  return developmentHashKey;
}

export interface SecurityServices {
  turnstile: TurnstileVerifier;
  rateLimiter: RateLimiter;
}

export async function createSecurityServices(
  env: WorkerEnv,
  db: Repository,
): Promise<SecurityServices> {
  const turnstile =
    env.PROVIDER_MODE === 'mock'
      ? createMockTurnstileVerifier()
      : createTurnstileVerifier(requireSecret(env, 'TURNSTILE_SECRET_KEY'));

  return {
    turnstile,
    rateLimiter: createRateLimiter(db, await rateLimitHasher(env)),
  };
}

/** Test seam: drops the cached derived key so a new secret takes effect. */
export function resetSecurityCaches(): void {
  cachedHasher = null;
  developmentHashKey = null;
}
