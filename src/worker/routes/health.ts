import { Hono } from 'hono';
import type { AppContext } from '../context';

/**
 * Liveness/readiness probe used by smoke tests after a deployment.
 * Returns no personal data and no configuration values.
 */
export const healthRoutes = new Hono<AppContext>().get('/health', (c) => {
  return c.json({
    status: 'ok' as const,
    environment: c.var.config.ENVIRONMENT,
    providerMode: c.var.config.PROVIDER_MODE,
    requestId: c.var.requestId,
  });
});
