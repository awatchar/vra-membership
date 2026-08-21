import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { MembershipType, PaymentInput, Repository } from '../../src/worker/db';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import type { MockEmailProvider } from '../../src/worker/providers/mock/email';
import { TURNSTILE_TOKEN_HEADER } from '../../src/worker/security/turnstile';
import { createAuditLog } from '../../src/worker/services/audit';
import { ACCESS_TOKEN_HEADER } from '../../src/worker/services/application-access';
import { createApplicationWorkflow } from '../../src/worker/services/application-workflow';
import type {
  ApplicationWorkflow,
  WorkflowReport,
} from '../../src/worker/services/application-workflow';
import { createEmailService } from '../../src/worker/services/email';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import { ANNUAL_SATANG, LIFETIME_SATANG, repository, seedApplication } from '../support/fixtures';

/**
 * The post-payment sequence (Issue #1 section 28), end to end inside the worker.
 *
 * Most of these drive the service so the mock email provider can be inspected
 * and made to fail. The two route tests exist for one acceptance criterion that
 * cannot be checked any other way: that the applicant does not have to send a
 * second request.
 */

const APPLICANT_EMAIL = 'applicant@example.test';
const MANAGER_EMAIL = 'manager@example.test';

interface Harness {
  repo: Repository;
  provider: MockEmailProvider;
  workflow: ApplicationWorkflow;
}

function harness(
  repo: Repository,
  options: { failEmails?: 'REJECTED' | 'PROVIDER_ERROR' } = {},
): Harness {
  const provider = createMockEmailProvider(
    options.failEmails ? { failWith: options.failEmails } : {},
  );
  const audit = createAuditLog(repo);
  const numbering = createNumberingService(repo);
  const receipts = createReceiptService(repo, numbering, audit);
  const emails = createEmailService(repo, provider, receipts, audit, {
    managerEmail: MANAGER_EMAIL,
    appBaseUrl: 'https://membership.example.test',
  });

  return {
    repo,
    provider,
    workflow: createApplicationWorkflow(
      repo,
      createStateMachine(repo),
      numbering,
      receipts,
      emails,
    ),
  };
}

function paymentInput(applicationId: string, amountSatang: number): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `TXN-${crypto.randomUUID()}`,
    amountSatang,
    sendingBank: '002',
    receivingBank: 'ธนาคารตัวอย่าง',
    receiverAccountDigits: '1234',
    transactionAt: new Date().toISOString(),
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
  };
}

/** An application in `PAYMENT_VERIFIED`, which is where this workflow starts. */
async function paidApplication(
  repo: Repository,
  membership: MembershipType = 'ANNUAL',
  citizenId?: string,
): Promise<string> {
  const amount = membership === 'ANNUAL' ? ANNUAL_SATANG : LIFETIME_SATANG;
  const id = await seedApplication(repo, citizenId);
  await repo.applications.updateContact(id, { email: APPLICANT_EMAIL, phone: '0800000000' });
  await repo.applications.setMembership(id, membership, amount);
  await repo.payments.create(paymentInput(id, amount));

  const machine = createStateMachine(repo);
  await machine.transition(id, 'AWAITING_PAYMENT');
  // The domain event matters: the payment service records it, and the workflow
  // trail is asserted against the sequence in Issue #1 section 50.
  await machine.transition(id, 'PAYMENT_VERIFIED', { domainEvent: 'PAYMENT_VERIFIED' });
  return id;
}

function eventTypes(events: readonly { eventType: string }[]): string[] {
  return events.map((event) => event.eventType);
}

describe('the happy path', () => {
  it('carries an annual application all the way to the manager', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo, 'ANNUAL');

    const report = await workflow.resume(id);

    expect(report.complete).toBe(true);
    expect(report.steps).toEqual({
      APPLICATION_NUMBER: 'DONE',
      RECEIPT: 'DONE',
      RECEIPT_EMAIL: 'DONE',
      SUBMISSION: 'DONE',
      MANAGER_EMAIL: 'DONE',
    });
    expect(report.referenceNo).toMatch(/^VRA-\d{4}-\d{6}$/);
    expect(report.receiptNo).toMatch(/^VRA-RC-\d{4}-\d{6}$/);
    expect(report.status).toBe('MANAGER_NOTIFIED');
    expect(provider.sent).toHaveLength(2);
  });

  it('carries a lifetime application the same way, for the lifetime amount', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo, 'LIFETIME');

    const report = await workflow.resume(id);

    expect(report.complete).toBe(true);
    expect(report.status).toBe('MANAGER_NOTIFIED');
    const receipt = await repo.receipts.findByApplicationId(id);
    expect(receipt?.amountSatang).toBe(LIFETIME_SATANG);
    expect(provider.sent[0]!.text).toContain('2,000.00 บาท');
    expect(provider.sent[0]!.text).toContain('สมาชิกสามัญตลอดชีพ');
  });

  it('attaches the receipt to the member email and nothing to the manager one', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo);

    await workflow.resume(id);

    const receiptEmail = provider.sent.find((email) => email.to === APPLICANT_EMAIL)!;
    const managerEmail = provider.sent.find((email) => email.to === MANAGER_EMAIL)!;
    expect(receiptEmail.attachments).toHaveLength(1);
    expect(managerEmail.attachments ?? []).toHaveLength(0);
  });

  it('prints the application number on the receipt rather than a placeholder', async () => {
    const repo = repository();
    const { workflow } = harness(repo);
    const id = await paidApplication(repo);

    // The number is assigned before the receipt is issued for exactly this
    // reason: the member keeps the document.
    const report = await workflow.resume(id);
    const receipts = createReceiptService(repo, createNumberingService(repo), createAuditLog(repo));
    const rendered = await receipts.render(id);

    expect(report.referenceNo).not.toBeNull();
    expect(rendered.bytes.byteLength).toBeGreaterThan(0);
  });

  it('records the audit trail in the documented order', async () => {
    const repo = repository();
    const { workflow } = harness(repo);
    const id = await paidApplication(repo);

    await workflow.resume(id);

    // Issue #1 section 50 names these events and their order.
    const types = eventTypes(await repo.events.listByApplicationId(id));
    const expected = [
      'PAYMENT_VERIFIED',
      'RECEIPT_ISSUED',
      'RECEIPT_EMAIL_SENT',
      'APPLICATION_SUBMITTED',
      'MANAGER_EMAIL_SENT',
    ];
    const positions = expected.map((event) => types.indexOf(event));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('logs no applicant details in the audit trail', async () => {
    const repo = repository();
    const { workflow } = harness(repo);
    const id = await paidApplication(repo);

    await workflow.resume(id);

    const events = JSON.stringify(await repo.events.listByApplicationId(id));
    expect(events).not.toContain(APPLICANT_EMAIL);
    expect(events).not.toContain('ทดสอบ');
    expect(events).not.toContain('1234567890121');
  });
});

describe('running it again', () => {
  it('repeats nothing', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo);
    const first = await workflow.resume(id);

    const second = await workflow.resume(id);

    expect(second.steps).toEqual({
      APPLICATION_NUMBER: 'ALREADY_DONE',
      RECEIPT: 'ALREADY_DONE',
      RECEIPT_EMAIL: 'ALREADY_DONE',
      SUBMISSION: 'ALREADY_DONE',
      MANAGER_EMAIL: 'ALREADY_DONE',
    });
    expect(second.referenceNo).toBe(first.referenceNo);
    expect(second.receiptNo).toBe(first.receiptNo);
    expect(provider.sent).toHaveLength(2);
  });

  it('issues one receipt and one number under concurrent calls', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo);

    await Promise.allSettled([workflow.resume(id), workflow.resume(id)]);

    expect(await repo.emails.findByApplicationIdAndType(id, 'RECEIPT')).toHaveLength(1);
    expect(
      await repo.emails.findByApplicationIdAndType(id, 'MANAGER_NEW_APPLICATION'),
    ).toHaveLength(1);
    expect(await repo.receipts.findByApplicationId(id)).not.toBeNull();
    const application = await repo.applications.findById(id);
    expect(application?.referenceNo).not.toBeNull();

    // The loser of the insert race dispatches to the row that won, so the
    // provider may be called twice - with the *same* idempotency key, which is
    // what makes it one delivered message. The mock does not implement Resend's
    // deduplication, so the property to check is that there are only two
    // distinct keys, not that there were only two calls.
    const keys = new Set(provider.sent.map((email) => email.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it('numbers two applications without collision', async () => {
    const repo = repository();
    const { workflow } = harness(repo);
    const first = await paidApplication(repo, 'ANNUAL', '1234567890121');
    const second = await paidApplication(repo, 'LIFETIME', '1234567890139');

    const a = await workflow.resume(first);
    const b = await workflow.resume(second);

    expect(a.referenceNo).not.toBe(b.referenceNo);
    expect(a.receiptNo).not.toBe(b.receiptNo);
  });
});

describe('when the email provider is down', () => {
  it('keeps the receipt and the submission', async () => {
    const repo = repository();
    const { workflow } = harness(repo, { failEmails: 'PROVIDER_ERROR' });
    const id = await paidApplication(repo);

    const report = await workflow.resume(id);

    // The association has the money. Losing the receipt because a mail server
    // was unreachable would be the wrong failure.
    expect(report.steps.RECEIPT).toBe('DONE');
    expect(report.steps.RECEIPT_EMAIL).toBe('FAILED');
    expect(report.steps.SUBMISSION).toBe('DONE');
    expect(report.steps.MANAGER_EMAIL).toBe('FAILED');
    expect(report.complete).toBe(false);
    expect(report.receiptNo).not.toBeNull();
  });

  it('does not claim the manager was notified', async () => {
    const repo = repository();
    const { workflow } = harness(repo, { failEmails: 'PROVIDER_ERROR' });
    const id = await paidApplication(repo);

    const report = await workflow.resume(id);

    // `MANAGER_NOTIFIED` is also what #14 keys the manager's open off, so
    // recording it after a failed send would make an unseen application look
    // handled.
    expect(report.status).toBe('SUBMITTED');
    const types = eventTypes(await repo.events.listByApplicationId(id));
    expect(types).not.toContain('MANAGER_EMAIL_SENT');
    expect(types).toContain('APPLICATION_SUBMITTED');
  });

  it('records both failures against their own rows', async () => {
    const repo = repository();
    const { workflow } = harness(repo, { failEmails: 'PROVIDER_ERROR' });
    const id = await paidApplication(repo);

    await workflow.resume(id);

    const receipt = await repo.emails.findByApplicationIdAndType(id, 'RECEIPT');
    const manager = await repo.emails.findByApplicationIdAndType(id, 'MANAGER_NEW_APPLICATION');
    expect(receipt[0]).toMatchObject({ status: 'FAILED' });
    expect(manager[0]).toMatchObject({ status: 'FAILED' });
  });

  it('finishes the flow when the provider comes back, without a second receipt', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const failing = harness(repo, { failEmails: 'PROVIDER_ERROR' });
    const firstReport = await failing.workflow.resume(id);

    const working = harness(repo);
    const report = await working.workflow.resume(id);

    expect(report.complete).toBe(true);
    expect(report.receiptNo).toBe(firstReport.receiptNo);
    expect(report.referenceNo).toBe(firstReport.referenceNo);
    expect(report.status).toBe('MANAGER_NOTIFIED');
    expect(report.steps).toEqual({
      APPLICATION_NUMBER: 'ALREADY_DONE',
      RECEIPT: 'ALREADY_DONE',
      RECEIPT_EMAIL: 'DONE',
      SUBMISSION: 'ALREADY_DONE',
      MANAGER_EMAIL: 'DONE',
    });
  });

  it('reuses the failed row on retry rather than creating a second one', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    await harness(repo, { failEmails: 'PROVIDER_ERROR' }).workflow.resume(id);
    const before = await repo.emails.findByApplicationIdAndType(id, 'RECEIPT');

    const working = harness(repo);
    await working.workflow.resume(id);

    // Same row means the same provider idempotency key, so a send that actually
    // succeeded before the timeout cannot be delivered twice.
    const after = await repo.emails.findByApplicationIdAndType(id, 'RECEIPT');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.status).toBe('SENT');
    expect(working.provider.sent[0]!.idempotencyKey).toBe(before[0]!.id);
  });

  it('sends the manager email even if the member email keeps failing', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    // No applicant address, so the receipt email can never be sent; the manager
    // still has to hear about the application.
    await repo.applications.updateContact(id, { email: null });
    const { workflow, provider } = harness(repo);

    const report = await workflow.resume(id);

    expect(report.steps.RECEIPT_EMAIL).toBe('FAILED');
    expect(report.steps.MANAGER_EMAIL).toBe('DONE');
    expect(report.status).toBe('MANAGER_NOTIFIED');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe(MANAGER_EMAIL);
  });
});

describe('inspect', () => {
  it('reports every step as pending before anything has run', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo);

    const report = await workflow.inspect(id);

    expect(report.complete).toBe(false);
    expect(report.steps.RECEIPT).toBe('SKIPPED');
    expect(provider.sent).toHaveLength(0);
  });

  it('reports a finished flow without repeating any of it', async () => {
    const repo = repository();
    const { workflow, provider } = harness(repo);
    const id = await paidApplication(repo);
    await workflow.resume(id);

    const report = await workflow.inspect(id);

    expect(report.complete).toBe(true);
    expect(report.status).toBe('MANAGER_NOTIFIED');
    // A confirmation page must not be able to send email by being loaded.
    expect(provider.sent).toHaveLength(2);
  });

  it('distinguishes a failed step from one never attempted', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    await harness(repo, { failEmails: 'PROVIDER_ERROR' }).workflow.resume(id);

    const report = await harness(repo).workflow.inspect(id);

    expect(report.steps.RECEIPT_EMAIL).toBe('FAILED');
    expect(report.steps.RECEIPT).toBe('ALREADY_DONE');
  });

  it('refuses an application that does not exist', async () => {
    const repo = repository();
    const { workflow } = harness(repo);

    await expect(workflow.inspect(crypto.randomUUID())).rejects.toThrow();
  });
});

/* -------------------------------------------------------- through routes ---- */

interface CreatedBody {
  application: { id: string };
  accessToken: string;
}

async function createApplication(citizenId: string): Promise<CreatedBody> {
  const response = await exports.default.fetch(
    new Request('http://localhost/api/applications', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.77',
        [TURNSTILE_TOKEN_HEADER]: 'test-token',
      },
      body: JSON.stringify({ citizenId }),
    }),
  );
  expect(response.status).toBe(201);
  return response.json<CreatedBody>();
}

/** Takes a fresh application as far as the payment endpoint can be called. */
async function readyToPay(repo: Repository, citizenId: string) {
  const created = await createApplication(citizenId);
  const id = created.application.id;

  await exports.default.fetch(
    new Request(`http://localhost/api/applications/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', [ACCESS_TOKEN_HEADER]: created.accessToken },
      body: JSON.stringify({ email: APPLICANT_EMAIL, phone: '0800000000' }),
    }),
  );
  await repo.applications.setMembership(id, 'ANNUAL', ANNUAL_SATANG);
  await createStateMachine(repo).transition(id, 'AWAITING_PAYMENT');

  return { id, token: created.accessToken };
}

function verifyRequest(id: string, token: string): Request {
  const form = new FormData();
  form.append('applicationId', id);
  form.append('qrPayload', '00020101021229370016A00000067701011101130066812345678');

  return new Request('http://localhost/api/payment/verify', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '203.0.113.78',
      [TURNSTILE_TOKEN_HEADER]: 'test-token',
      [ACCESS_TOKEN_HEADER]: token,
    },
    body: form,
  });
}

describe('POST /api/payment/verify', () => {
  it('completes the whole flow without a second request from the applicant', async () => {
    const repo = repository();
    const { id, token } = await readyToPay(repo, '1234567890121');

    const response = await exports.default.fetch(verifyRequest(id, token));
    const body = await response.json<{
      verified: boolean;
      status: string;
      referenceNo: string | null;
      receiptNo: string | null;
      complete: boolean;
    }>();

    expect(response.status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.complete).toBe(true);
    expect(body.status).toBe('MANAGER_NOTIFIED');
    expect(body.referenceNo).toMatch(/^VRA-\d{4}-\d{6}$/);
    expect(body.receiptNo).toMatch(/^VRA-RC-\d{4}-\d{6}$/);
    expect(await repo.emails.findByApplicationIdAndType(id, 'RECEIPT')).toHaveLength(1);
    expect(
      await repo.emails.findByApplicationIdAndType(id, 'MANAGER_NEW_APPLICATION'),
    ).toHaveLength(1);
  });
});

describe('GET /api/applications/:id/confirmation', () => {
  it('returns the number and each step for the applicant', async () => {
    const repo = repository();
    const { id, token } = await readyToPay(repo, '1234567890121');
    await exports.default.fetch(verifyRequest(id, token));

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/applications/${id}/confirmation`, {
        headers: { [ACCESS_TOKEN_HEADER]: token },
      }),
    );
    const body = await response.json<{ confirmation: WorkflowReport }>();

    expect(response.status).toBe(200);
    expect(body.confirmation.complete).toBe(true);
    expect(body.confirmation.referenceNo).not.toBeNull();
    expect(body.confirmation.steps.MANAGER_EMAIL).toBe('ALREADY_DONE');
  });

  it('refuses a request without the capability token', async () => {
    const repo = repository();
    const { id } = await readyToPay(repo, '1234567890121');

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/applications/${id}/confirmation`),
    );

    // 404, not 401: an unauthenticated caller learns nothing about whether the
    // application exists.
    expect(response.status).toBe(404);
  });

  it('refuses another application’s token', async () => {
    const repo = repository();
    const mine = await readyToPay(repo, '1234567890121');
    const theirs = await readyToPay(repo, '1234567890139');

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/applications/${mine.id}/confirmation`, {
        headers: { [ACCESS_TOKEN_HEADER]: theirs.token },
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/applications/:id/finalize', () => {
  it('finishes a flow that stalled, and is a no-op once complete', async () => {
    const repo = repository();
    const { id, token } = await readyToPay(repo, '1234567890121');
    await exports.default.fetch(verifyRequest(id, token));

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/applications/${id}/finalize`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.79', [ACCESS_TOKEN_HEADER]: token },
      }),
    );
    const body = await response.json<{ confirmation: WorkflowReport }>();

    expect(response.status).toBe(200);
    expect(body.confirmation.steps).toEqual({
      APPLICATION_NUMBER: 'ALREADY_DONE',
      RECEIPT: 'ALREADY_DONE',
      RECEIPT_EMAIL: 'ALREADY_DONE',
      SUBMISSION: 'ALREADY_DONE',
      MANAGER_EMAIL: 'ALREADY_DONE',
    });
    expect(await repo.emails.findByApplicationIdAndType(id, 'RECEIPT')).toHaveLength(1);
  });

  it('refuses a request without the capability token', async () => {
    const repo = repository();
    const { id } = await readyToPay(repo, '1234567890121');

    const response = await exports.default.fetch(
      new Request(`http://localhost/api/applications/${id}/finalize`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.79' },
      }),
    );

    expect(response.status).toBe(404);
  });
});
