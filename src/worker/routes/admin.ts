import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireSecret } from '../env';
import { APPLICATION_STATUSES } from '../db';
import type { ApplicationStatus } from '../db';
import { createCitizenIdProtection } from '../lib/crypto';
import { ApiError } from '../lib/http';
import { createAccessVerifier } from '../security/access';
import type { AccessIdentity } from '../security/access';
import {
  CSRF_HEADER_NAME,
  assertCsrfProtected,
  csrfCookie,
  generateCsrfToken,
} from '../security/csrf';
import { createAdminView } from '../services/admin-view';
import { createAuditLog } from '../services/audit';
import { createEmailEventService } from '../services/email-events';
import { createEmailService } from '../services/email';
import { createMemberPhotoService } from '../services/member-photo';
import { createNbtcCompletion } from '../services/nbtc-completion';
import { createNumberingService } from '../services/numbering';
import { createReceiptService } from '../services/receipt';
import { createStateMachine } from '../services/state-machine';
import { buildApplicationWorkflow } from '../services/workflow-factory';

/**
 * Manager endpoints (Issue #1 sections 51-53).
 *
 * Every route here is authenticated by the Worker itself, not only by the Access
 * application in front of it - see `src/worker/security/access.ts` for why.
 *
 * The read/write split is deliberate and load-bearing. Email security scanners
 * open links in messages, so a `GET` that changed status would let an anti-virus
 * gateway acknowledge an application or mark it registered on the manager's
 * behalf (Issue #1 section 37). Every `GET` here is therefore read-only, and
 * every state change is a `POST` that additionally has to pass the origin and
 * double-submit CSRF checks - because Access authenticates with a cookie, and a
 * cookie is sent on cross-site requests too.
 *
 * The links in the manager's email point at portal pages, not at these
 * endpoints. The page shows what is about to happen and posts from there.
 */

const idSchema = z.string().uuid();

const MESSAGES = {
  noPhoto: 'ใบสมัครนี้ยังไม่มีรูปสมาชิก',
} as const;

const listQuerySchema = z.object({
  status: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(APPLICATION_STATUSES)))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Authenticates the caller and returns their identity.
 *
 * The team domain and audience are read per request rather than captured once,
 * so a rotated audience takes effect without a redeploy.
 */
async function authenticate(c: {
  env: AppContext['Bindings'];
  req: { raw: Request };
}): Promise<AccessIdentity> {
  const verifier = createAccessVerifier({
    teamDomain: requireSecret(c.env, 'CF_ACCESS_TEAM_DOMAIN'),
    audience: requireSecret(c.env, 'CF_ACCESS_AUD'),
  });
  return verifier.authenticate(c.req.raw);
}

export const adminRoutes: Hono<AppContext> = new Hono<AppContext>()
  /**
   * Issues the CSRF token the portal echoes back on every state change.
   *
   * Authenticated like everything else: an unauthenticated caller has no use
   * for a token, and handing one out would be a small oracle for whether Access
   * is configured.
   */
  .get('/admin/session', async (c) => {
    const identity = await authenticate(c);
    const token = generateCsrfToken();

    c.header(
      'Set-Cookie',
      csrfCookie(token, { secure: c.var.config.ENVIRONMENT !== 'development' }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({
      manager: { email: identity.email },
      csrf: { header: CSRF_HEADER_NAME, token },
    });
  })

  .get('/admin/applications', async (c) => {
    await authenticate(c);

    const query = listQuerySchema.parse({
      status: c.req.query('status'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    const view = await buildAdminView(c);
    const statuses: ApplicationStatus[] | undefined = query.status;

    c.header('Cache-Control', 'no-store');
    return c.json({
      applications: await view.list({
        ...(statuses ? { statuses } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      }),
    });
  })

  .get('/admin/applications/:id', async (c) => {
    await authenticate(c);
    const applicationId = idSchema.parse(c.req.param('id'));

    const view = await buildAdminView(c);
    const detail = await view.detail(applicationId);

    c.var.logger.info({ event: 'admin.detail_read', applicationId });

    c.header('Cache-Control', 'no-store');
    return c.json({ detail });
  })

  /**
   * The full citizen ID, on request only.
   *
   * A separate endpoint rather than a field on the detail, so an entry in the
   * audit trail means the manager asked for the number - not merely that they
   * opened the page. A `GET` because it changes no application state; the audit
   * event it writes is a record of the read, which is the point of it.
   */
  .get('/admin/applications/:id/citizen-id', async (c) => {
    const identity = await authenticate(c);
    const applicationId = idSchema.parse(c.req.param('id'));

    const view = await buildAdminView(c);
    const citizenId = await view.revealCitizenId(applicationId, identity.email);

    c.var.logger.info({ event: 'admin.citizen_id_revealed', applicationId });

    c.header('Cache-Control', 'no-store');
    return c.json({ citizenId });
  })

  /**
   * The manager's explicit "I have started" (Issue #1 section 34).
   *
   * Reaches the same status as their email being opened, and sends the member's
   * processing notice only if this call is the one that moved it.
   */
  .post('/admin/applications/:id/acknowledge', async (c) => {
    const identity = await authenticate(c);
    assertCsrfProtected(c.req.raw, c.var.config.APP_BASE_URL);
    const applicationId = idSchema.parse(c.req.param('id'));

    const events = await buildEmailEvents(c);
    const outcome = await events.acknowledgeByManager(applicationId, identity.email);

    c.var.logger.info({
      event: 'admin.acknowledged',
      applicationId,
      reason: outcome.transition.kind,
    });

    c.header('Cache-Control', 'no-store');
    return c.json({
      transition: outcome.transition.kind,
      processingEmailSent: outcome.processingEmailSent,
    });
  })

  /**
   * Records the NBTC registration (sections 38-40).
   *
   * A `POST` only, and CSRF-protected, because this is the irreversible one:
   * it tells the member their registration is complete.
   */
  .post('/admin/applications/:id/nbtc-complete', async (c) => {
    const identity = await authenticate(c);
    assertCsrfProtected(c.req.raw, c.var.config.APP_BASE_URL);
    const applicationId = idSchema.parse(c.req.param('id'));

    const completion = createNbtcCompletion(
      c.var.db,
      createStateMachine(c.var.db),
      await buildEmailService(c),
    );
    const report = await completion.confirm(applicationId, identity.email);

    c.var.logger.info({
      event: 'admin.nbtc_completed',
      applicationId,
      reason: report.complete ? 'COMPLETE' : 'INCOMPLETE',
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ completion: report });
  })

  /** Finishes a post-payment flow that stalled, without the applicant's token. */
  .post('/admin/applications/:id/finalize', async (c) => {
    await authenticate(c);
    assertCsrfProtected(c.req.raw, c.var.config.APP_BASE_URL);
    const applicationId = idSchema.parse(c.req.param('id'));

    const workflow = await buildApplicationWorkflow(
      c.env,
      c.var.db,
      c.var.providers.email,
      c.var.config.APP_BASE_URL,
    );
    const report = await workflow.resume(applicationId);

    c.var.logger.info({
      event: 'admin.finalized',
      applicationId,
      reason: report.complete ? 'COMPLETE' : 'INCOMPLETE',
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ confirmation: report });
  })

  /**
   * The member photo, streamed through the Worker.
   *
   * The bucket is private and there is no signed-URL path: a URL that works
   * without Access would outlive the manager's session and could be forwarded
   * (Issue #1 section 14).
   */
  .get('/admin/applications/:id/photo', async (c) => {
    await authenticate(c);
    const applicationId = idSchema.parse(c.req.param('id'));

    const photos = createMemberPhotoService(
      c.var.db,
      c.env.MEMBER_PHOTOS,
      createAuditLog(c.var.db),
    );
    const photo = await photos.read(applicationId);
    if (!photo) {
      throw new ApiError('NOT_FOUND', MESSAGES.noPhoto);
    }

    c.header('Content-Type', photo.contentType);
    c.header('Cache-Control', 'no-store');
    c.header('Content-Disposition', 'inline');
    return c.body(photo.body);
  })

  /** The receipt, regenerated from the record rather than stored (#12). */
  .get('/admin/applications/:id/receipt', async (c) => {
    const identity = await authenticate(c);
    const applicationId = idSchema.parse(c.req.param('id'));

    const db = c.var.db;
    const audit = createAuditLog(db);
    const receipts = createReceiptService(db, createNumberingService(db), audit);
    const { bytes, filename } = await receipts.render(applicationId);

    // The document contains personal data and leaves the system, so the access
    // is recorded like any other read of it.
    await audit.record({
      applicationId,
      eventType: 'RECEIPT_DOWNLOADED',
      actorType: 'MANAGER',
      actorId: identity.email,
    });

    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

/* ------------------------------------------------------------ assembly ---- */

async function buildEmailService(c: { env: AppContext['Bindings']; var: AppContext['Variables'] }) {
  const db = c.var.db;
  const audit = createAuditLog(db);
  const receipts = createReceiptService(db, createNumberingService(db), audit);

  return createEmailService(db, c.var.providers.email, receipts, audit, {
    managerEmail: requireSecret(c.env, 'MANAGER_EMAIL'),
    appBaseUrl: c.var.config.APP_BASE_URL,
    citizenId: await createCitizenIdProtection(requireSecret(c.env, 'PII_ENCRYPTION_KEY')),
  });
}

async function buildEmailEvents(c: { env: AppContext['Bindings']; var: AppContext['Variables'] }) {
  const db = c.var.db;
  return createEmailEventService(
    db,
    createStateMachine(db),
    await buildEmailService(c),
    createAuditLog(db),
  );
}

async function buildAdminView(c: { env: AppContext['Bindings']; var: AppContext['Variables'] }) {
  const db = c.var.db;
  const workflow = await buildApplicationWorkflow(
    c.env,
    db,
    c.var.providers.email,
    c.var.config.APP_BASE_URL,
  );

  return createAdminView(
    db,
    await createCitizenIdProtection(requireSecret(c.env, 'PII_ENCRYPTION_KEY')),
    workflow,
    createAuditLog(db),
  );
}
