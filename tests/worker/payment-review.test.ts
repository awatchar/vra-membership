import { describe, expect, it } from 'vitest';
import type { Repository } from '../../src/worker/db';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import { createAuditLog } from '../../src/worker/services/audit';
import { createEmailService } from '../../src/worker/services/email';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createPaymentReviewService } from '../../src/worker/services/payment-review';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import {
  FIVE_YEAR_SATANG,
  OTHER_TEST_CITIZEN_ID,
  repository,
  seedApplication,
} from '../support/fixtures';

const NOW = new Date('2026-08-22T02:00:00.000Z');
const ACCOUNT = {
  accountDigits: '1234567890',
  bankName: 'ธนาคารตัวอย่าง',
  accountName: 'สมาคมตัวอย่าง',
};

async function ready(repo: Repository, citizenId?: string): Promise<string> {
  const id = await seedApplication(repo, citizenId);
  await repo.applications.updateContact(id, {
    email: 'applicant@example.test',
    phone: '0800000000',
    callsign: null,
  });
  await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);
  await createStateMachine(repo).transition(id, 'AWAITING_PAYMENT');
  return id;
}

function harness(repo: Repository) {
  const provider = createMockEmailProvider();
  const audit = createAuditLog(repo);
  const numbering = createNumberingService(repo, { now: () => NOW });
  const receipts = createReceiptService(repo, numbering, audit, { now: () => NOW });
  const emails = createEmailService(repo, provider, receipts, audit, {
    managerEmail: 'manager@example.test',
    ccEmail: 'copy@example.test',
    appBaseUrl: 'https://membership.example.test',
    now: () => NOW,
  });
  const service = createPaymentReviewService(
    repo,
    emails,
    createStateMachine(repo),
    audit,
    ACCOUNT,
    () => NOW,
  );
  return { provider, service };
}

describe('manual payment review request', () => {
  it('stores only a pending reason and sends one tracked manager notification', async () => {
    const repo = repository({ now: () => NOW });
    const id = await ready(repo);
    const { provider, service } = harness(repo);

    const first = await service.request(id);
    const second = await service.request(id);

    expect(first).toMatchObject({ created: true, notificationSent: true });
    expect(second).toMatchObject({ created: false, notificationSent: true });
    await expect(repo.paymentReviews.findByApplicationId(id)).resolves.toEqual({
      applicationId: id,
      reason: 'SLIP_UNREADABLE',
      status: 'PENDING',
      requestedAt: NOW.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      to: 'manager@example.test',
      cc: ['copy@example.test'],
    });
    expect(provider.sent[0]!.attachments).toBeUndefined();
    expect(provider.sent[0]!.text).toContain('ไม่ได้เก็บหรือแนบรูปสลิป');

    const events = await repo.events.listByApplicationId(id);
    expect(
      events.filter((event) => event.eventType === 'PAYMENT_MANUAL_REVIEW_REQUESTED'),
    ).toHaveLength(1);
  });

  it('refuses a request outside the awaiting-payment state', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const { service } = harness(repo);

    await expect(service.request(id)).rejects.toThrow(/ไม่อยู่ในขั้นตอน/);
    await expect(repo.paymentReviews.findByApplicationId(id)).resolves.toBeNull();
  });
});

describe('manager approval', () => {
  it('records the server-resolved amount and moves through the normal payment boundary', async () => {
    const repo = repository({ now: () => NOW });
    const id = await ready(repo);
    const { service } = harness(repo);
    await service.request(id);

    await expect(
      service.approve(id, ' bank-ref-0001 ', 'manager@example.test'),
    ).resolves.toMatchObject({ amountSatang: FIVE_YEAR_SATANG });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'PAYMENT_VERIFIED',
    });
    await expect(repo.payments.findByApplicationId(id)).resolves.toEqual([
      expect.objectContaining({
        provider: 'manual-bank-statement',
        transactionRef: 'BANK-REF-0001',
        amountSatang: FIVE_YEAR_SATANG,
        receiverMatched: true,
        amountMatched: true,
        verificationStatus: 'VERIFIED',
      }),
    ]);
    await expect(repo.paymentReviews.findByApplicationId(id)).resolves.toMatchObject({
      status: 'APPROVED',
      resolvedAt: NOW.toISOString(),
      resolvedBy: 'manager@example.test',
    });
  });

  it('requires a pending request and a constrained bank reference', async () => {
    const repo = repository();
    const id = await ready(repo);
    const { service } = harness(repo);

    await expect(service.approve(id, 'BANK-REF-0002', 'manager@example.test')).rejects.toThrow(
      /ไม่มีคำขอ/,
    );
    await service.request(id);
    await expect(
      service.approve(id, 'bad ref with spaces', 'manager@example.test'),
    ).rejects.toThrow(/เลขอ้างอิง/);
    await expect(repo.payments.findByApplicationId(id)).resolves.toEqual([]);
  });

  it('keeps a transaction reference unique across applications', async () => {
    const repo = repository();
    const first = await ready(repo);
    const second = await ready(repo, OTHER_TEST_CITIZEN_ID);
    const { service } = harness(repo);
    await service.request(first);
    await service.request(second);
    await service.approve(first, 'SHARED-BANK-REF', 'manager@example.test');

    await expect(
      service.approve(second, 'SHARED-BANK-REF', 'manager@example.test'),
    ).rejects.toThrow(/ถูกใช้/);
    await expect(repo.applications.findById(second)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
  });
});
