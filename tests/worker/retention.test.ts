import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runRetention } from '../../src/worker/services/retention';

const NOW = new Date('2035-01-15T02:17:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function yearsAgo(years: number): string {
  const value = new Date(NOW);
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString();
}

async function insertApplication(input: {
  id: string;
  status: 'DRAFT' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'REFUNDED';
  updatedAt: string;
  photoKey?: string;
  piiErasedAt?: string;
  retentionHoldUntil?: string;
}): Promise<void> {
  await env.DB.prepare(
    `insert into applications (
       id, reference_no, citizen_id_hash, citizen_id_ciphertext,
       title, first_name, last_name, birth_date, phone, email, callsign,
       photo_key, photo_source, photo_uploaded_at, status,
       nbtc_recorded_by, access_token_hash, created_at, updated_at,
       pii_erased_at, retention_hold_until
     ) values (?, ?, ?, ?, 'นาย', 'ทดสอบ', 'ระบบ', '1990-01-01',
               '0800000000', 'applicant@example.test', 'HS0TST',
               ?, ?, ?, ?, 'manager@example.test', 'capability-hash', ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      `VRA-${input.id}`,
      input.piiErasedAt ? '' : `citizen-hash-${input.id}`,
      input.piiErasedAt ? '' : `ciphertext-${input.id}`,
      input.photoKey ?? null,
      input.photoKey ? 'UPLOAD' : null,
      input.photoKey ? input.updatedAt : null,
      input.status,
      input.updatedAt,
      input.updatedAt,
      input.piiErasedAt ?? null,
      input.retentionHoldUntil ?? null,
    )
    .run();

  if (input.photoKey) await env.MEMBER_PHOTOS.put(input.photoKey, 'test-only-photo');
}

async function insertPersonalChildren(applicationId: string, createdAt: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `insert into addresses (
         id, application_id, id_address, mail_same_as_id, mail_recipient,
         mail_address, created_at, updated_at
       ) values (?, ?, '123 ถนนทดสอบ', 1, 'ผู้รับทดสอบ', '123 ถนนทดสอบ', ?, ?)`,
    ).bind(`address-${applicationId}`, applicationId, createdAt, createdAt),
    env.DB.prepare(
      `insert into emails (
         id, application_id, type, recipient, provider, provider_email_id,
         status, created_at, updated_at
       ) values (?, ?, 'RECEIPT', 'applicant@example.test', 'resend', ?,
                 'DELIVERED', ?, ?)`,
    ).bind(
      `email-${applicationId}`,
      applicationId,
      `provider-${applicationId}`,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `insert into application_events (
         id, application_id, event_type, actor_type, actor_id, created_at
       ) values (?, ?, 'STATUS_CHANGED', 'MANAGER', 'manager@example.test', ?)`,
    ).bind(`event-${applicationId}`, applicationId, createdAt),
  ]);
}

async function insertAccountingRecord(applicationId: string, issuedAt: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `insert into payments (
         id, application_id, provider, transaction_ref, amount,
         receiver_matched, amount_matched, verification_status, verified_at, created_at
       ) values (?, ?, 'slipok', ?, 50000, 1, 1, 'VERIFIED', ?, ?)`,
    ).bind(
      `payment-${applicationId}`,
      applicationId,
      `transaction-${applicationId}`,
      issuedAt,
      issuedAt,
    ),
    env.DB.prepare(
      `insert into receipts (id, application_id, payment_id, receipt_no, amount, issued_at)
       values (?, ?, ?, ?, 50000, ?)`,
    ).bind(
      `receipt-${applicationId}`,
      applicationId,
      `payment-${applicationId}`,
      `RC-${applicationId}`,
      issuedAt,
    ),
  ]);
}

describe('production retention lifecycle', () => {
  it('deletes an abandoned unpaid application and its private photo after 30 days', async () => {
    await insertApplication({
      id: 'abandoned',
      status: 'DRAFT',
      updatedAt: daysAgo(31),
      photoKey: 'member-photos/abandoned.jpg',
    });
    await insertPersonalChildren('abandoned', daysAgo(31));

    const result = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });

    expect(result).toEqual({ abandonedDeleted: 1, piiErased: 0, recordsDeleted: 0 });
    expect(
      await env.DB.prepare("select id from applications where id = 'abandoned'").first(),
    ).toBeNull();
    expect(await env.MEMBER_PHOTOS.get('member-photos/abandoned.jpg')).toBeNull();
  });

  it('keeps a stale in-progress application when a verified payment exists', async () => {
    await insertApplication({
      id: 'paid-in-progress',
      status: 'AWAITING_PAYMENT',
      updatedAt: daysAgo(60),
    });
    await insertAccountingRecord('paid-in-progress', daysAgo(60));

    const result = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });

    expect(result.abandonedDeleted).toBe(0);
    expect(
      await env.DB.prepare("select id from applications where id = 'paid-in-progress'").first(),
    ).not.toBeNull();
  });

  it('does not erase a record covered by an active legal or investigation hold', async () => {
    await insertApplication({
      id: 'held',
      status: 'COMPLETED',
      updatedAt: yearsAgo(8),
      photoKey: 'member-photos/held.jpg',
      retentionHoldUntil: '2036-01-15T00:00:00.000Z',
    });

    const result = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });

    expect(result).toEqual({ abandonedDeleted: 0, piiErased: 0, recordsDeleted: 0 });
    expect(
      await env.DB.prepare("select id from applications where id = 'held'").first(),
    ).not.toBeNull();
    expect(await env.MEMBER_PHOTOS.get('member-photos/held.jpg')).not.toBeNull();
  });

  it('erases restricted PII after 90 days but keeps the accounting record', async () => {
    await insertApplication({
      id: 'completed',
      status: 'COMPLETED',
      updatedAt: daysAgo(91),
      photoKey: 'member-photos/completed.jpg',
    });
    await insertPersonalChildren('completed', daysAgo(91));
    await insertAccountingRecord('completed', daysAgo(91));

    const first = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });
    const second = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });

    expect(first).toEqual({ abandonedDeleted: 0, piiErased: 1, recordsDeleted: 0 });
    expect(second).toEqual({ abandonedDeleted: 0, piiErased: 0, recordsDeleted: 0 });

    const application = await env.DB.prepare(
      `select reference_no, status, citizen_id_hash, citizen_id_ciphertext,
              first_name, email, photo_key, access_token_hash, pii_erased_at
       from applications where id = 'completed'`,
    ).first<Record<string, unknown>>();
    expect(application).toMatchObject({
      reference_no: 'VRA-completed',
      status: 'COMPLETED',
      citizen_id_hash: '',
      citizen_id_ciphertext: '',
      first_name: null,
      email: null,
      photo_key: null,
      access_token_hash: null,
      pii_erased_at: NOW.toISOString(),
    });

    expect(
      await env.DB.prepare("select id from addresses where application_id = 'completed'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "select recipient, provider_email_id from emails where application_id = 'completed'",
      ).first(),
    ).toEqual({ recipient: '', provider_email_id: null });
    expect(
      await env.DB.prepare(
        "select actor_id from application_events where id = 'event-completed'",
      ).first(),
    ).toEqual({ actor_id: null });
    expect(
      await env.DB.prepare(
        "select count(*) as count from application_events where application_id = 'completed' and event_type = 'PII_ERASED'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("select id from receipts where application_id = 'completed'").first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("select id from payments where application_id = 'completed'").first(),
    ).not.toBeNull();
    expect(await env.MEMBER_PHOTOS.get('member-photos/completed.jpg')).toBeNull();
  });

  it('deletes the remaining anonymized record after seven years', async () => {
    await insertApplication({
      id: 'expired',
      status: 'COMPLETED',
      updatedAt: yearsAgo(8),
      piiErasedAt: yearsAgo(7),
    });
    await insertAccountingRecord('expired', yearsAgo(8));

    const result = await runRetention(env.DB, env.MEMBER_PHOTOS, { now: NOW });

    expect(result).toEqual({ abandonedDeleted: 0, piiErased: 0, recordsDeleted: 1 });
    expect(
      await env.DB.prepare("select id from applications where id = 'expired'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("select id from payments where application_id = 'expired'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("select id from receipts where application_id = 'expired'").first(),
    ).toBeNull();
  });
});
