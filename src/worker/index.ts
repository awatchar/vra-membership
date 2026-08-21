import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from './context';
import { createRepository } from './db';
import { ConfigurationError, readConfig } from './env';
import { ApiError, errorBody, statusForErrorCode } from './lib/http';
import { createLogger } from './lib/logger';
import { createProviders } from './providers';
import { ValidationError, createSecurityServices, validationErrorBody } from './security';
import { withSecurityHeaders } from './security/headers';
import { PaymentRejectedError } from './services/payment';
import { healthRoutes } from './routes/health';
import { adminRoutes } from './routes/admin';
import { applicationRoutes } from './routes/applications';
import { memberPhotoRoutes } from './routes/member-photo';
import { OcrFailedError, ocrRoutes } from './routes/ocr';
import { paymentRoutes } from './routes/payment';
import { webhookRoutes } from './routes/webhooks';

const GENERIC_ERROR_MESSAGE = 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';

/**
 * `CF-Ray` lets a request be correlated with Cloudflare's own logs, but it
 * arrives as a header, so it is only trusted when it looks like a ray id.
 * Anything else gets a locally generated id instead of being echoed into logs.
 */
const RAY_ID_PATTERN = /^[a-zA-Z0-9-]{1,40}$/;

function resolveRequestId(header: string | undefined): string {
  return header && RAY_ID_PATTERN.test(header) ? header : crypto.randomUUID();
}

const app = new Hono<AppContext>();

/**
 * Security headers on every response.
 *
 * Outermost, so it covers an error response, an asset and an API answer alike -
 * a policy that only applies to the paths someone remembered is not a policy.
 * The Worker runs before the asset binding for every request (`run_worker_first`
 * in `wrangler.jsonc`) precisely so this can wrap the HTML and the bundle too;
 * without that, the document that loads the scripts would be the one response
 * with no Content-Security-Policy on it.
 */
app.use('*', async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res, c.req.raw);
});

/**
 * Per-request setup: correlation id, validated config, allowlisted logger and
 * provider container. Nothing here reads the request body.
 */
app.use('*', async (c, next) => {
  const requestId = resolveRequestId(c.req.header('cf-ray'));
  const config = readConfig(c.env);

  c.set('requestId', requestId);
  c.set('config', config);
  c.set(
    'logger',
    createLogger({ level: config.ENVIRONMENT === 'production' ? 'info' : 'debug' }).with({
      requestId,
      environment: config.ENVIRONMENT,
    }),
  );
  c.set('providers', createProviders(c.env));
  const db = createRepository(c.env.DB);
  c.set('db', db);
  c.set('security', await createSecurityServices(c.env, db));

  const startedAt = Date.now();
  await next();
  c.var.logger.info({
    event: 'request.completed',
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.route('/api', healthRoutes);
app.route('/api', ocrRoutes);
app.route('/api', memberPhotoRoutes);
app.route('/api', applicationRoutes);
app.route('/api', paymentRoutes);
app.route('/api', webhookRoutes);
app.route('/api', adminRoutes);

/**
 * Everything that is not an API route is the client application.
 *
 * The asset binding does the serving, including the single-page fallback, so a
 * deep link like `/admin/applications/<id>` - which is what the manager's email
 * contains - returns the document rather than a 404.
 */
app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;

  // An unknown API path must not fall through to the SPA: an HTML body with a
  // 200 in place of a JSON 404 turns a routing mistake into a silent one.
  if (path.startsWith('/api/')) {
    return c.json(errorBody('NOT_FOUND', 'ไม่พบปลายทางที่ร้องขอ', c.var.requestId), 404);
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

/** Reached only if the catch-all above is ever removed. */
app.notFound((c) => {
  return c.json(errorBody('NOT_FOUND', 'ไม่พบปลายทางที่ร้องขอ', c.var.requestId), 404);
});

app.onError((error, c) => {
  const requestId = c.var.requestId as string | undefined;
  const logger = c.var.logger ?? createLogger();

  if (error instanceof ValidationError) {
    // Field paths are safe to return; the submitted values are not, and
    // `validationErrorBody` carries only the paths.
    logger.warn({ event: 'request.failed', errorCode: error.code, count: error.fields.length });
    return c.json(validationErrorBody(error, requestId), 422);
  }

  if (error instanceof PaymentRejectedError) {
    logger.warn({ event: 'payment.rejected', errorCode: error.code, reason: error.reason });
    return c.json(
      {
        error: {
          code: error.code,
          reason: error.reason,
          message: error.publicMessage,
          ...(requestId ? { requestId } : {}),
        },
      },
      statusForErrorCode(error.code) as ContentfulStatusCode,
    );
  }

  if (error instanceof OcrFailedError) {
    // The reason lets the client choose between offering a retake and offering
    // manual entry. It is an enum value, never provider text.
    return c.json(
      {
        error: {
          code: error.code,
          reason: error.reason,
          message: error.publicMessage,
          ...(requestId ? { requestId } : {}),
        },
      },
      422,
    );
  }

  if (error instanceof ApiError) {
    logger.warn({ event: 'request.failed', errorCode: error.code });
    return c.json(
      errorBody(error.code, error.publicMessage, requestId),
      statusForErrorCode(error.code) as ContentfulStatusCode,
    );
  }

  if (error instanceof ConfigurationError) {
    // The message carries variable names only, never their values.
    logger.error({ event: 'configuration.invalid', reason: error.message });
    return c.json(errorBody('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE, requestId), 500);
  }

  // Unknown failure: log a code, not the error object, to avoid leaking payloads.
  logger.error({ event: 'request.unhandled_error', errorCode: 'UNHANDLED' });
  return c.json(errorBody('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE, requestId), 500);
});

export default app;
