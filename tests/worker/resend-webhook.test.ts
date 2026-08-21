import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EmailRecord, PaymentInput, Repository } from '../../src/worker/db';
import { createAuditLog } from '../../src/worker/services/audit';
import { createEmailService } from '../../src/worker/services/email';
import { createEmailEventService } from '../../src/worker/services/email-events';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import { FIVE_YEAR_SATANG, repository, seedApplication } from '../support/fixtures';

/**
 * The webhook is a public endpoint that can change an application's status, so
 * these tests drive the real route and the real signature verification. Nothing
 * reaches Resend: the signature is pure cryptography, and the outbound email
 * provider is the mock (AGENTS.md).
 */

const SECRET = 'whsec_testonlywebhooksecret123';
const APPLICANT_EMAIL = 'applicant@example.test';
const MANAGER_EMAIL = 'manager@example.test';

async function sign(id: string, timestamp: string, payload: string): Promise<string> {
  const raw = Uint8Array.from(atob(SECRET.slice('whsec_'.length)), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  return btoa(String.fromCharCode(...mac));
}

interface PostOptions {
  /** Overrides the signature, to test rejection. */
  signature?: string;
  /** Seconds offset applied to the signed timestamp. */
  ageSeconds?: number;
  /** Sent instead of the JSON body, so the signature covers these bytes. */
  rawBody?: string;
  omitHeaders?: readonly string[];
}

async function post(body: unknown, options: PostOptions = {}): Promise<Response> {
  const payload = options.rawBody ?? JSON.stringify(body);
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0));

  const headers = new Headers({
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': options.signature ?? `v1,${await sign(id, timestamp, payload)}`,
  });
  for (const name of options.omitHeaders ?? []) headers.delete(name);

  return exports.default.fetch(
    new Request('https://membership.example.test/api/webhooks/resend', {
      method: 'POST',
      headers,
      body: payload,
    }),
  );
}

function event(type: string, emailId: string): unknown {
  return {
    type,
    created_at: '2026-08-21T03:00:00.000Z',
    data: {
      email_id: emailId,
      from: 'VRA <membership@example.test>',
      to: [APPLICANT_EMAIL],
      subject: 'ทดสอบ',
    },
  };
}

function paymentInput(applicationId: string): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `TXN-${crypto.randomUUID()}`,
    amountSatang: FIVE_YEAR_SATANG,
    sendingBank: '002',
    receivingBank: 'ธนาคารตัวอย่าง',
    receiverAccountDigits: '7890',
    transactionAt: '2026-08-20T02:30:00.000Z',
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: '2026-08-20T03:00:00.000Z',
  };
}

/**
 * An application that has reached `MANAGER_NOTIFIED`, with a sent manager email
 * carrying `providerEmailId` - the state the webhook actually arrives in.
 */
async function notifiedApplication(
  repo: Repository,
  providerEmailId: string,
): Promise<{ applicationId: string; email: EmailRecord }> {
  const applicationId = await seedApplication(repo);
  await repo.applications.updateContact(applicationId, { email: APPLICANT_EMAIL });
  await repo.applications.setMembership(applicationId, 'FIVE_YEAR', FIVE_YEAR_SATANG);
  await repo.applications.setReferenceNo(
    applicationId,
    `VRA-2569-${crypto.randomUUID().slice(0, 6)}`,
  );
  await repo.payments.create(paymentInput(applicationId));

  const machine = createStateMachine(repo);
  await machine.transition(applicationId, 'AWAITING_PAYMENT');
  await machine.transition(applicationId, 'PAYMENT_VERIFIED');
  await machine.transition(applicationId, 'SUBMITTED');
  await machine.transition(applicationId, 'MANAGER_NOTIFIED');

  const created = await repo.emails.create({
    applicationId,
    type: 'MANAGER_NEW_APPLICATION',
    recipient: MANAGER_EMAIL,
    provider: 'resend',
  });
  await repo.emails.markSent(created.id, providerEmailId);
  const email = await repo.emails.findById(created.id);
  return { applicationId, email: email! };
}

describe('signature verification', () => {
  it('accepts a correctly signed event', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    const response = await post(event('email.delivered', 'resend-1'));

    expect(response.status).toBe(200);
    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'DELIVERED' });
  });

  it('rejects a wrong signature with 401 and no side effect', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    const response = await post(event('email.delivered', 'resend-1'), {
      signature: `v1,${btoa('not-the-right-signature-at-all')}`,
    });

    expect(response.status).toBe(401);
    // The row must be untouched: an unauthenticated caller may not move it.
    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('rejects a body altered after signing', async () => {
    const repo = repository();
    await notifiedApplication(repo, 'resend-1');

    const id = `msg_${crypto.randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const original = JSON.stringify(event('email.delivered', 'resend-1'));
    const signature = await sign(id, timestamp, original);

    const response = await exports.default.fetch(
      new Request('https://membership.example.test/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        },
        body: JSON.stringify(event('email.bounced', 'resend-1')),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a replayed request whose timestamp has expired', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    // A valid signature stays valid forever, so the timestamp is the only thing
    // that makes a captured request useless later.
    const response = await post(event('email.delivered', 'resend-1'), { ageSeconds: 6 * 60 });

    expect(response.status).toBe(401);
    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('rejects a request with a signature header but no timestamp', async () => {
    const repo = repository();
    await notifiedApplication(repo, 'resend-1');

    const response = await post(event('email.delivered', 'resend-1'), {
      omitHeaders: ['svix-timestamp'],
    });

    expect(response.status).toBe(401);
  });

  it('rejects a request with no signature headers at all', async () => {
    const repo = repository();
    await notifiedApplication(repo, 'resend-1');

    const response = await post(event('email.delivered', 'resend-1'), {
      omitHeaders: ['svix-id', 'svix-timestamp', 'svix-signature'],
    });

    expect(response.status).toBe(401);
  });

  it('says nothing about why a signature failed', async () => {
    const response = await post(event('email.delivered', 'resend-1'), { signature: 'v1,AAAA' });
    const body = await response.json<{ error: { code: string; message: string } }>();

    // Detail here would help someone iterate towards a valid signature.
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).not.toMatch(/signature|timestamp|svix/i);
  });
});

describe('events this system has no use for', () => {
  it('acknowledges an unknown event type without changing anything', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    // A non-2xx answer makes Resend redeliver for hours and buys nothing.
    const response = await post(event('domain.created', 'resend-1'));

    expect(response.status).toBe(200);
    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('acknowledges an event for a message it does not know', async () => {
    const response = await post(event('email.delivered', 'not-a-message-we-sent'));

    expect(response.status).toBe(200);
  });

  it('acknowledges a body that is not a Resend event', async () => {
    const response = await post({ hello: 'world' });

    expect(response.status).toBe(200);
  });

  it('acknowledges a body that is not JSON at all', async () => {
    const response = await post(null, { rawBody: 'not json' });

    expect(response.status).toBe(200);
  });

  it('refuses a body larger than the limit', async () => {
    // The signature can only be checked after the body has been read, so the
    // read itself has to be bounded.
    const response = await post(null, { rawBody: 'x'.repeat(64 * 1024 + 1) });

    expect(response.status).toBe(413);
  });
});

describe('delivery status', () => {
  it('records a delivery', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.delivered', 'resend-1'));

    const stored = await repo.emails.findById(email.id);
    expect(stored?.status).toBe('DELIVERED');
    expect(stored?.deliveredAt).not.toBeNull();
  });

  it('keeps the first delivery time when the event is redelivered', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.delivered', 'resend-1'));
    const first = (await repo.emails.findById(email.id))!.deliveredAt;
    await post(event('email.delivered', 'resend-1'));

    expect((await repo.emails.findById(email.id))!.deliveredAt).toBe(first);
  });

  it('records a bounce and audits it', async () => {
    const repo = repository();
    const { applicationId, email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.bounced', 'resend-1'));

    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'BOUNCED' });
    const events = await repo.events.listByApplicationId(applicationId);
    expect(events.some((entry) => entry.eventType === 'EMAIL_BOUNCED')).toBe(true);
  });

  it('does not let a late delivery event overwrite a bounce', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    // Resend warns that events may arrive out of order. Reporting a message as
    // delivered when the recipient's server refused it would be worse than
    // losing the ordering.
    await post(event('email.bounced', 'resend-1'));
    await post(event('email.delivered', 'resend-1'));

    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'BOUNCED' });
  });

  it('does not let email.sent move a delivered message backwards', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.delivered', 'resend-1'));
    await post(event('email.sent', 'resend-1'));

    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'DELIVERED' });
  });

  it('records only the first click', async () => {
    const repo = repository();
    const { email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.clicked', 'resend-1'));
    const first = (await repo.emails.findById(email.id))!.firstClickedAt;
    await post(event('email.clicked', 'resend-1'));

    expect(first).not.toBeNull();
    expect((await repo.emails.findById(email.id))!.firstClickedAt).toBe(first);
  });
});

describe('the manager opening the notification', () => {
  it('moves the application into NBTC_PROCESSING', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.opened', 'resend-1'));

    await expect(repo.applications.findById(applicationId)).resolves.toMatchObject({
      status: 'NBTC_PROCESSING',
    });
  });

  it('records the open and the domain event', async () => {
    const repo = repository();
    const { applicationId, email } = await notifiedApplication(repo, 'resend-1');

    await post(event('email.opened', 'resend-1'));

    expect((await repo.emails.findById(email.id))!.firstOpenedAt).not.toBeNull();
    const events = await repo.events.listByApplicationId(applicationId);
    expect(events.some((entry) => entry.eventType === 'MANAGER_EMAIL_OPENED')).toBe(true);
  });

  it('changes the status once for ten opens', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await post(event('email.opened', 'resend-1'));
      expect(response.status).toBe(200);
    }

    const events = await repo.events.listByApplicationId(applicationId);
    expect(events.filter((entry) => entry.eventType === 'MANAGER_EMAIL_OPENED')).toHaveLength(1);
    expect(
      events.filter(
        (entry) =>
          entry.eventType === 'STATUS_CHANGED' && entry.metadata?.['to'] === 'NBTC_PROCESSING',
      ),
    ).toHaveLength(1);
  });

  it('queues exactly one processing email for ten opens', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post(event('email.opened', 'resend-1'));
    }

    // Issue #1 section 56: the member must be told once, not ten times.
    expect(
      await repo.emails.findByApplicationIdAndType(applicationId, 'MEMBER_PROCESSING'),
    ).toHaveLength(1);
  });

  it('ignores an open of a member email', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-2');
    const receipt = await repo.emails.create({
      applicationId,
      type: 'RECEIPT',
      recipient: APPLICANT_EMAIL,
      provider: 'resend',
    });
    await repo.emails.markSent(receipt.id, 'resend-receipt');

    await post(event('email.opened', 'resend-receipt'));

    // Only the manager's attention is a signal about the application.
    await expect(repo.applications.findById(applicationId)).resolves.toMatchObject({
      status: 'MANAGER_NOTIFIED',
    });
    expect((await repo.emails.findById(receipt.id))!.firstOpenedAt).not.toBeNull();
  });
});

/**
 * The service is driven directly here so the mock provider can be inspected and
 * the manager path exercised without the admin route, which arrives in #16.
 */
describe('the manager button as a fallback', () => {
  function services(repo: Repository) {
    const provider = createMockEmailProvider();
    const audit = createAuditLog(repo);
    const receipts = createReceiptService(repo, createNumberingService(repo), audit);
    const emails = createEmailService(repo, provider, receipts, audit, {
      managerEmail: MANAGER_EMAIL,
      appBaseUrl: 'https://membership.example.test',
    });
    return {
      provider,
      events: createEmailEventService(repo, createStateMachine(repo), emails, audit),
    };
  }

  it('reaches the same status without waiting for a tracking pixel', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const { events, provider } = services(repo);

    const outcome = await events.acknowledgeByManager(applicationId, 'manager@example.test');

    expect(outcome.transition.kind).toBe('APPLIED');
    expect(outcome.processingEmailSent).toBe(true);
    expect(provider.sent).toHaveLength(1);
    await expect(repo.applications.findById(applicationId)).resolves.toMatchObject({
      status: 'NBTC_PROCESSING',
    });
  });

  it('sends nothing when the open already got there first', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const { events, provider } = services(repo);

    await events.handle(event('email.opened', 'resend-1'));
    const outcome = await events.acknowledgeByManager(applicationId, 'manager@example.test');

    // Issue #1 section 34: either signal works, and the member hears once.
    expect(outcome.processingEmailSent).toBe(false);
    expect(provider.sent).toHaveLength(1);
    expect(
      await repo.emails.findByApplicationIdAndType(applicationId, 'MEMBER_PROCESSING'),
    ).toHaveLength(1);
  });

  it('sends nothing when the button was pressed first', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const { events, provider } = services(repo);

    await events.acknowledgeByManager(applicationId, 'manager@example.test');
    const outcome = await events.handle(event('email.opened', 'resend-1'));

    expect(outcome).toMatchObject({ kind: 'RECORDED', processingEmailSent: false });
    expect(provider.sent).toHaveLength(1);
  });

  it('sends one email when both arrive at once', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const { events, provider } = services(repo);

    // The compare-and-set is what decides; reading the status and then acting
    // would leave a window where both callers see `MANAGER_NOTIFIED`.
    await Promise.all([
      events.handle(event('email.opened', 'resend-1')),
      events.acknowledgeByManager(applicationId, 'manager@example.test'),
    ]);

    expect(provider.sent).toHaveLength(1);
    expect(
      await repo.emails.findByApplicationIdAndType(applicationId, 'MEMBER_PROCESSING'),
    ).toHaveLength(1);
  });

  it('is a no-op once the application has moved past processing', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const { events, provider } = services(repo);
    await events.acknowledgeByManager(applicationId, 'manager@example.test');
    await createStateMachine(repo).transition(applicationId, 'NBTC_RECORDED');

    const outcome = await events.handle(event('email.opened', 'resend-1'));

    expect(outcome).toMatchObject({ processingEmailSent: false });
    expect(provider.sent).toHaveLength(1);
  });
});

describe('a failed processing email', () => {
  it('does not undo the status change', async () => {
    const repo = repository();
    const { applicationId } = await notifiedApplication(repo, 'resend-1');
    const audit = createAuditLog(repo);
    const provider = createMockEmailProvider({ failWith: 'PROVIDER_ERROR' });
    const emails = createEmailService(
      repo,
      provider,
      createReceiptService(repo, createNumberingService(repo), audit),
      audit,
      { managerEmail: MANAGER_EMAIL, appBaseUrl: 'https://membership.example.test' },
    );
    const events = createEmailEventService(repo, createStateMachine(repo), emails, audit);

    const outcome = await events.handle(event('email.opened', 'resend-1'));

    // The manager really has started work. Rolling that back because Resend
    // was down would lose a fact in order to report one.
    expect(outcome).toMatchObject({ advancedToProcessing: true, processingEmailSent: false });
    await expect(repo.applications.findById(applicationId)).resolves.toMatchObject({
      status: 'NBTC_PROCESSING',
    });
    const rows = await repo.emails.findByApplicationIdAndType(applicationId, 'MEMBER_PROCESSING');
    expect(rows[0]).toMatchObject({ status: 'FAILED' });
  });
});
