import { describe, expect, it } from 'vitest';
import { createRepository } from '../../src/worker/db';
import type { PaymentInput, Repository } from '../../src/worker/db';
import { createCitizenIdProtection } from '../../src/worker/lib/crypto';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import type { MockEmailProvider } from '../../src/worker/providers/mock/email';
import { createAuditLog } from '../../src/worker/services/audit';
import { createEmailService } from '../../src/worker/services/email';
import type { EmailService } from '../../src/worker/services/email';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import {
  ANNUAL_SATANG,
  TEST_CITIZEN_ID,
  TEST_KEY,
  repository,
  seedApplication,
} from '../support/fixtures';

const NOW = new Date('2026-08-20T03:00:00.000Z');
const MANAGER_EMAIL = 'manager@example.test';
const APPLICANT_EMAIL = 'applicant@example.test';
const APP_BASE_URL = 'https://membership.example.test';

interface Harness {
  repo: Repository;
  provider: MockEmailProvider;
  emails: EmailService;
}

async function harness(
  options: {
    failWith?: 'REJECTED' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT';
    maskCitizenId?: boolean;
  } = {},
): Promise<Harness> {
  const repo = repository();
  const provider = createMockEmailProvider(options.failWith ? { failWith: options.failWith } : {});
  const numbering = createNumberingService(repo, { now: () => NOW });
  const audit = createAuditLog(repo);
  const receipts = createReceiptService(repo, numbering, audit, { now: () => NOW });

  const emails = createEmailService(repo, provider, receipts, audit, {
    managerEmail: MANAGER_EMAIL,
    appBaseUrl: APP_BASE_URL,
    now: () => NOW,
    ...(options.maskCitizenId === false
      ? {}
      : { citizenId: await createCitizenIdProtection(TEST_KEY) }),
  });

  return { repo, provider, emails };
}

function paymentInput(applicationId: string): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `TXN-${crypto.randomUUID()}`,
    amountSatang: ANNUAL_SATANG,
    sendingBank: '002',
    receivingBank: 'ธนาคารตัวอย่าง',
    receiverAccountDigits: '7890',
    transactionAt: '2026-08-20T02:30:00.000Z',
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: NOW.toISOString(),
  };
}

/** An application that has paid, with contact details and a reference number. */
async function paidApplication(
  repo: Repository,
  overrides: { email?: string | null } = {},
): Promise<string> {
  const id = await seedApplication(repo);
  await repo.applications.updateContact(id, {
    email: overrides.email === undefined ? APPLICANT_EMAIL : overrides.email,
    phone: '0800000000',
    callsign: 'HS0TEST',
  });
  await repo.addresses.upsert(id, {
    idAddress: '99/9 หมู่ 9',
    idSubdistrict: 'ตำบลทดสอบ',
    idDistrict: 'อำเภอทดสอบ',
    idProvince: 'จังหวัดทดสอบ',
    mailSameAsId: true,
    mailRecipient: null,
    mailAddress: null,
    mailSubdistrict: null,
    mailDistrict: null,
    mailProvince: null,
    mailPostcode: null,
    mailPhone: null,
  });
  await repo.applications.setMembership(id, 'ANNUAL', ANNUAL_SATANG);
  await repo.applications.setReferenceNo(id, 'VRA-2569-000123');
  await repo.payments.create(paymentInput(id));

  const machine = createStateMachine(repo);
  await machine.transition(id, 'AWAITING_PAYMENT');
  await machine.transition(id, 'PAYMENT_VERIFIED');
  return id;
}

describe('receipt email', () => {
  it('sends to the applicant with the receipt PDF attached', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    const receipts = createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      createAuditLog(repo),
      { now: () => NOW },
    );
    const { receipt } = await receipts.issue(id);

    const outcome = await emails.sendReceipt(id);

    expect(outcome.ok).toBe(true);
    const sent = provider.sent.at(-1)!;
    expect(sent.to).toBe(APPLICANT_EMAIL);
    expect(sent.subject).toContain('VRA-2569-000123');
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe(`${receipt.receiptNo}.pdf`);
    expect(sent.attachments![0]!.contentType).toBe('application/pdf');
    expect(new TextDecoder('latin1').decode(sent.attachments![0]!.content.slice(0, 5))).toBe(
      '%PDF-',
    );
  });

  it('states the amount, the plan and what happens next', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    await createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      createAuditLog(repo),
      { now: () => NOW },
    ).issue(id);

    await emails.sendReceipt(id);
    const sent = provider.sent.at(-1)!;

    for (const expected of ['500.00 บาท', 'สมาชิกสามัญรายปี', 'ขั้นตอนต่อไป', 'กสทช.']) {
      expect(sent.text).toContain(expected);
      expect(sent.html).toContain(expected);
    }
  });

  it('does not send before a receipt has been issued', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    const outcome = await emails.sendReceipt(id);

    // The email promises an attachment; sending it without one would be worse
    // than not sending it.
    expect(outcome).toMatchObject({ ok: false, emailId: null, reason: 'NOT_ELIGIBLE' });
    expect(provider.sent).toHaveLength(0);
  });

  it('records nothing to send when the applicant has no email address', async () => {
    const { repo, emails } = await harness();
    const id = await paidApplication(repo, { email: null });
    await createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      createAuditLog(repo),
      { now: () => NOW },
    ).issue(id);

    const outcome = await emails.sendReceipt(id);

    expect(outcome).toMatchObject({ ok: false, emailId: null, reason: 'NO_RECIPIENT' });
    const events = await repo.events.listByApplicationId(id);
    expect(events.some((event) => event.eventType === 'EMAIL_SKIPPED')).toBe(true);
    expect(await repo.emails.findByApplicationIdAndType(id, 'RECEIPT')).toHaveLength(0);
  });
});

describe('manager email', () => {
  it('goes to the configured manager address, not the applicant', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);

    expect(provider.sent.at(-1)!.to).toBe(MANAGER_EMAIL);
  });

  it('carries the operational details the manager needs', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);
    const sent = provider.sent.at(-1)!;

    for (const expected of [
      'VRA-2569-000123',
      'ทดสอบ',
      'Thodsob',
      '15 มกราคม 2533',
      'จังหวัดทดสอบ',
      APPLICANT_EMAIL,
      '0800000000',
      'HS0TEST',
      'สมาชิกสามัญรายปี',
      '500.00 บาท',
    ]) {
      expect(sent.text).toContain(expected);
    }
  });

  it('shows only the last four digits of the citizen ID', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);
    const sent = provider.sent.at(-1)!;

    // Mailing the whole number would put it in the provider's records and in a
    // mailbox permanently, which is what encrypting it at rest prevents.
    expect(sent.text).not.toContain(TEST_CITIZEN_ID);
    expect(sent.html).not.toContain(TEST_CITIZEN_ID);
    expect(sent.text).toContain('x-xxxx-xxxx0-12-1');
  });

  it('audits the citizen ID read so the trail has no hole', async () => {
    const { repo, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);

    const events = await repo.events.listByApplicationId(id);
    expect(events.some((event) => event.eventType === 'CITIZEN_ID_MASKED_FOR_EMAIL')).toBe(true);
  });

  it('leaves the citizen ID out entirely when no key is available', async () => {
    const { repo, provider, emails } = await harness({ maskCitizenId: false });
    const id = await paidApplication(repo);

    const outcome = await emails.sendManagerNewApplication(id);

    // A missing key must not stop the manager being told there is work waiting.
    expect(outcome.ok).toBe(true);
    expect(provider.sent.at(-1)!.text).not.toContain('เลขบัตรประชาชน:');
  });

  it('attaches no images at all', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);
    const sent = provider.sent.at(-1)!;

    // Issue #1 section 31: no ID card, no slip, no member photo. The portal is
    // the only place those are visible.
    expect(sent.attachments ?? []).toHaveLength(0);
  });

  it('links into the admin portal for every action', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendManagerNewApplication(id);
    const sent = provider.sent.at(-1)!;

    expect(sent.text).toContain(`${APP_BASE_URL}/admin/applications/${id}`);
    expect(sent.text).toContain(`${APP_BASE_URL}/admin/applications/${id}/acknowledge`);
    expect(sent.text).toContain(`${APP_BASE_URL}/admin/applications/${id}/nbtc-complete`);
  });

  it('is the only email that asks for open tracking', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    await createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      createAuditLog(repo),
      { now: () => NOW },
    ).issue(id);

    await emails.sendManagerNewApplication(id);
    await emails.sendReceipt(id);
    await emails.sendMemberProcessing(id);
    await emails.sendMemberCompleted(id);

    const tracked = provider.sent.filter((email) => email.trackOpens === true);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.to).toBe(MANAGER_EMAIL);
  });
});

describe('member notices', () => {
  it('sends the processing notice', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    const outcome = await emails.sendMemberProcessing(id);

    expect(outcome.ok).toBe(true);
    const sent = provider.sent.at(-1)!;
    expect(sent.to).toBe(APPLICANT_EMAIL);
    expect(sent.subject).toContain('อยู่ระหว่างดำเนินการ');
  });

  it('sends the completion notice with a link the member can verify', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendMemberCompleted(id);
    const sent = provider.sent.at(-1)!;

    expect(sent.subject).toContain('บันทึกข้อมูลสมาชิกเรียบร้อยแล้ว');
    expect(sent.text).toContain('https://oss.nbtc.go.th/OSS2/Home/');
  });
});

describe('every template', () => {
  it('ships both HTML and plain text', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    await createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      createAuditLog(repo),
      { now: () => NOW },
    ).issue(id);

    await emails.sendReceipt(id);
    await emails.sendManagerNewApplication(id);
    await emails.sendMemberProcessing(id);
    await emails.sendMemberCompleted(id);

    expect(provider.sent).toHaveLength(4);
    for (const sent of provider.sent) {
      expect(sent.subject.length).toBeGreaterThan(0);
      expect(sent.html).toContain('<!doctype html>');
      // Readable on a phone without a media query: one column, viewport set.
      expect(sent.html).toContain('width=device-width');
      expect(sent.text.length).toBeGreaterThan(80);
      expect(sent.text).not.toContain('<');
    }
  });

  it('tags every message with the application it belongs to', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);

    await emails.sendMemberProcessing(id);

    expect(provider.sent.at(-1)!.tags).toEqual({
      applicationId: id,
      emailType: 'MEMBER_PROCESSING',
    });
  });
});

describe('recording and failure', () => {
  it('records a sent email against the application', async () => {
    const { repo, emails } = await harness();
    const id = await paidApplication(repo);

    const outcome = await emails.sendMemberProcessing(id);

    const rows = await repo.emails.findByApplicationIdAndType(id, 'MEMBER_PROCESSING');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'SENT',
      recipient: APPLICANT_EMAIL,
      provider: 'mock-email',
      sentAt: NOW.toISOString(),
    });
    expect(rows[0]!.providerEmailId).toBe((outcome as { providerEmailId: string }).providerEmailId);
  });

  it('records a provider failure as a status rather than throwing', async () => {
    const { repo, emails } = await harness({ failWith: 'PROVIDER_ERROR' });
    const id = await paidApplication(repo);

    // The association already has the money by the time this email is sent.
    // Letting a provider outage undo that would be the wrong failure.
    const outcome = await emails.sendMemberProcessing(id);

    expect(outcome).toMatchObject({ ok: false, reason: 'PROVIDER_ERROR' });
    const rows = await repo.emails.findByApplicationIdAndType(id, 'MEMBER_PROCESSING');
    expect(rows[0]).toMatchObject({ status: 'FAILED', providerEmailId: null, sentAt: null });
  });

  it('audits a failure with the reason but no address', async () => {
    const { repo, emails } = await harness({ failWith: 'REJECTED' });
    const id = await paidApplication(repo);

    await emails.sendMemberProcessing(id);

    const events = await repo.events.listByApplicationId(id);
    const failure = events.find((event) => event.eventType === 'EMAIL_SEND_FAILED');
    expect(failure?.metadata).toMatchObject({
      emailType: 'MEMBER_PROCESSING',
      reason: 'REJECTED',
    });
    expect(JSON.stringify(events)).not.toContain(APPLICANT_EMAIL);
    expect(JSON.stringify(events)).not.toContain('ทดสอบ');
  });

  it('throws only for an application that does not exist', async () => {
    const { emails } = await harness();

    await expect(emails.sendMemberProcessing(crypto.randomUUID())).rejects.toThrow();
  });
});

describe('retry', () => {
  it('reuses the row and its idempotency key', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    const first = await emails.sendMemberProcessing(id);
    const emailId = (first as { emailId: string }).emailId;

    const second = await emails.retry(emailId);

    // Same key, so the provider returns the first message instead of mailing
    // the member twice.
    expect(second).toMatchObject({ ok: true, emailId });
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[0]!.idempotencyKey).toBe(emailId);
    expect(provider.sent[1]!.idempotencyKey).toBe(emailId);
    expect(await repo.emails.findByApplicationIdAndType(id, 'MEMBER_PROCESSING')).toHaveLength(1);
  });

  it('turns a failed row into a sent one', async () => {
    const repo = repository();
    const id = await paidApplication(repo);
    const audit = createAuditLog(repo);
    const receipts = createReceiptService(
      repo,
      createNumberingService(repo, { now: () => NOW }),
      audit,
      { now: () => NOW },
    );

    const failing = createMockEmailProvider({ failWith: 'PROVIDER_ERROR' });
    const outcome = await createEmailService(repo, failing, receipts, audit, {
      managerEmail: MANAGER_EMAIL,
      appBaseUrl: APP_BASE_URL,
      now: () => NOW,
    }).sendMemberProcessing(id);
    const emailId = (outcome as { emailId: string }).emailId;

    const working = createMockEmailProvider();
    const retried = await createEmailService(repo, working, receipts, audit, {
      managerEmail: MANAGER_EMAIL,
      appBaseUrl: APP_BASE_URL,
      now: () => NOW,
    }).retry(emailId);

    expect(retried.ok).toBe(true);
    const rows = await repo.emails.findByApplicationIdAndType(id, 'MEMBER_PROCESSING');
    expect(rows[0]).toMatchObject({ status: 'SENT' });
  });

  it('sends to the address the first attempt used', async () => {
    const { repo, provider, emails } = await harness();
    const id = await paidApplication(repo);
    const first = await emails.sendMemberProcessing(id);
    const emailId = (first as { emailId: string }).emailId;

    // Re-resolving the recipient would let a later edit redirect a retry
    // somewhere the original never went.
    await repo.applications.updateContact(id, { email: 'changed@example.test' });
    await emails.retry(emailId);

    expect(provider.sent.at(-1)!.to).toBe(APPLICANT_EMAIL);
  });

  it('refuses an unknown row', async () => {
    const { emails } = await harness();

    await expect(emails.retry(crypto.randomUUID())).rejects.toThrow();
  });
});

describe('safety of rendered content', () => {
  it('escapes markup coming from stored data', async () => {
    const repo = createRepository((await import('cloudflare:workers')).env.DB);
    const protection = await createCitizenIdProtection(TEST_KEY);
    const application = await repo.applications.create({
      citizenIdHash: await protection.hash('1234567890147'),
      citizenIdCiphertext: await protection.encrypt('1234567890147'),
      title: 'นาย',
      firstName: '<script>alert(1)</script>',
      lastName: 'ระบบสมัคร',
    });
    await repo.applications.updateContact(application.id, { email: APPLICANT_EMAIL });
    await repo.applications.setReferenceNo(application.id, 'VRA-2569-000999');

    const audit = createAuditLog(repo);
    const provider = createMockEmailProvider();
    await createEmailService(
      repo,
      provider,
      createReceiptService(repo, createNumberingService(repo, { now: () => NOW }), audit, {
        now: () => NOW,
      }),
      audit,
      { managerEmail: MANAGER_EMAIL, appBaseUrl: APP_BASE_URL, now: () => NOW },
    ).sendMemberProcessing(application.id);

    const sent = provider.sent.at(-1)!;
    expect(sent.html).not.toContain('<script>');
    expect(sent.html).toContain('&lt;script&gt;');
  });
});
