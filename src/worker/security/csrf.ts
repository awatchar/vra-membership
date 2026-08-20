import { timingSafeEqual } from '../lib/crypto';
import { ApiError } from '../lib/http';

/**
 * CSRF protection for admin actions (Issue #1 section 57).
 *
 * Cloudflare Access authenticates the manager with a cookie, and a cookie is
 * sent on cross-site requests too. Without this, any page the manager visits
 * while signed in could POST to `/api/admin/applications/:id/nbtc-complete` and
 * the request would carry a valid Access cookie.
 *
 * Two independent checks, because each covers a case the other misses:
 *
 * 1. **Origin check.** Browsers set `Origin` on state-changing requests and a
 *    page cannot forge it. This alone stops the classic form-post attack.
 * 2. **Double-submit token.** A random value is issued in a cookie and must be
 *    echoed in a header. A cross-site page can cause the cookie to be sent but
 *    cannot read it, so it cannot produce the header. This covers the case
 *    where `Origin` is missing - some clients and older browsers - without
 *    having to decide whether a missing header means "safe" or "attack".
 *
 * The comparison is constant time so a token cannot be guessed byte by byte.
 */

export const CSRF_COOKIE_NAME = 'vra_csrf';
export const CSRF_HEADER_NAME = 'x-vra-csrf';

const TOKEN_BYTE_LENGTH = 32;

const MESSAGES = {
  origin: 'คำขอนี้ถูกปฏิเสธเพราะไม่ได้มาจากหน้าเว็บของระบบ',
  token: 'คำขอนี้หมดอายุหรือไม่ถูกต้อง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง',
} as const;

/** Methods that can change state and therefore need protection. */
const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isProtectedMethod(method: string): boolean {
  return PROTECTED_METHODS.has(method.toUpperCase());
}

export function generateCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `Set-Cookie` value for the token.
 *
 * Deliberately readable by scripts: the browser has to echo it into a header,
 * which is the whole mechanism. It is not a credential - it authorises nothing
 * on its own - so `HttpOnly` would break the pattern without adding safety.
 * `SameSite=Strict` means it is not even sent on a cross-site request.
 */
export function csrfCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 8}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(request: Request, name: string): string | null {
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

/**
 * Rejects a state-changing request that did not come from the application.
 *
 * A missing `Origin` is treated as a failure rather than waved through: an
 * admin action is always triggered from the app's own pages, so there is no
 * legitimate caller without one.
 */
export function assertSameOrigin(request: Request, appBaseUrl: string): void {
  if (!isProtectedMethod(request.method)) return;

  const origin = request.headers.get('origin');
  if (!origin) {
    throw new ApiError('FORBIDDEN', MESSAGES.origin);
  }

  let expected: string;
  let actual: string;
  try {
    expected = new URL(appBaseUrl).origin;
    actual = new URL(origin).origin;
  } catch {
    throw new ApiError('FORBIDDEN', MESSAGES.origin);
  }

  if (expected !== actual) {
    throw new ApiError('FORBIDDEN', MESSAGES.origin);
  }
}

/** Rejects a state-changing request whose header and cookie tokens disagree. */
export function assertCsrfToken(request: Request): void {
  if (!isProtectedMethod(request.method)) return;

  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken = request.headers.get(CSRF_HEADER_NAME);

  if (!cookieToken || !headerToken) {
    throw new ApiError('FORBIDDEN', MESSAGES.token);
  }
  if (!timingSafeEqual(cookieToken, headerToken)) {
    throw new ApiError('FORBIDDEN', MESSAGES.token);
  }
}

/** Both checks, in the order that fails fastest. */
export function assertCsrfProtected(request: Request, appBaseUrl: string): void {
  assertSameOrigin(request, appBaseUrl);
  assertCsrfToken(request);
}
