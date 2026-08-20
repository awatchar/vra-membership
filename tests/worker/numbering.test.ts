import { describe, expect, it } from 'vitest';
import { UniqueConstraintError } from '../../src/worker/db';
import type { PaymentInput, Repository } from '../../src/worker/db';
import {
  createNumberingService,
  DEFAULT_APPLICATION_FORMAT,
  DEFAULT_RECEIPT_FORMAT,
  formatNumber,
  NumberingError,
  parseSequence,
} from '../../src/worker/services/numbering';
import {
  ANNUAL_SATANG,
  OTHER_TEST_CITIZEN_ID,
  repository,
  seedApplication,
  TEST_CITIZEN_ID,
} from '../support/fixtures';

/** 2026-08-20 in Bangkok, which is Buddhist year 2569. */
const IN_2569 = new Date('2026-08-20T03:00:00.000Z');
/** 2027-01-01T00:00 Bangkok, one second into Buddhist year 2570. */
const IN_2570 = new Date('2026-12-31T17:00:00.000Z');

function numbering(repo: Repository, now: () => Date = () => IN_2569) {
  return createNumberingService(repo, { now });
}

function paymentInput(applicationId: string): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `REF-${crypto.randomUUID()}`,
    amountSatang: ANNUAL_SATANG,
    sendingBank: null,
    receivingBank: null,
    receiverAccountTail: null,
    transactionAt: null,
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: null,
  };
}

describe('formatNumber', () => {
  it('produces the documented application format', () => {
    expect(formatNumber(DEFAULT_APPLICATION_FORMAT, 2569, 1)).toBe('VRA-2569-000001');
  });

  it('produces the documented receipt format', () => {
    expect(formatNumber(DEFAULT_RECEIPT_FORMAT, 2569, 91)).toBe('VRA-RC-2569-000091');
  });

  it('pads to the configured width', () => {
    expect(formatNumber({ prefix: 'VRA', sequenceLength: 4 }, 2569, 7)).toBe('VRA-2569-0007');
  });

  it('does not truncate a sequence longer than the padding', () => {
    expect(formatNumber(DEFAULT_APPLICATION_FORMAT, 2569, 1_234_567)).toBe('VRA-2569-1234567');
  });
});

describe('parseSequence', () => {
  it('reads the sequence back', () => {
    expect(parseSequence(DEFAULT_APPLICATION_FORMAT, 'VRA-2569-000042', 2569)).toBe(42);
  });

  it('returns 0 for a number from a different year', () => {
    expect(parseSequence(DEFAULT_APPLICATION_FORMAT, 'VRA-2568-000042', 2569)).toBe(0);
  });

  it('returns 0 for a number from a different prefix', () => {
    expect(parseSequence(DEFAULT_APPLICATION_FORMAT, 'VRA-RC-2569-000042', 2569)).toBe(0);
  });

  it('returns 0 rather than NaN for a malformed value', () => {
    expect(parseSequence(DEFAULT_APPLICATION_FORMAT, 'VRA-2569-abcdef', 2569)).toBe(0);
    expect(parseSequence(DEFAULT_APPLICATION_FORMAT, null, 2569)).toBe(0);
  });
});

describe('format validation', () => {
  it('rejects a prefix containing a like wildcard', () => {
    const repo = repository();

    // A `%` would make the year pattern match every number ever issued.
    expect(() =>
      createNumberingService(repo, { applicationFormat: { prefix: 'VRA%', sequenceLength: 6 } }),
    ).toThrow(NumberingError);
    expect(() =>
      createNumberingService(repo, { applicationFormat: { prefix: 'VRA_', sequenceLength: 6 } }),
    ).toThrow(NumberingError);
  });

  it('rejects a lowercase or empty prefix', () => {
    const repo = repository();

    expect(() =>
      createNumberingService(repo, { applicationFormat: { prefix: 'vra', sequenceLength: 6 } }),
    ).toThrow(NumberingError);
    expect(() =>
      createNumberingService(repo, { applicationFormat: { prefix: '', sequenceLength: 6 } }),
    ).toThrow(NumberingError);
  });

  it('rejects a non-positive sequence length', () => {
    const repo = repository();

    expect(() =>
      createNumberingService(repo, { receiptFormat: { prefix: 'VRA-RC', sequenceLength: 0 } }),
    ).toThrow(NumberingError);
  });
});

describe('application numbers', () => {
  it('issues the first number of the year', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(numbering(repo).assignApplicationNumber(id)).resolves.toBe('VRA-2569-000001');
  });

  it('increments for each application', async () => {
    const repo = repository();
    const service = numbering(repo);
    const first = await seedApplication(repo, TEST_CITIZEN_ID);
    const second = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);

    await expect(service.assignApplicationNumber(first)).resolves.toBe('VRA-2569-000001');
    await expect(service.assignApplicationNumber(second)).resolves.toBe('VRA-2569-000002');
  });

  it('returns the existing number instead of issuing a second one', async () => {
    const repo = repository();
    const service = numbering(repo);
    const id = await seedApplication(repo);

    const first = await service.assignApplicationNumber(id);
    const second = await service.assignApplicationNumber(id);

    expect(second).toBe(first);
  });

  it('restarts the sequence in a new Buddhist year', async () => {
    const repo = repository();
    let now = IN_2569;
    const service = numbering(repo, () => now);

    const inOldYear = await seedApplication(repo, TEST_CITIZEN_ID);
    await expect(service.assignApplicationNumber(inOldYear)).resolves.toBe('VRA-2569-000001');

    now = IN_2570;
    const inNewYear = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    await expect(service.assignApplicationNumber(inNewYear)).resolves.toBe('VRA-2570-000001');
  });

  it('keeps counting within the year after a rollover', async () => {
    const repo = repository();
    let now = IN_2570;
    const service = numbering(repo, () => now);

    const first = await seedApplication(repo, TEST_CITIZEN_ID);
    await service.assignApplicationNumber(first);

    now = new Date('2027-06-01T03:00:00.000Z');
    const second = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    await expect(service.assignApplicationNumber(second)).resolves.toBe('VRA-2570-000002');
  });

  it('gives concurrent applications distinct numbers', async () => {
    const repo = repository();
    const service = numbering(repo);
    const ids = await Promise.all([
      seedApplication(repo, TEST_CITIZEN_ID),
      seedApplication(repo, OTHER_TEST_CITIZEN_ID),
      seedApplication(repo, '1234567890147'),
      seedApplication(repo, '1234567890154'),
      seedApplication(repo, '1234567890162'),
    ]);

    const numbers = await Promise.all(ids.map((id) => service.assignApplicationNumber(id)));

    expect(new Set(numbers).size).toBe(ids.length);
    expect([...numbers].sort()).toEqual([
      'VRA-2569-000001',
      'VRA-2569-000002',
      'VRA-2569-000003',
      'VRA-2569-000004',
      'VRA-2569-000005',
    ]);
  });

  it('gives one number to an application asked for concurrently', async () => {
    const repo = repository();
    const service = numbering(repo);
    const id = await seedApplication(repo);

    const numbers = await Promise.all(
      Array.from({ length: 5 }, () => service.assignApplicationNumber(id)),
    );

    expect(new Set(numbers).size).toBe(1);
  });

  it('fails clearly for an application that does not exist', async () => {
    const repo = repository();

    await expect(numbering(repo).assignApplicationNumber(crypto.randomUUID())).rejects.toThrow(
      NumberingError,
    );
  });

  it('ignores numbers stored in an older format when picking the next one', async () => {
    const repo = repository();
    const service = numbering(repo);
    const legacy = await seedApplication(repo, TEST_CITIZEN_ID);
    await repo.applications.setReferenceNo(legacy, 'VRA-2569-OLD');

    const next = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);

    await expect(service.assignApplicationNumber(next)).resolves.toBe('VRA-2569-000001');
  });
});

describe('receipt numbers', () => {
  async function seedPayment(repo: Repository, citizenId = TEST_CITIZEN_ID) {
    const applicationId = await seedApplication(repo, citizenId);
    const payment = await repo.payments.create(paymentInput(applicationId));
    return { applicationId, paymentId: payment.id };
  }

  it('issues the first receipt number of the year', async () => {
    const repo = repository();
    const service = numbering(repo);
    const { applicationId, paymentId } = await seedPayment(repo);

    const receipt = await service.issueReceiptNumber((receiptNo) =>
      repo.receipts.create({
        applicationId,
        paymentId,
        receiptNo,
        amountSatang: ANNUAL_SATANG,
        issuedAt: IN_2569.toISOString(),
      }),
    );

    expect(receipt.receiptNo).toBe('VRA-RC-2569-000001');
  });

  it('increments for each receipt', async () => {
    const repo = repository();
    const service = numbering(repo);

    const numbers: string[] = [];
    for (const citizenId of [TEST_CITIZEN_ID, OTHER_TEST_CITIZEN_ID]) {
      const { applicationId, paymentId } = await seedPayment(repo, citizenId);
      const receipt = await service.issueReceiptNumber((receiptNo) =>
        repo.receipts.create({
          applicationId,
          paymentId,
          receiptNo,
          amountSatang: ANNUAL_SATANG,
          issuedAt: IN_2569.toISOString(),
        }),
      );
      numbers.push(receipt.receiptNo);
    }

    expect(numbers).toEqual(['VRA-RC-2569-000001', 'VRA-RC-2569-000002']);
  });

  it('gives concurrent receipts distinct numbers', async () => {
    const repo = repository();
    const service = numbering(repo);
    const seeds = [];
    for (const citizenId of [
      TEST_CITIZEN_ID,
      OTHER_TEST_CITIZEN_ID,
      '1234567890147',
      '1234567890154',
    ]) {
      seeds.push(await seedPayment(repo, citizenId));
    }

    const receipts = await Promise.all(
      seeds.map(({ applicationId, paymentId }) =>
        service.issueReceiptNumber((receiptNo) =>
          repo.receipts.create({
            applicationId,
            paymentId,
            receiptNo,
            amountSatang: ANNUAL_SATANG,
            issuedAt: IN_2569.toISOString(),
          }),
        ),
      ),
    );

    const numbers = receipts.map((receipt) => receipt.receiptNo);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('restarts the receipt sequence in a new Buddhist year', async () => {
    const repo = repository();
    let now = IN_2569;
    const service = numbering(repo, () => now);

    const first = await seedPayment(repo, TEST_CITIZEN_ID);
    await service.issueReceiptNumber((receiptNo) =>
      repo.receipts.create({
        applicationId: first.applicationId,
        paymentId: first.paymentId,
        receiptNo,
        amountSatang: ANNUAL_SATANG,
        issuedAt: IN_2569.toISOString(),
      }),
    );

    now = IN_2570;
    const second = await seedPayment(repo, OTHER_TEST_CITIZEN_ID);
    const receipt = await service.issueReceiptNumber((receiptNo) =>
      repo.receipts.create({
        applicationId: second.applicationId,
        paymentId: second.paymentId,
        receiptNo,
        amountSatang: ANNUAL_SATANG,
        issuedAt: IN_2570.toISOString(),
      }),
    );

    expect(receipt.receiptNo).toBe('VRA-RC-2570-000001');
  });

  it('stops instead of looping when a different constraint fails', async () => {
    const repo = repository();
    const service = numbering(repo);
    const { applicationId, paymentId } = await seedPayment(repo);

    const insert = (receiptNo: string) =>
      repo.receipts.create({
        applicationId,
        paymentId,
        receiptNo,
        amountSatang: ANNUAL_SATANG,
        issuedAt: IN_2569.toISOString(),
      });

    await service.issueReceiptNumber(insert);

    // The second receipt violates the one-receipt-per-application and
    // one-receipt-per-payment constraints, not receipt_no, so retrying with a
    // fresh number would fail identically forever.
    const error = await service.issueReceiptNumber(insert).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).constraintName).not.toContain('receipt_no');
  });

  it('propagates an error that is not a constraint violation', async () => {
    const repo = repository();
    const service = numbering(repo);

    await expect(
      service.issueReceiptNumber(() => Promise.reject(new Error('provider exploded'))),
    ).rejects.toThrow('provider exploded');
  });
});
