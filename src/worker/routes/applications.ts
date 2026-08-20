import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../context';
import { MEMBERSHIP_TYPES } from '../db';
import { requireSecret } from '../env';
import { createCitizenIdProtection, createKeyedHasher } from '../lib/crypto';
import { assertWithinRateLimit, clientIdentifier } from '../security/rate-limit';
import type { RateLimitPolicy } from '../security/rate-limit';
import { assertHumanRequest } from '../security/turnstile';
import { parseJsonBody } from '../security/validation';
import { createAuditLog } from '../services/audit';
import { createApplicationService } from '../services/application';
import {
  ACCESS_TOKEN_HASH_INFO,
  ACCESS_TOKEN_HEADER,
  createApplicationAccess,
} from '../services/application-access';

/**
 * Applicant-facing application endpoints (Issue #1 section 51).
 *
 * Creating an application is rate limited and Turnstile-gated because it writes
 * personal data. Reading and updating are not: they need a capability token
 * that cannot be guessed, which is a stronger gate than either.
 *
 * The response to a create carries the token exactly once. There is no way to
 * retrieve it afterwards, by design - a "resend my token" path would be a way
 * to take over an application by knowing an email address.
 */

const APPLICATION_POLICY: RateLimitPolicy = {
  scope: 'application-create',
  limit: 5,
  periodSeconds: 600,
};

/** Free-text fields the applicant may correct after OCR. */
const nameField = z.string().trim().min(1).max(120).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

const createSchema = z
  .object({
    // Accepts the formatting printed on the card; the service normalises.
    citizenId: z.string().trim().min(13).max(20),
    title: nameField,
    firstName: nameField,
    lastName: nameField,
    firstNameEn: nameField,
    lastNameEn: nameField,
    birthDate: isoDate,
    cardExpiryDate: isoDate,
  })
  .strict();

const addressSchema = z
  .object({
    idAddress: z.string().trim().max(300).nullable().optional(),
    idSubdistrict: z.string().trim().max(120).nullable().optional(),
    idDistrict: z.string().trim().max(120).nullable().optional(),
    idProvince: z.string().trim().max(120).nullable().optional(),
    mailSameAsId: z.boolean(),
    mailRecipient: z.string().trim().max(200).nullable().optional(),
    mailAddress: z.string().trim().max(300).nullable().optional(),
    mailSubdistrict: z.string().trim().max(120).nullable().optional(),
    mailDistrict: z.string().trim().max(120).nullable().optional(),
    mailProvince: z.string().trim().max(120).nullable().optional(),
    // Five digits. The card has none, so this always comes from the applicant.
    mailPostcode: z.string().regex(/^\d{5}$/),
    mailPhone: z.string().trim().max(30).nullable().optional(),
  })
  .strict();

/**
 * Update payload.
 *
 * There is deliberately no `amount` field. The membership amount is resolved
 * from the type on the server (Issue #1 section 4), and because the schema is
 * strict, a client that sends one is rejected rather than silently ignored.
 */
const updateSchema = z
  .object({
    phone: z.string().trim().min(9).max(20).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    callsign: z.string().trim().max(30).nullable().optional(),
    membershipType: z.enum(MEMBERSHIP_TYPES).optional(),
    address: addressSchema.optional(),
  })
  .strict();

const idSchema = z.string().uuid();

/**
 * Builds the services a handler needs.
 *
 * All three handlers need the same three, and they all derive from the one
 * secret, so deriving it in one place keeps the key handling in a single spot.
 */
async function buildServices(env: AppContext['Bindings'], db: AppContext['Variables']['db']) {
  const keyMaterial = requireSecret(env, 'PII_ENCRYPTION_KEY');
  const access = createApplicationAccess(
    db,
    await createKeyedHasher(keyMaterial, ACCESS_TOKEN_HASH_INFO),
  );
  const service = createApplicationService(
    db,
    await createCitizenIdProtection(keyMaterial),
    access,
    createAuditLog(db),
  );
  return { access, service };
}

export const applicationRoutes = new Hono<AppContext>()
  .post('/applications', async (c) => {
    await assertHumanRequest(c.var.security.turnstile, c.req.raw);
    await assertWithinRateLimit(
      c.var.security.rateLimiter,
      APPLICATION_POLICY,
      clientIdentifier(c.req.raw),
    );

    const input = await parseJsonBody(c.req.raw, createSchema);

    const { service } = await buildServices(c.env, c.var.db);
    const created = await service.create(input);

    c.var.logger.info({
      event: 'application.created',
      applicationId: created.view.id,
      // How many earlier applications this person has, not which ones.
      count: created.previousApplicationIds.length,
    });

    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        application: created.view,
        // Returned once and never again. The client must keep it for the rest
        // of the session.
        accessToken: created.accessToken,
        /**
         * Surfaced rather than blocking: renewals are expected (Issue #1
         * section 79), so a previous application is information, not an error.
         */
        hasPreviousApplication: created.previousApplicationIds.length > 0,
      },
      201,
    );
  })

  .get('/applications/:id', async (c) => {
    const applicationId = idSchema.parse(c.req.param('id'));

    const { access, service } = await buildServices(c.env, c.var.db);
    await access.authorize(c.req.raw, applicationId);

    c.header('Cache-Control', 'no-store');
    return c.json({ application: await service.get(applicationId) });
  })

  .patch('/applications/:id', async (c) => {
    const applicationId = idSchema.parse(c.req.param('id'));

    const { access, service } = await buildServices(c.env, c.var.db);
    await access.authorize(c.req.raw, applicationId);

    const input = await parseJsonBody(c.req.raw, updateSchema);
    const application = await service.update(applicationId, input);

    c.var.logger.info({ event: 'application.updated', applicationId });

    c.header('Cache-Control', 'no-store');
    return c.json({ application });
  });

export { ACCESS_TOKEN_HEADER };
