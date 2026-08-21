/**
 * Response headers applied to everything the Worker serves.
 *
 * The one that matters is the Content-Security-Policy, and the reason is
 * specific rather than general. #8 protects the manager's actions with an origin
 * check and a double-submit CSRF token, and both are defeated by script running
 * on our own origin: injected script can read the cookie and set the header
 * itself. So XSS is the single remaining path to the manager's actions and to the
 * personal data on their screen, and a policy with no `unsafe-inline` and no
 * `unsafe-eval` in `script-src` is what closes it.
 *
 * **React's inline styles are not affected.** `style={{...}}` is applied through
 * the CSSOM (`node.style.width = …`), and CSP governs style *attributes* and
 * `<style>` elements parsed from markup, not programmatic style changes. So
 * `style-src 'self'` holds with no exception for the progress bar or the crop
 * frame - which is why neither needed rewriting for this.
 *
 * The `camera` permission is denied outright, even though the wizard takes
 * photographs. It uses `<input type="file" capture>`, which hands off to the
 * operating system's own camera app and needs no web permission - unlike
 * `getUserMedia`, which this deliberately does not use.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Two years, and `preload`. Long because the alternative is a window in which a
 * first visit over plain HTTP can be intercepted, and this site handles an ID
 * card. `includeSubDomains` because the Access-protected admin host is a
 * subdomain of the same zone.
 */
const HSTS = 'max-age=63072000; includeSubDomains; preload';

/**
 * The policy, as directives.
 *
 * Each entry says why it is as wide as it is; anything not listed falls to
 * `default-src 'none'`, so a resource type nobody thought about is denied rather
 * than inherited from a permissive default.
 */
const CSP_DIRECTIVES: readonly string[] = [
  // Deny by default. Every allowance below is deliberate.
  "default-src 'none'",

  // Our own bundle, plus the Turnstile challenge script. No `unsafe-inline` and
  // no `unsafe-eval`: this is the directive the whole file exists for.
  `script-src 'self' ${TURNSTILE_ORIGIN}`,

  // The built stylesheet is a file, so `'self'` is enough. React's inline styles
  // go through the CSSOM and are not covered by this.
  "style-src 'self'",

  // `blob:` for the previews the wizard makes of a card, a face crop and a slip -
  // those never leave the device, so they can only be shown from a blob URL.
  // `data:` for the favicon. `'self'` covers the member photo, which is streamed
  // by the Worker rather than served from R2 directly.
  "img-src 'self' blob: data:",

  // Fonts are inside the bundle; nothing is fetched from a font service.
  "font-src 'self'",

  // The API, and Turnstile's own verification calls.
  `connect-src 'self' ${TURNSTILE_ORIGIN}`,

  // The Turnstile challenge renders in an iframe.
  `frame-src ${TURNSTILE_ORIGIN}`,

  // Nothing may frame this site. The NBTC confirmation page is one button that
  // tells a member their registration is complete, and clickjacking it is
  // exactly the attack `X-Frame-Options` was invented for.
  "frame-ancestors 'none'",

  // No `<base>` rewriting, and no plugins.
  "base-uri 'none'",
  "object-src 'none'",

  // Forms post to the API only.
  "form-action 'self'",

  // Any mixed-content subresource is upgraded rather than silently blocked.
  'upgrade-insecure-requests',
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join('; ');

/**
 * Features denied outright.
 *
 * `camera` included: the wizard photographs a card and a face through
 * `<input type="file" capture>`, which is the operating system's camera app and
 * needs no web permission. Granting the feature would allow `getUserMedia`,
 * which nothing here uses.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/** Headers every response carries, whatever it is. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  // `X-Frame-Options` as well as `frame-ancestors`, for the browsers that
  // implement one and not the other.
  'X-Frame-Options': 'DENY',
  // Sends the origin but not the path cross-site. Application ids and reference
  // numbers are in our paths, and a `Referer` carrying one to a third party
  // would leak which application a person is looking at.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Removes any hint about what runs this.
  'X-Powered-By': '',
};

/**
 * Applies the headers to a response, returning a new one.
 *
 * `Cache-Control` is set to `no-store` unless the response already chose its own
 * value. Every API route that returns personal data sets it explicitly, and this
 * is the backstop: a route added later that forgets is private by default rather
 * than cacheable by default. Static assets opt out by carrying their own
 * `Cache-Control`, which the asset binding sets.
 *
 * HSTS is only sent over HTTPS. Sending it on a plain-HTTP response is ignored
 * by browsers and would only appear in local development, where it would then
 * pin `localhost` to HTTPS in the developer's browser for two years.
 */
export function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    if (value === '') headers.delete(name);
    else headers.set(name, value);
  }

  if (new URL(request.url).protocol === 'https:') {
    headers.set('Strict-Transport-Security', HSTS);
  }

  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }

  // A new `Response` rather than mutating: a response from the asset binding has
  // immutable headers, and assigning to them silently does nothing.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
