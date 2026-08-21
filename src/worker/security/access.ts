import { ApiError } from '../lib/http';

/**
 * Cloudflare Access authentication for admin routes (Issue #1 sections 14, 51,
 * 57).
 *
 * Access sits in front of `/admin*` and `/api/admin/*` and will not let an
 * unauthenticated request reach the Worker at all. This module verifies the
 * token anyway, because that edge configuration is one setting in a dashboard:
 * if it is removed, misapplied to the wrong hostname, or bypassed by a route
 * that does not match the application's path, every admin endpoint becomes
 * public. Verifying here means the Worker refuses on its own, and a mistake in
 * the dashboard costs an outage rather than a data breach.
 *
 * The token is a JWT signed with RS256 by the team's own key. Verification
 * checks the signature against the team's published certificates and then the
 * claims: `iss` must be the team, `aud` must be *this* application's tag, and
 * the validity window must contain now. The `aud` check is the one that matters
 * most - without it a token minted for any other application in the same
 * account would be accepted here.
 */

/** Where Access puts the token. The header is the reliable one. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_JWT_COOKIE = 'CF_Authorization';

/** How long a fetched certificate set is reused within an isolate. */
const CERTS_TTL_MS = 60 * 60 * 1000;

/**
 * Tolerance for clock skew between Cloudflare and the Worker.
 *
 * Applied to `nbf` and `iat` only, where skew makes a freshly minted token look
 * future-dated. It is deliberately *not* applied to `exp`: tolerance there would
 * extend the life of an expired token, and Access tokens last hours, so nothing
 * needs it.
 */
const CLOCK_SKEW_SECONDS = 60;

const MESSAGES = {
  /** Deliberately identical for every failure: see `reject`. */
  denied: 'ไม่มีสิทธิ์เข้าถึงส่วนผู้จัดการ',
} as const;

export interface AccessIdentity {
  /** The `email` claim: who performed the action, for the audit trail. */
  email: string;
  /** The `sub` claim, stable per user. */
  subject: string;
}

export interface AccessVerifier {
  /**
   * Returns the caller's identity, or throws `FORBIDDEN`.
   *
   * Every failure produces the same error. A caller learns whether they are
   * allowed in, and nothing about which check refused them - the difference
   * between "wrong audience" and "expired" is exactly what someone probing the
   * endpoint would want to know.
   */
  authenticate(request: Request): Promise<AccessIdentity>;
}

export interface AccessOptions {
  /** Team domain, with or without the `.cloudflareaccess.com` suffix. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Injected by tests so no suite reaches Cloudflare. */
  fetchCerts?: (url: string) => Promise<Response>;
  now?: () => Date;
}

interface JsonWebKey {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
}

interface CachedCerts {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** Per-isolate certificate cache, keyed by the certs URL. */
const certCache = new Map<string, CachedCerts>();

/**
 * Clears the certificate cache.
 *
 * Exported for tests, which serve their own key set per case: a cache that
 * survived between them would make one test pass on another's keys.
 */
export function resetAccessCertCache(): void {
  certCache.clear();
}

function reject(): never {
  throw new ApiError('FORBIDDEN', MESSAGES.denied);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Normalises `team`, `team.cloudflareaccess.com` and a full URL to an origin. */
export function accessIssuer(teamDomain: string): string {
  const trimmed = teamDomain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const host = trimmed.endsWith('.cloudflareaccess.com')
    ? trimmed
    : `${trimmed}.cloudflareaccess.com`;
  return `https://${host}`;
}

async function importKeys(payload: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  if (typeof payload !== 'object' || payload === null) return keys;

  const list = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return keys;

  for (const entry of list as JsonWebKey[]) {
    if (typeof entry.kid !== 'string' || entry.kty !== 'RSA') continue;
    if (typeof entry.n !== 'string' || typeof entry.e !== 'string') continue;

    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: entry.n, e: entry.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(entry.kid, key);
    } catch {
      // A malformed key in the set is skipped rather than failing the whole
      // fetch: the others may still verify this token.
      continue;
    }
  }

  return keys;
}

export function createAccessVerifier(options: AccessOptions): AccessVerifier {
  const issuer = accessIssuer(options.teamDomain);
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const fetchCerts = options.fetchCerts ?? ((url: string) => fetch(url));
  const now = options.now ?? (() => new Date());

  const loadKeys = async (force: boolean): Promise<Map<string, CryptoKey>> => {
    const cached = certCache.get(certsUrl);
    if (!force && cached && now().getTime() - cached.fetchedAt < CERTS_TTL_MS) {
      return cached.keys;
    }

    let response: Response;
    try {
      response = await fetchCerts(certsUrl);
    } catch {
      // An unreachable certificate endpoint must not let a request through.
      return cached?.keys ?? new Map();
    }
    if (!response.ok) return cached?.keys ?? new Map();

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return cached?.keys ?? new Map();
    }

    const keys = await importKeys(payload);
    if (keys.size === 0) return cached?.keys ?? new Map();

    certCache.set(certsUrl, { keys, fetchedAt: now().getTime() });
    return keys;
  };

  /**
   * Resolves the signing key, refetching once for an unknown `kid`.
   *
   * Access rotates keys, so a token signed with a new one arrives before the
   * cache expires. Refetching on an unknown id is what keeps a rotation from
   * locking the manager out for an hour; it is bounded to one extra request
   * because an attacker could otherwise force a fetch per request.
   */
  const keyFor = async (kid: string): Promise<CryptoKey | null> => {
    const cached = await loadKeys(false);
    const key = cached.get(kid);
    if (key) return key;
    return (await loadKeys(true)).get(kid) ?? null;
  };

  return {
    async authenticate(request) {
      const token =
        request.headers.get(ACCESS_JWT_HEADER) ?? readCookieValue(request, ACCESS_JWT_COOKIE);
      if (!token) reject();

      const segments = token.split('.');
      if (segments.length !== 3) reject();

      const header = decodeJson(segments[0]!);
      const claims = decodeJson(segments[1]!);
      if (!header || !claims) reject();

      // Only RS256. Accepting `alg` from the token would allow `none`, and
      // accepting an HMAC algorithm would let the public key be used as a
      // shared secret.
      if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') reject();

      const key = await keyFor(header['kid']);
      if (!key) reject();

      let valid = false;
      try {
        valid = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          key,
          base64UrlToBytes(segments[2]!),
          new TextEncoder().encode(`${segments[0]!}.${segments[1]!}`),
        );
      } catch {
        reject();
      }
      if (!valid) reject();

      if (claims['iss'] !== issuer) reject();

      // `aud` is an array in Access tokens. Without this check a token minted
      // for any other application in the same account would be accepted.
      const audience = claims['aud'];
      const audiences = Array.isArray(audience) ? audience : [audience];
      if (!audiences.includes(options.audience)) reject();

      const seconds = Math.floor(now().getTime() / 1000);
      const expiry = claims['exp'];
      if (typeof expiry !== 'number' || seconds >= expiry) reject();

      const notBefore = claims['nbf'];
      if (typeof notBefore === 'number' && seconds + CLOCK_SKEW_SECONDS < notBefore) reject();

      const issuedAt = claims['iat'];
      if (typeof issuedAt === 'number' && seconds + CLOCK_SKEW_SECONDS < issuedAt) reject();

      const subject = claims['sub'];
      if (typeof subject !== 'string' || subject.length === 0) reject();

      const email = claims['email'];
      return {
        subject,
        // Service tokens carry no email; the subject still identifies the
        // caller, so the action is attributable either way.
        email: typeof email === 'string' && email.length > 0 ? email : subject,
      };
    },
  };
}

/** Local copy so this module does not depend on the CSRF one. */
function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
