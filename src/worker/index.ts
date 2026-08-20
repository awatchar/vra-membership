import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from './context';
import { createRepository } from './db';
import { ConfigurationError, readConfig } from './env';
import { ApiError, errorBody, statusForErrorCode } from './lib/http';
import { createLogger } from './lib/logger';
import { ProviderNotConfiguredError, createProviders } from './providers';
import { ValidationError, createSecurityServices, validationErrorBody } from './security';
import { healthRoutes } from './routes/health';
import { applicationRoutes } from './routes/applications';
import { memberPhotoRoutes } from './routes/member-photo';
import { OcrFailedError, ocrRoutes } from './routes/ocr';

const GENERIC_ERROR_MESSAGE = 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';
const PROVIDER_ERROR_MESSAGE = 'ไม่สามารถเชื่อมต่อบริการภายนอกได้ กรุณาลองใหม่อีกครั้ง';

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

/** API 404s must be JSON so the SPA fallback never masks a routing mistake. */
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json(errorBody('NOT_FOUND', 'ไม่พบปลายทางที่ร้องขอ', c.var.requestId), 404);
  }
  return c.text('Not Found', 404);
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

  if (error instanceof ProviderNotConfiguredError) {
    logger.error({ event: 'provider.unavailable', provider: error.provider });
    return c.json(errorBody('PROVIDER_UNAVAILABLE', PROVIDER_ERROR_MESSAGE, requestId), 503);
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
