import { Hono } from 'hono';
import type { AppContext } from '../context';

/**
 * Liveness probe and public client configuration.
 *
 * Neither returns personal data. `/api/config` exists so the browser can be told
 * its Turnstile **site** key at runtime instead of having it baked into the
 * bundle at build time: the value is public either way, but reading it from the
 * Worker means rotating the widget is a secret change rather than a rebuild and
 * redeploy, and CI never needs it.
 */
/** Used when `ASSOCIATION_NAME` is unset, so the footer always has a name. */
const DEFAULT_ASSOCIATION_NAME = 'สมาคมนักวิทยุอาสาสมัคร';

/** A configured string, or null when it is absent or blank. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const healthRoutes = new Hono<AppContext>()
  .get('/health', (c) => {
    return c.json({
      status: 'ok' as const,
      environment: c.var.config.ENVIRONMENT,
      providerMode: c.var.config.PROVIDER_MODE,
      requestId: c.var.requestId,
    });
  })

  .get('/config', (c) => {
    const siteKey = c.env['TURNSTILE_SITE_KEY'];

    return c.json({
      // Null when unset - development, and CI. The client then renders no
      // widget and sends no token, which is safe because the server decides:
      // `mock` accepts any token and `live` requires the secret.
      turnstileSiteKey: typeof siteKey === 'string' && siteKey.length > 0 ? siteKey : null,
      environment: c.var.config.ENVIRONMENT,
      // The association's own public contact details, for the footer. Served
      // from configuration rather than compiled into the client so a phone
      // number can be changed in the dashboard without a code review. Defaults
      // live in `wrangler.jsonc`, which is why they are `vars` and not secrets:
      // there is nothing here to keep, and a reviewable default beats an
      // invisible one.
      association: {
        name: text(c.env['ASSOCIATION_NAME']) ?? DEFAULT_ASSOCIATION_NAME,
        postalAddress: text(c.env['ASSOCIATION_POSTAL_ADDRESS']),
        email: text(c.env['ASSOCIATION_EMAIL']),
        lineId: text(c.env['ASSOCIATION_LINE_ID']),
        phone: text(c.env['ASSOCIATION_PHONE']),
      },
    });
  });
