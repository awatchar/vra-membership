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
    });
  });
