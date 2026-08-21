import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { UniqueConstraintError } from '../../src/worker/db';
import type { PaymentInput } from '../../src/worker/db';
import { createCitizenIdProtection } from '../../src/worker/lib/crypto';
import {
  FIVE_YEAR_SATANG,
  LIFETIME_SATANG,
  OTHER_TEST_CITIZEN_ID,
  repository,
  seedApplication,
  TEST_CITIZEN_ID,
  TEST_KEY,
} from '../support/fixtures';

function paymentInput(applicationId: string, overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `REF-${crypto.randomUUID()}`,
    amountSatang: FIVE_YEAR_SATANG,
    sendingBank: 'BBL',
    receivingBank: 'KBANK',
    receiverAccountDigits: '1234',
    transactionAt: '2026-01-02T03:04:05.000Z',
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: '2026-01-02T03:04:06.000Z',
    ...overrides,
  };
}

describe('applications', () => {
  it('creates an application in DRAFT with protected identity data', async () => {
    const repo = repository();
    const protection = await createCitizenIdProtection(TEST_KEY);

    const application = await repo.applications.create({
      citizenIdHash: await protection.hash(TEST_CITIZEN_ID),
      citizenIdCiphertext: await protection.encrypt(TEST_CITIZEN_ID),
      title: 'นาย',
      firstName: 'ทดสอบ',
      lastName: 'ระบบสมัคร',
    });

    expect(application.status).toBe('DRAFT');
    expect(application.referenceNo).toBeNull();
    expect(application.citizenIdCiphertext.startsWith('v1.')).toBe(true);
    await expect(protection.decrypt(application.citizenIdCiphertext)).resolves.toBe(
      TEST_CITIZEN_ID,
    );
  });

  it('returns a model, not a database row', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const application = await repo.applications.findById(id);

    expect(application).not.toBeNull();
    // Snake-case column names must not leak into the rest of the application.
    expect(Object.keys(application!)).not.toContain('citizen_id_hash');
    expect(application!.citizenIdHash).toBeTypeOf('string');
  });

  it('returns null for an unknown id instead of throwing', async () => {
    const repo = repository();
    await expect(repo.applications.findById(crypto.randomUUID())).resolves.toBeNull();
  });

  it('finds applications by citizen ID hash without knowing the number', async () => {
    const repo = repository();
    const protection = await createCitizenIdProtection(TEST_KEY);
    const mine = await seedApplication(repo, TEST_CITIZEN_ID);
    await seedApplication(repo, OTHER_TEST_CITIZEN_ID);

    await expect(
      repo.applications.findIdsByCitizenIdHash(await protection.hash(TEST_CITIZEN_ID)),
    ).resolves.toEqual([mine]);
  });

  it('updates contact details without touching identity data', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const before = await repo.applications.findById(id);

    await repo.applications.updateContact(id, {
      phone: '0800000000',
      email: 'member@example.test',
      callsign: 'HS0TEST',
    });

    const after = await repo.applications.findById(id);
    expect(after!.email).toBe('member@example.test');
    expect(after!.callsign).toBe('HS0TEST');
    expect(after!.citizenIdCiphertext).toBe(before!.citizenIdCiphertext);
  });

  it('records the membership type with the server-resolved amount', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await repo.applications.setMembership(id, 'LIFETIME', LIFETIME_SATANG);

    const application = await repo.applications.findById(id);
    expect(application!.membershipType).toBe('LIFETIME');
    expect(application!.membershipAmountSatang).toBe(LIFETIME_SATANG);
  });

  it('stores the photo key and source', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const key = `member-photos/${crypto.randomUUID()}.jpg`;

    await repo.applications.setPhoto(id, { key, source: 'ID_CARD' });

    const application = await repo.applications.findById(id);
    expect(application!.photoKey).toBe(key);
    expect(application!.photoSource).toBe('ID_CARD');
    expect(application!.photoUploadedAt).not.toBeNull();
  });

  it('bumps updated_at on every write', async () => {
    const times = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'];
    let index = 0;
    const repo = repository({ now: () => new Date(times[Math.min(index, times.length - 1)]!) });

    const id = await seedApplication(repo);
    index = 1;
    await repo.applications.updateContact(id, { email: 'member@example.test' });

    const application = await repo.applications.findById(id);
    expect(application!.createdAt).toBe(times[0]);
    expect(application!.updatedAt).toBe(times[1]);
  });
});

describe('application numbering', () => {
  it('assigns a reference number once', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await repo.applications.setReferenceNo(id, 'VRA-2569-000001');

    await expect(repo.applications.findByReferenceNo('VRA-2569-000001')).resolves.toMatchObject({
      id,
    });
  });

  it('refuses to overwrite a reference number that may already be on a document', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.setReferenceNo(id, 'VRA-2569-000001');

    await expect(repo.applications.setReferenceNo(id, 'VRA-2569-000002')).rejects.toThrow(
      UniqueConstraintError,
    );
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      referenceNo: 'VRA-2569-000001',
    });
  });

  it('rejects a reference number already taken by another application', async () => {
    const repo = repository();
    const first = await seedApplication(repo, TEST_CITIZEN_ID);
    const second = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    await repo.applications.setReferenceNo(first, 'VRA-2569-000001');

    await expect(repo.applications.setReferenceNo(second, 'VRA-2569-000001')).rejects.toThrow(
      UniqueConstraintError,
    );
  });

  it('lets only one of several concurrent claims win', async () => {
    const repo = repository();
    const ids = await Promise.all([
      seedApplication(repo, TEST_CITIZEN_ID),
      seedApplication(repo, OTHER_TEST_CITIZEN_ID),
      seedApplication(repo, '1234567890147'),
    ]);

    const outcomes = await Promise.allSettled(
      ids.map((id) => repo.applications.setReferenceNo(id, 'VRA-2569-000001')),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const { results } = await env.DB.prepare(
      'select count(*) as taken from applications where reference_no = ?',
    )
      .bind('VRA-2569-000001')
      .all<{ taken: number }>();
    expect(results[0]!.taken).toBe(1);
  });
});

describe('status transitions', () => {
  it('applies a transition from an allowed state', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(repo.applications.updateStatusIf(id, ['DRAFT'], 'AWAITING_PAYMENT')).resolves.toBe(
      true,
    );
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
  });

  it('refuses a transition from a state that is not allowed', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(repo.applications.updateStatusIf(id, ['SUBMITTED'], 'COMPLETED')).resolves.toBe(
      false,
    );
    await expect(repo.applications.findById(id)).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('lets exactly one concurrent transition win', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.applications.updateStatusIf(id, ['DRAFT'], 'AWAITING_PAYMENT'),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('records the timestamps that belong to a transition', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await repo.applications.updateStatusIf(id, ['DRAFT'], 'SUBMITTED', {
      submittedAt: '2026-03-04T05:06:07.000Z',
    });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'SUBMITTED',
      submittedAt: '2026-03-04T05:06:07.000Z',
    });
  });

  it('never clears a timestamp that was already recorded', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.updateStatusIf(id, ['DRAFT'], 'SUBMITTED', {
      submittedAt: '2026-03-04T05:06:07.000Z',
    });

    await repo.applications.updateStatusIf(id, ['SUBMITTED'], 'MANAGER_NOTIFIED');

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      submittedAt: '2026-03-04T05:06:07.000Z',
    });
  });

  it('records who confirmed the NBTC entry', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.updateStatusIf(id, ['DRAFT'], 'NBTC_PROCESSING');

    await repo.applications.updateStatusIf(id, ['NBTC_PROCESSING'], 'NBTC_RECORDED', {
      nbtcRecordedAt: '2026-04-05T06:07:08.000Z',
      nbtcRecordedBy: 'manager@example.test',
    });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'NBTC_RECORDED',
      nbtcRecordedAt: '2026-04-05T06:07:08.000Z',
      nbtcRecordedBy: 'manager@example.test',
    });
  });
});

describe('listing for the admin dashboard', () => {
  it('filters by status and returns newest first', async () => {
    let day = 1;
    const repo = repository({
      now: () => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`),
    });

    const first = await seedApplication(repo, TEST_CITIZEN_ID);
    day = 2;
    const second = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    day = 3;
    const third = await seedApplication(repo, '1234567890147');

    await repo.applications.updateStatusIf(first, ['DRAFT'], 'SUBMITTED');
    await repo.applications.updateStatusIf(second, ['DRAFT'], 'SUBMITTED');
    await repo.applications.updateStatusIf(third, ['DRAFT'], 'COMPLETED');

    const submitted = await repo.applications.list({ statuses: ['SUBMITTED'] });
    expect(submitted.map((application) => application.id)).toEqual([second, first]);
  });

  it('caps the page size so a caller cannot ask for the whole table', async () => {
    const repo = repository();
    await seedApplication(repo);

    await expect(repo.applications.list({ limit: 10_000 })).resolves.toHaveLength(1);
  });

  it('supports paging', async () => {
    const repo = repository();
    await seedApplication(repo, TEST_CITIZEN_ID);
    await seedApplication(repo, OTHER_TEST_CITIZEN_ID);

    const page = await repo.applications.list({ limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
  });
});

describe('addresses', () => {
  const address = {
    idAddress: '999 หมู่ 9',
    idSubdistrict: 'ตัวอย่าง',
    idDistrict: 'ตัวอย่าง',
    idProvince: 'กรุงเทพมหานคร',
    mailSameAsId: true,
    mailRecipient: null,
    mailAddress: null,
    mailSubdistrict: null,
    mailDistrict: null,
    mailProvince: null,
    mailPostcode: '10200',
    mailPhone: null,
  };

  it('keeps the ID-card address and the mailing address separate', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const record = await repo.addresses.upsert(id, {
      ...address,
      mailSameAsId: false,
      mailRecipient: 'ผู้รับทดสอบ',
      mailAddress: '1 ถนนตัวอย่าง',
      mailSubdistrict: 'ตัวอย่างสอง',
      mailDistrict: 'ตัวอย่างสอง',
      mailProvince: 'นนทบุรี',
      mailPostcode: '11000',
      mailPhone: '0800000000',
    });

    expect(record.idProvince).toBe('กรุงเทพมหานคร');
    expect(record.mailProvince).toBe('นนทบุรี');
    expect(record.mailSameAsId).toBe(false);
  });

  it('converts the SQLite integer flag to a boolean', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const record = await repo.addresses.upsert(id, address);
    expect(record.mailSameAsId).toBe(true);
  });

  it('replaces the existing record instead of creating a second one', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await repo.addresses.upsert(id, address);
    await repo.addresses.upsert(id, { ...address, mailPostcode: '50000' });

    const { results } = await env.DB.prepare(
      'select count(*) as rows from addresses where application_id = ?',
    )
      .bind(id)
      .all<{ rows: number }>();
    expect(results[0]!.rows).toBe(1);
    await expect(repo.addresses.findByApplicationId(id)).resolves.toMatchObject({
      mailPostcode: '50000',
    });
  });
});

describe('payments', () => {
  it('records a verified payment in satang', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const payment = await repo.payments.create(paymentInput(id));

    expect(payment.amountSatang).toBe(FIVE_YEAR_SATANG);
    expect(payment.receiverMatched).toBe(true);
    expect(payment.verificationStatus).toBe('VERIFIED');
  });

  it('rejects a reused transaction reference as a unique-constraint error', async () => {
    const repo = repository();
    const first = await seedApplication(repo, TEST_CITIZEN_ID);
    const second = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    const transactionRef = 'SHARED-REF-0001';

    await repo.payments.create(paymentInput(first, { transactionRef }));

    await expect(
      repo.payments.create(paymentInput(second, { transactionRef })),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('names the violated constraint without quoting the value', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const transactionRef = 'SECRET-LOOKING-REF-0002';
    await repo.payments.create(paymentInput(id, { transactionRef }));

    await repo.payments.create(paymentInput(id, { transactionRef })).catch((error: unknown) => {
      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect((error as UniqueConstraintError).constraintName).toContain('transaction_ref');
      expect((error as Error).message).not.toContain(transactionRef);
    });
  });

  it('lets exactly one of several concurrent slips claim a reference', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const transactionRef = 'RACE-REF-0001';

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => repo.payments.create(paymentInput(id, { transactionRef }))),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('finds a payment by transaction reference', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const created = await repo.payments.create(paymentInput(id));

    await expect(repo.payments.findByTransactionRef(created.transactionRef)).resolves.toMatchObject(
      { id: created.id },
    );
  });
});

describe('receipts', () => {
  async function seedPayment(): Promise<{ applicationId: string; paymentId: string }> {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const payment = await repo.payments.create(paymentInput(applicationId));
    return { applicationId, paymentId: payment.id };
  }

  it('issues a receipt for a payment', async () => {
    const repo = repository();
    const { applicationId, paymentId } = await seedPayment();

    const receipt = await repo.receipts.create({
      applicationId,
      paymentId,
      receiptNo: 'VRA-RC-2569-000091',
      amountSatang: FIVE_YEAR_SATANG,
      issuedAt: '2026-02-03T04:05:06.000Z',
    });

    expect(receipt.receiptNo).toBe('VRA-RC-2569-000091');
    expect(receipt.emailSentAt).toBeNull();
  });

  it('records the receipt email only once', async () => {
    const repo = repository();
    const { applicationId, paymentId } = await seedPayment();
    const receipt = await repo.receipts.create({
      applicationId,
      paymentId,
      receiptNo: 'VRA-RC-2569-000092',
      amountSatang: FIVE_YEAR_SATANG,
      issuedAt: '2026-02-03T04:05:06.000Z',
    });

    await repo.receipts.markEmailSent(receipt.id, '2026-02-03T04:10:00.000Z');
    await repo.receipts.markEmailSent(receipt.id, '2026-02-03T05:00:00.000Z');

    await expect(repo.receipts.findByApplicationId(applicationId)).resolves.toMatchObject({
      emailSentAt: '2026-02-03T04:10:00.000Z',
    });
  });

  it('refuses a second receipt for the same application', async () => {
    const repo = repository();
    const { applicationId, paymentId } = await seedPayment();
    await repo.receipts.create({
      applicationId,
      paymentId,
      receiptNo: 'VRA-RC-2569-000093',
      amountSatang: FIVE_YEAR_SATANG,
      issuedAt: '2026-02-03T04:05:06.000Z',
    });

    await expect(
      repo.receipts.create({
        applicationId,
        paymentId,
        receiptNo: 'VRA-RC-2569-000094',
        amountSatang: FIVE_YEAR_SATANG,
        issuedAt: '2026-02-03T04:05:06.000Z',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});

describe('emails', () => {
  it('starts a record in QUEUED and moves it to SENT with the provider id', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    const email = await repo.emails.create({
      applicationId,
      type: 'MANAGER_NEW_APPLICATION',
      recipient: 'manager@example.test',
      provider: 'resend',
    });
    expect(email.status).toBe('QUEUED');

    await repo.emails.markSent(email.id, 'provider-id-1', '2026-05-06T07:08:09.000Z');

    await expect(repo.emails.findByProviderEmailId('provider-id-1')).resolves.toMatchObject({
      id: email.id,
      status: 'SENT',
      sentAt: '2026-05-06T07:08:09.000Z',
    });
  });

  it('records only the first open, so a replayed webhook changes nothing', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const email = await repo.emails.create({
      applicationId,
      type: 'MANAGER_NEW_APPLICATION',
      recipient: 'manager@example.test',
      provider: 'resend',
    });

    const outcomes = [
      await repo.emails.recordFirstOpen(email.id, '2026-05-06T07:10:00.000Z'),
      await repo.emails.recordFirstOpen(email.id, '2026-05-06T08:00:00.000Z'),
      await repo.emails.recordFirstOpen(email.id, '2026-05-06T09:00:00.000Z'),
    ];

    expect(outcomes).toEqual([true, false, false]);
    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({
      firstOpenedAt: '2026-05-06T07:10:00.000Z',
    });
  });

  it('records only the first open even when opens arrive concurrently', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const email = await repo.emails.create({
      applicationId,
      type: 'MANAGER_NEW_APPLICATION',
      recipient: 'manager@example.test',
      provider: 'resend',
    });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => repo.emails.recordFirstOpen(email.id)),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('records only the first click', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const email = await repo.emails.create({
      applicationId,
      type: 'MANAGER_NEW_APPLICATION',
      recipient: 'manager@example.test',
      provider: 'resend',
    });

    await expect(repo.emails.recordFirstClick(email.id)).resolves.toBe(true);
    await expect(repo.emails.recordFirstClick(email.id)).resolves.toBe(false);
  });

  it('keeps the delivered timestamp stable across duplicate delivery events', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const email = await repo.emails.create({
      applicationId,
      type: 'RECEIPT',
      recipient: 'member@example.test',
      provider: 'resend',
    });

    await repo.emails.markDelivered(email.id, '2026-05-06T07:20:00.000Z');
    await repo.emails.markDelivered(email.id, '2026-05-06T09:20:00.000Z');

    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({
      status: 'DELIVERED',
      deliveredAt: '2026-05-06T07:20:00.000Z',
    });
  });

  it('lists the emails of one type for an application', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    await repo.emails.create({
      applicationId,
      type: 'RECEIPT',
      recipient: 'member@example.test',
      provider: 'resend',
    });
    await repo.emails.create({
      applicationId,
      type: 'MEMBER_PROCESSING',
      recipient: 'member@example.test',
      provider: 'resend',
    });

    await expect(
      repo.emails.findByApplicationIdAndType(applicationId, 'RECEIPT'),
    ).resolves.toHaveLength(1);
  });

  it('marks a send failure without losing the record', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const email = await repo.emails.create({
      applicationId,
      type: 'RECEIPT',
      recipient: 'member@example.test',
      provider: 'resend',
    });

    await repo.emails.markFailed(email.id);

    await expect(repo.emails.findById(email.id)).resolves.toMatchObject({ status: 'FAILED' });
  });
});

describe('audit events', () => {
  it('appends events in order', async () => {
    let second = 1;
    const repo = repository({
      now: () => new Date(`2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`),
    });
    const applicationId = await seedApplication(repo);

    second = 2;
    await repo.events.append({
      applicationId,
      eventType: 'APPLICATION_CREATED',
      actorType: 'APPLICANT',
    });
    second = 3;
    await repo.events.append({
      applicationId,
      eventType: 'PAYMENT_VERIFIED',
      actorType: 'SYSTEM',
      metadata: { amountSatang: FIVE_YEAR_SATANG },
    });

    const events = await repo.events.listByApplicationId(applicationId);
    expect(events.map((event) => event.eventType)).toEqual([
      'APPLICATION_CREATED',
      'PAYMENT_VERIFIED',
    ]);
    expect(events[1]!.metadata).toEqual({ amountSatang: FIVE_YEAR_SATANG });
  });

  it('drops metadata values that are not primitives', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await env.DB.prepare(
      `insert into application_events (
         id, application_id, event_type, metadata_json, actor_type, created_at
       ) values (?, ?, 'PAYMENT_VERIFIED', ?, 'SYSTEM', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        applicationId,
        JSON.stringify({ amountSatang: 50_000, providerResponse: { nested: 'payload' } }),
        '2026-01-01T00:00:00.000Z',
      )
      .run();

    const [event] = await repo.events.listByApplicationId(applicationId);
    expect(event!.metadata).toEqual({ amountSatang: 50_000 });
  });

  it('returns null metadata for a value that is not an object', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await env.DB.prepare(
      `insert into application_events (
         id, application_id, event_type, metadata_json, actor_type, created_at
       ) values (?, ?, 'PAYMENT_VERIFIED', '"not-an-object"', 'SYSTEM', ?)`,
    )
      .bind(crypto.randomUUID(), applicationId, '2026-01-01T00:00:00.000Z')
      .run();

    const [event] = await repo.events.listByApplicationId(applicationId);
    expect(event!.metadata).toBeNull();
  });

  it('reports whether an event already exists, for idempotent transitions', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      repo.events.existsForApplication(applicationId, 'MANAGER_EMAIL_OPENED'),
    ).resolves.toBe(false);

    await repo.events.append({
      applicationId,
      eventType: 'MANAGER_EMAIL_OPENED',
      actorType: 'PROVIDER',
    });

    await expect(
      repo.events.existsForApplication(applicationId, 'MANAGER_EMAIL_OPENED'),
    ).resolves.toBe(true);
  });
});

describe('list filtering guards', () => {
  it('treats an explicitly empty status filter as matching nothing', async () => {
    const repo = repository();
    await seedApplication(repo);

    // An admin UI that computed an empty filter set must not receive the whole
    // table of personal data.
    await expect(repo.applications.list({ statuses: [] })).resolves.toEqual([]);
    await expect(repo.applications.list()).resolves.toHaveLength(1);
  });
});

describe('timestamp consistency', () => {
  it('uses one timestamp per write so paired columns cannot disagree', async () => {
    let calls = 0;
    const repo = repository({
      now: () => {
        calls += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, calls));
      },
    });
    const id = await seedApplication(repo);

    await repo.applications.setPhoto(id, {
      key: `member-photos/${crypto.randomUUID()}.jpg`,
      source: 'UPLOAD',
    });

    const application = await repo.applications.findById(id);
    expect(application!.photoUploadedAt).toBe(application!.updatedAt);
  });
});
