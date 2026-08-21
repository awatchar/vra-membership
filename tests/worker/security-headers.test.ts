import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, TURNSTILE_ORIGIN } from '../../src/worker/security/headers';

/**
 * Security headers on real responses.
 *
 * Asserted on what the Worker actually returns rather than on the constants,
 * because the whole point of the change is that the headers reach every kind of
 * response - an API answer, an error, and the document that loads the scripts.
 * A test that read the module and agreed with itself would pass with the
 * middleware unwired.
 */

const ORIGIN = 'https://membership.example.test';

async function get(path: string): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`));
}

/** Splits the policy into directives, so each can be checked on its own. */
function directives(policy: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const entry of policy.split(';')) {
    const parts = entry.trim().split(/\s+/).filter(Boolean);
    const name = parts.shift();
    if (name) parsed.set(name, parts);
  }
  return parsed;
}

describe('every response', () => {
  const paths = ['/api/health', '/api/config', '/api/does-not-exist', '/', '/admin'];

  for (const path of paths) {
    it(`carries the headers on ${path}`, async () => {
      const response = await get(path);

      expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('permissions-policy')).toContain('camera=()');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    });
  }

  it('sends HSTS over HTTPS', async () => {
    const response = await get('/api/health');
    const hsts = response.headers.get('strict-transport-security') ?? '';

    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('does not send HSTS over plain HTTP', async () => {
    // Only reachable in local development, where it would pin `localhost` to
    // HTTPS in the developer's browser for two years.
    const response = await exports.default.fetch(new Request('http://localhost:8787/api/health'));

    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('advertises nothing about what runs it', async () => {
    const response = await get('/api/health');

    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});

describe('the content security policy', () => {
  const parsed = directives(CONTENT_SECURITY_POLICY);

  it('denies by default', () => {
    // Anything nobody thought about is denied rather than inheriting a
    // permissive default.
    expect(parsed.get('default-src')).toEqual(["'none'"]);
  });

  it('allows no inline or evaluated script', () => {
    const scriptSrc = parsed.get('script-src') ?? [];

    // This is the directive the whole file exists for: injected script on our
    // own origin can read the CSRF cookie and set the header itself, which is
    // the one way past the protection in #8.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'self'");
  });

  it('allows no inline style either', () => {
    // React applies `style={{...}}` through the CSSOM, which CSP does not
    // govern, so nothing in the interface needs this allowance.
    const styleSrc = parsed.get('style-src') ?? [];

    expect(styleSrc).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it('lets Turnstile load its script and its challenge frame', () => {
    // Cloudflare documents exactly these two, and no inline allowance.
    expect(parsed.get('script-src')).toContain(TURNSTILE_ORIGIN);
    expect(parsed.get('frame-src')).toContain(TURNSTILE_ORIGIN);
    expect(parsed.get('connect-src')).toContain(TURNSTILE_ORIGIN);
  });

  it('allows the blob previews the wizard makes without uploading them', () => {
    // The card, the face crop and the slip are shown from blob URLs precisely
    // because they never leave the device.
    expect(parsed.get('img-src')).toContain('blob:');
    expect(parsed.get('img-src')).toContain("'self'");
  });

  it('refuses to be framed', () => {
    // The NBTC confirmation page is one button that tells a member their
    // registration is complete.
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('blocks plugins, base rewriting and foreign form targets', () => {
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'self'"]);
  });

  it('does not allow a script host beyond our own and Turnstile', () => {
    const scriptSrc = parsed.get('script-src') ?? [];

    expect(scriptSrc).toHaveLength(2);
  });
});

describe('caching', () => {
  it('marks an API response no-store', async () => {
    const response = await get('/api/health');

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('marks an unknown API path no-store as well', async () => {
    // The backstop: a route added later that forgets to set it is private by
    // default rather than cacheable by default.
    const response = await get('/api/does-not-exist');

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('routing', () => {
  it('answers an unknown API path with JSON, not the client application', async () => {
    const response = await get('/api/nope');
    const body = await response.json<{ error: { code: string } }>();

    // An HTML body with a 200 would turn a routing mistake into a silent one.
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('serves the client application for a deep admin link', async () => {
    // This is the shape of URL the manager notification email contains, so the
    // single-page fallback has to answer it.
    const response = await get('/admin/applications/11111111-2222-4333-8444-555555555555');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('still serves the API through the Worker', async () => {
    const response = await get('/api/health');
    const body = await response.json<{ status: string }>();

    expect(body.status).toBe('ok');
  });
});
