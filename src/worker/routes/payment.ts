import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireSecret } from '../env';
import { createKeyedHasher } from '../lib/crypto';
import { validateImageBytes } from '../lib/files';
import { ApiError } from '../lib/http';
import { promptPayPayload } from '../lib/promptpay';
import type { PromptPayTargetKind } from '../lib/promptpay';
import type { SlipEvidence } from '../providers';
import { assertWithinRateLimit, clientIdentifier, PAYMENT_POLICY } from '../security/rate-limit';
import { assertHumanRequest } from '../security/turnstile';
import { createAuditLog } from '../services/audit';
import { ACCESS_TOKEN_HASH_INFO, createApplicationAccess } from '../services/application-access';
import { formatBaht, membershipPlan } from '../services/membership';
import { createPaymentService } from '../services/payment';
import type { AssociationAccount } from '../services/payment';
import { createStateMachine } from '../services/state-machine';
import { buildApplicationWorkflow } from '../services/workflow-factory';

/**
 * Payment endpoints.
 *
 * `GET /api/payment/instructions/:id` returns what the applicant needs in order
 * to transfer: the amount the server resolved, the association's account, and a
 * PromptPay payload carrying that exact amount so the total cannot be mistyped
 * (Issue #1 section 16).
 *
 * `POST /api/payment/verify` accepts a decoded QR payload, or a slip image as a
 * fallback. The image is read into memory, passed to the provider and dropped;
 * no branch writes it anywhere (Issue #1 section 19).
 */

const MAX_SLIP_BYTES = 2 * 1024 * 1024;

const MESSAGES = {
  form: 'ข้อมูลที่ส่งมาไม่ครบ กรุณาลองอีกครั้ง',
  evidence: 'กรุณาแนบสลิปหรือข้อมูล QR จากสลิป',
  tooLarge: 'ไฟล์สลิปมีขนาดใหญ่เกินกำหนด กรุณาย่อขนาดไฟล์',
  membership: 'กรุณาเลือกประเภทสมาชิกก่อนดูข้อมูลการชำระเงิน',
} as const;

const idSchema = z.string().uuid();

/**
 * Reads the association's receiving account from configuration.
 *
 * `VRA_BANK_ACCOUNT` doubles as the PromptPay target and as the value the slip's
 * receiver is checked against, so a missing value fails closed rather than
 * verifying a payment against nothing.
 */
function associationAccount(env: AppContext['Bindings']): AssociationAccount {
  return {
    accountDigits: requireSecret(env, 'VRA_BANK_ACCOUNT'),
    bankName: requireSecret(env, 'VRA_BANK_NAME'),
    accountName: requireSecret(env, 'VRA_BANK_ACCOUNT_NAME'),
  };
}

/**
 * How the account should be encoded in the PromptPay payload.
 *
 * A 10-digit value is a mobile number, 13 is a national ID, otherwise it is
 * treated as a bank account number. Guessing wrong produces a QR that scans but
 * pays the wrong account, so an unrecognised length is refused.
 */
function promptPayKind(accountDigits: string): PromptPayTargetKind {
  const digits = accountDigits.replace(/\D/g, '');
  if (digits.length === 10) return 'PHONE';
  if (digits.length === 13) return 'NATIONAL_ID';
  return 'BANK_ACCOUNT';
}

async function accessFor(env: AppContext['Bindings'], db: AppContext['Variables']['db']) {
  const keyMaterial = requireSecret(env, 'PII_ENCRYPTION_KEY');
  return createApplicationAccess(db, await createKeyedHasher(keyMaterial, ACCESS_TOKEN_HASH_INFO));
}

export const paymentRoutes = new Hono<AppContext>()
  .get('/payment/instructions/:id', async (c) => {
    const applicationId = idSchema.parse(c.req.param('id'));
    const access = await accessFor(c.env, c.var.db);
    await access.authorize(c.req.raw, applicationId);

    const application = await c.var.db.applications.findById(applicationId);
    if (!application?.membershipType) {
      throw new ApiError('CONFLICT', MESSAGES.membership);
    }

    const plan = membershipPlan(application.membershipType);
    const account = associationAccount(c.env);

    let qrPayload: string | null;
    try {
      qrPayload = promptPayPayload(
        { kind: promptPayKind(account.accountDigits), value: account.accountDigits },
        plan.amountSatang,
      );
    } catch {
      // A configured account that cannot be encoded should not stop the
      // applicant paying by hand, so the QR is omitted rather than fatal.
      qrPayload = null;
    }

    c.header('Cache-Control', 'no-store');
    return c.json({
      membershipType: plan.type,
      membershipLabel: plan.labelTh,
      amountSatang: plan.amountSatang,
      amountBaht: formatBaht(plan.amountSatang),
      bankName: account.bankName,
      accountName: account.accountName,
      accountNumber: account.accountDigits,
      qrPayload,
    });
  })

  .post('/payment/verify', async (c) => {
    await assertHumanRequest(c.var.security.turnstile, c.req.raw);
    await assertWithinRateLimit(
      c.var.security.rateLimiter,
      PAYMENT_POLICY,
      clientIdentifier(c.req.raw),
    );

    const declaredLength = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SLIP_BYTES) {
      throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ApiError('BAD_REQUEST', MESSAGES.form);
    }

    const applicationId = idSchema.parse(form.get('applicationId'));
    const access = await accessFor(c.env, c.var.db);
    await access.authorize(c.req.raw, applicationId);

    // The QR payload is the preferred path: decoded in the browser, so the slip
    // image never leaves the applicant's device (Issue #1 section 18).
    const qrPayload = form.get('qrPayload');
    const file = form.get('slip');

    let evidence: SlipEvidence;
    if (typeof qrPayload === 'string' && qrPayload.trim().length > 0) {
      evidence = { kind: 'qr', payload: qrPayload.trim() };
    } else if (file instanceof File) {
      if (file.size > MAX_SLIP_BYTES) {
        throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
      }
      const image = validateImageBytes(new Uint8Array(await file.arrayBuffer()), {
        maxBytes: MAX_SLIP_BYTES,
      });
      evidence = { kind: 'image', image };
    } else {
      throw new ApiError('BAD_REQUEST', MESSAGES.evidence);
    }

    const service = createPaymentService(
      c.var.db,
      c.var.providers.slip,
      createStateMachine(c.var.db),
      createAuditLog(c.var.db),
      associationAccount(c.env),
    );

    const verified = await service.verify({ applicationId, evidence });

    c.var.logger.info({
      event: 'payment.verified',
      applicationId,
      // The amount is not personal data and is useful for reconciliation. The
      // transaction reference is not logged: it identifies a bank transfer.
      count: verified.amountSatang,
      source: evidence.kind === 'qr' ? 'QR' : 'IMAGE',
    });

    // Everything after the money is confirmed happens here rather than on a
    // second request from the applicant (Issue #1 section 28). It runs after
    // verification has been committed, so a provider failure inside it leaves
    // the payment and the receipt intact and reports which step stalled.
    const workflow = await buildApplicationWorkflow(
      c.env,
      c.var.db,
      c.var.providers.email,
      c.var.config.APP_BASE_URL,
    );
    const report = await workflow.resume(applicationId);

    c.var.logger.info({
      event: 'workflow.resumed',
      applicationId,
      reason: report.complete ? 'COMPLETE' : 'INCOMPLETE',
    });

    c.header('Cache-Control', 'no-store');
    return c.json({
      verified: true,
      amountSatang: verified.amountSatang,
      amountBaht: formatBaht(verified.amountSatang),
      status: report.status,
      referenceNo: report.referenceNo,
      receiptNo: report.receiptNo,
      steps: report.steps,
      complete: report.complete,
    });
  });
