/**
 * Where in the portal we are, derived from the URL.
 *
 * A handful of paths and no router dependency. The three action paths are the
 * ones the manager notification email links to (Issue #1 sections 32 and 37), so
 * they have to be real URLs that survive being opened from a mail client - which
 * also means the page they land on must not do anything by itself.
 */

export type AdminRoute =
  | { kind: 'queue' }
  | { kind: 'detail'; applicationId: string }
  | { kind: 'acknowledge'; applicationId: string }
  | { kind: 'nbtc-complete'; applicationId: string }
  | { kind: 'unknown'; path: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAdminRoute(pathname: string): AdminRoute {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments[0] !== 'admin') return { kind: 'unknown', path: pathname };

  if (segments.length === 1) return { kind: 'queue' };
  if (segments[1] !== 'applications') return { kind: 'unknown', path: pathname };

  const applicationId = segments[2];
  // An id that is not a UUID is not a typo worth guessing at - it would produce
  // a request the API will refuse anyway.
  if (!applicationId || !UUID.test(applicationId)) return { kind: 'unknown', path: pathname };

  if (segments.length === 3) return { kind: 'detail', applicationId };
  if (segments[3] === 'acknowledge' && segments.length === 4) {
    return { kind: 'acknowledge', applicationId };
  }
  if (segments[3] === 'nbtc-complete' && segments.length === 4) {
    return { kind: 'nbtc-complete', applicationId };
  }

  return { kind: 'unknown', path: pathname };
}

export function queuePath(): string {
  return '/admin';
}

export function detailPath(applicationId: string): string {
  return `/admin/applications/${applicationId}`;
}
