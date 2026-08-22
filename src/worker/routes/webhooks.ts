import { Hono } from 'hono';
import type { AppContext } from '../context';
import { requireSecret } from '../env';
import { readTextWithLimit } from '../lib/files';
import { ApiError } from '../lib/http';
import { verifySvixSignature } from '../providers/resend';
import { createAuditLog } from '../services/audit';
import { createEmailService } from '../services/email';
import { createEmailEventService } from '../services/email-events';
import { createNumberingService } from '../services/numbering';
import { createReceiptService } from '../services/receipt';
import { createStateMachine } from '../services/state-machine';

/**
 * Provider webhooks.
 *
 * `POST /api/webhooks/resend` is a public endpoint that can change an
 * application's status, so the signature is the only thing standing between the
 * internet and that state machine. It is verified with the real Svix
 * implementation in every environment, not through the provider container:
 * `PROVIDER_MODE=mock` answers "valid" to everything, and a mock in that
 * position would turn this into an unauthenticated status-change endpoint.
 *
 * Everything after the signature check answers 2xx. Resend retries a non-2xx
 * response for hours (5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10
 * hours), so refusing an event we simply have no use for would buy a long
 * stream of redeliveries and no benefit. An unknown event type, an unmatched
 * message id and a malformed body are therefore all acknowledged.
 *
 * Turnstile does not apply: the caller is a server, not a person. Neither does
 * CSRF, which protects a browser session that is not involved here. Volumetric
 * abuse is a job for the edge rate-limiting rule in `docs/owner-actions.md`,
 * because dropping real delivery events would lose them permanently.
 */

/** Generous for an event envelope, small enough that the read is bounded. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

const MESSAGES = {
  unauthorized: 'ไม่สามารถยืนยันแหล่งที่มาของคำขอได้',
} as const;

export const webhookRoutes = new Hono<AppContext>().post('/webhooks/resend', async (c) => {
  const secret = requireSecret(c.env, 'RESEND_WEBHOOK_SECRET');

  // The raw body, byte for byte: the signature covers exactly these bytes, and
  // parsing then re-serialising changes the whitespace and invalidates it.
  const payload = await readTextWithLimit(c.req.raw, MAX_WEBHOOK_BYTES);

  const signed = await verifySvixSignature({ payload, headers: c.req.raw.headers, secret });
  if (!signed) {
    // No detail about which part failed: that would help someone iterate
    // towards a valid signature.
    c.var.logger.warn({ event: 'webhook.signature_rejected', provider: 'resend' });
    throw new ApiError('UNAUTHORIZED', MESSAGES.unauthorized);
  }

  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    body = null;
  }

  const db = c.var.db;
  const audit = createAuditLog(db);
  const numbering = createNumberingService(db);
  const receipts = createReceiptService(db, numbering, audit);
  const emails = createEmailService(db, c.var.providers.email, receipts, audit, {
    managerEmail: requireSecret(c.env, 'MANAGER_EMAIL'),
    ccEmail: c.var.config.EMAIL_CC,
    appBaseUrl: c.var.config.APP_BASE_URL,
  });

  const outcome = await createEmailEventService(db, createStateMachine(db), emails, audit).handle(
    body,
  );

  // The event type is an enum from the provider and safe to log; nothing else
  // from the payload is, so nothing else is logged.
  c.var.logger.info({
    event: 'webhook.resend',
    provider: 'resend',
    reason: outcome.kind,
    ...(outcome.kind === 'UNSUPPORTED' || outcome.kind === 'UNPARSEABLE'
      ? {}
      : { emailType: outcome.eventType }),
  });

  return c.json({ received: true });
});
