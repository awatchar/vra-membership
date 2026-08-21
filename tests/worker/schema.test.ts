import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createCitizenIdProtection } from '../../src/worker/lib/crypto';
import { repository, seedApplication, TEST_CITIZEN_ID, TEST_KEY } from '../support/fixtures';

/**
 * Schema-level guarantees. These assert against the real migration SQL, because
 * a constraint that only exists in application code is not a constraint.
 */

describe('core tables', () => {
  it('creates every table the workflow needs', async () => {
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' order by name",
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'addresses',
        'application_events',
        'applications',
        'emails',
        'payments',
        'receipts',
      ]),
    );
  });

  it('is idempotent to re-apply, so a redeploy cannot fail on migrations', async () => {
    const { results } = await env.DB.prepare('select count(*) as applied from d1_migrations').all<{
      applied: number;
    }>();

    expect(results[0]!.applied).toBeGreaterThan(0);
  });
});

describe('data minimisation', () => {
  it('has no column for data the membership process does not need', async () => {
    const { results } = await env.DB.prepare(
      "select name from pragma_table_info('applications')",
    ).all<{ name: string }>();
    const columns = results.map((row) => row.name);

    // Issue #1 section 8: religion, images, raw provider payloads, bounding
    // boxes and debug output must not be storable at all.
    for (const forbidden of [
      'religion',
      'gender',
      'card_issue_date',
      'id_card_image',
      'raw_ocr_response',
      'bounding_boxes',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('never provides a place to store the citizen ID in clear text', async () => {
    const { results } = await env.DB.prepare(
      "select name from pragma_table_info('applications')",
    ).all<{ name: string }>();
    const columns = results.map((row) => row.name);

    expect(columns).toContain('citizen_id_hash');
    expect(columns).toContain('citizen_id_ciphertext');
    expect(columns).not.toContain('citizen_id');
  });

  it('has no postcode on the ID-card address, which carries none', async () => {
    const { results } = await env.DB.prepare(
      "select name from pragma_table_info('addresses')",
    ).all<{ name: string }>();
    const columns = results.map((row) => row.name);

    expect(columns).not.toContain('id_postcode');
    expect(columns).toContain('mail_postcode');
  });

  it('has no column for a slip image on payments', async () => {
    const { results } = await env.DB.prepare("select name from pragma_table_info('payments')").all<{
      name: string;
    }>();
    const columns = results.map((row) => row.name);

    for (const forbidden of ['slip_image', 'slip_url', 'raw_response']) {
      expect(columns).not.toContain(forbidden);
    }
  });
});

describe('uniqueness guarantees', () => {
  it('rejects a duplicate transaction reference at the database level', async () => {
    const repo = repository();
    const firstApplication = await seedApplication(repo);
    const secondApplication = await seedApplication(repo, '1234567890139');

    const payment = {
      provider: 'slipok',
      transactionRef: 'DUPLICATE-REF-0001',
      amountSatang: 50_000,
      sendingBank: 'BBL',
      receivingBank: 'KBANK',
      receiverAccountDigits: '1234',
      transactionAt: '2026-01-02T03:04:05.000Z',
      receiverMatched: true,
      amountMatched: true,
      verificationStatus: 'VERIFIED' as const,
      verifiedAt: '2026-01-02T03:04:06.000Z',
    };

    await repo.payments.create({ ...payment, applicationId: firstApplication });

    await expect(
      env.DB.prepare(
        `insert into payments (
           id, application_id, provider, transaction_ref, amount,
           verification_status, created_at
         ) values (?, ?, 'slipok', ?, 50000, 'VERIFIED', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          secondApplication,
          payment.transactionRef,
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('rejects a duplicate receipt number at the database level', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    const payment = await repo.payments.create({
      applicationId,
      provider: 'slipok',
      transactionRef: `REF-${crypto.randomUUID()}`,
      amountSatang: 50_000,
      sendingBank: null,
      receivingBank: null,
      receiverAccountDigits: null,
      transactionAt: null,
      receiverMatched: true,
      amountMatched: true,
      verificationStatus: 'VERIFIED',
      verifiedAt: null,
    });

    await repo.receipts.create({
      applicationId,
      paymentId: payment.id,
      receiptNo: 'VRA-RC-2569-000001',
      amountSatang: 50_000,
      issuedAt: new Date().toISOString(),
    });

    const otherApplication = await seedApplication(repo, '1234567890139');
    const otherPayment = await repo.payments.create({
      applicationId: otherApplication,
      provider: 'slipok',
      transactionRef: `REF-${crypto.randomUUID()}`,
      amountSatang: 50_000,
      sendingBank: null,
      receivingBank: null,
      receiverAccountDigits: null,
      transactionAt: null,
      receiverMatched: true,
      amountMatched: true,
      verificationStatus: 'VERIFIED',
      verifiedAt: null,
    });

    await expect(
      repo.receipts.create({
        applicationId: otherApplication,
        paymentId: otherPayment.id,
        receiptNo: 'VRA-RC-2569-000001',
        amountSatang: 50_000,
        issuedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/receipt_no/);
  });

  it('rejects a second email of the same type for one application', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);
    await repo.emails.create({
      applicationId,
      type: 'RECEIPT',
      recipient: 'applicant@example.test',
      provider: 'resend',
    });

    // Two callers can both read "no receipt email yet" before either writes
    // one. A retry reuses the existing row, so a second row of the same type is
    // always that race rather than a legitimate second message.
    await expect(
      repo.emails.create({
        applicationId,
        type: 'RECEIPT',
        recipient: 'applicant@example.test',
        provider: 'resend',
      }),
    ).rejects.toThrow(/application_id/);
  });

  it('allows different email types for one application', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    for (const type of ['RECEIPT', 'MANAGER_NEW_APPLICATION', 'MEMBER_PROCESSING'] as const) {
      await expect(
        repo.emails.create({
          applicationId,
          type,
          recipient: 'someone@example.test',
          provider: 'resend',
        }),
      ).resolves.toMatchObject({ type });
    }
  });

  it('allows the same person to have more than one application', async () => {
    const repo = repository();
    await seedApplication(repo, TEST_CITIZEN_ID);
    await seedApplication(repo, TEST_CITIZEN_ID);

    const protection = await createCitizenIdProtection(TEST_KEY);
    const ids = await repo.applications.findIdsByCitizenIdHash(
      await protection.hash(TEST_CITIZEN_ID),
    );

    // Renewals are a planned extension (Issue #1 section 79), so the citizen ID
    // hash is indexed but not unique.
    expect(ids).toHaveLength(2);
  });
});

describe('value constraints', () => {
  it('rejects an unknown application status', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      env.DB.prepare('update applications set status = ? where id = ?')
        .bind('NOT_A_STATUS', applicationId)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('accepts the five-year term and rejects an unknown canonical membership type', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      repo.applications.setMembership(applicationId, 'FIVE_YEAR', 50_000),
    ).resolves.toBeUndefined();
    await expect(repo.applications.findById(applicationId)).resolves.toMatchObject({
      membershipType: 'FIVE_YEAR',
      membershipAmountSatang: 50_000,
    });

    await expect(
      env.DB.prepare('update applications set membership_term = ? where id = ?')
        .bind('MONTHLY', applicationId)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('rejects a non-positive payment amount', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      env.DB.prepare(
        `insert into payments (
           id, application_id, provider, transaction_ref, amount,
           verification_status, created_at
         ) values (?, ?, 'slipok', ?, 0, 'VERIFIED', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          applicationId,
          `REF-${crypto.randomUUID()}`,
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('rejects a malformed postcode', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      repo.addresses.upsert(applicationId, {
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
        mailPostcode: '1234',
        mailPhone: null,
      }),
    ).rejects.toThrow(/CHECK/i);
  });

  it('rejects an unknown email type and status', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await expect(
      env.DB.prepare(
        `insert into emails (
           id, application_id, type, recipient, provider, status, created_at, updated_at
         ) values (?, ?, 'NEWSLETTER', 'member@example.test', 'resend', 'QUEUED', ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          applicationId,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        )
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});

describe('referential integrity', () => {
  it('cascades deletes so removing an application leaves nothing behind', async () => {
    const repo = repository();
    const applicationId = await seedApplication(repo);

    await repo.addresses.upsert(applicationId, {
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
    });
    await repo.events.append({
      applicationId,
      eventType: 'APPLICATION_CREATED',
      actorType: 'APPLICANT',
    });

    await env.DB.prepare('pragma foreign_keys = on').run();
    await env.DB.prepare('delete from applications where id = ?').bind(applicationId).run();

    await expect(repo.addresses.findByApplicationId(applicationId)).resolves.toBeNull();
    await expect(repo.events.listByApplicationId(applicationId)).resolves.toEqual([]);
  });
});
