/**
 * Automatic data retention for the production Cron Trigger.
 *
 * The policy has three independent stages:
 *
 * 1. Abandoned/unpaid applications are removed after 30 days.
 * 2. A completed or refunded application has restricted PII and its R2 photo
 *    erased after 90 days, while the minimal accounting record remains.
 * 3. The remaining record is removed after seven years. Seven years is the
 *    conservative upper retention window for Thai accounting evidence; PII is
 *    not kept for that window.
 *
 * Every operation is bounded and idempotent. R2 is deleted before D1 so a
 * transient bucket failure cannot leave an unreferenced private photo behind.
 * Repeating an R2 delete is safe if the database write failed afterwards.
 */

export interface RetentionPolicy {
  abandonedDays: number;
  piiDays: number;
  recordYears: number;
  batchSize: number;
}

export interface RetentionResult {
  abandonedDeleted: number;
  piiErased: number;
  recordsDeleted: number;
}

interface CandidateRow {
  id: string;
  photo_key: string | null;
}

const DEFAULT_POLICY: Readonly<RetentionPolicy> = {
  abandonedDays: 30,
  piiDays: 90,
  recordYears: 7,
  batchSize: 100,
};

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function yearsBefore(now: Date, years: number): string {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff.toISOString();
}

async function candidates(statement: D1PreparedStatement): Promise<CandidateRow[]> {
  const result = await statement.all<CandidateRow>();
  return result.results;
}

async function deletePhoto(bucket: R2Bucket, key: string | null): Promise<void> {
  if (key) await bucket.delete(key);
}

async function deleteApplications(
  db: D1Database,
  bucket: R2Bucket,
  rows: readonly CandidateRow[],
): Promise<number> {
  let deleted = 0;

  for (const row of rows) {
    await deletePhoto(bucket, row.photo_key);
    const result = await db.prepare('delete from applications where id = ?').bind(row.id).run();
    // D1 reports cascaded child deletes in `changes`, but the operational
    // metric is applications removed, not physical rows touched.
    if (result.meta.changes > 0) deleted += 1;
  }

  return deleted;
}

async function erasePii(
  db: D1Database,
  bucket: R2Bucket,
  rows: readonly CandidateRow[],
  erasedAt: string,
): Promise<number> {
  let erased = 0;

  for (const row of rows) {
    await deletePhoto(bucket, row.photo_key);

    const eventId = crypto.randomUUID();
    const [application] = await db.batch([
      db
        .prepare(
          `update applications set
             citizen_id_hash = '', citizen_id_ciphertext = '',
             title = null, first_name = null, last_name = null,
             first_name_en = null, last_name_en = null,
             birth_date = null, card_expiry_date = null,
             phone = null, email = null, callsign = null,
             photo_key = null, photo_source = null, photo_uploaded_at = null,
             nbtc_recorded_by = null, access_token_hash = null,
             pii_erased_at = ?
           where id = ? and pii_erased_at is null`,
        )
        .bind(erasedAt, row.id),
      db.prepare('delete from addresses where application_id = ?').bind(row.id),
      db
        .prepare(
          `update emails set recipient = '', provider_email_id = null
           where application_id = ?`,
        )
        .bind(row.id),
      db
        .prepare('update application_events set actor_id = null where application_id = ?')
        .bind(row.id),
      db
        .prepare(
          `insert into application_events (
             id, application_id, event_type, metadata_json, actor_type, actor_id, created_at
           )
           select ?, id, 'PII_ERASED', '{"policyVersion":1}', 'SYSTEM', null, ?
           from applications
           where id = ? and pii_erased_at = ?
             and not exists (
               select 1 from application_events
               where application_id = ? and event_type = 'PII_ERASED'
             )`,
        )
        .bind(eventId, erasedAt, row.id, erasedAt, row.id),
    ]);

    erased += application?.meta.changes ?? 0;
  }

  return erased;
}

export async function runRetention(
  db: D1Database,
  bucket: R2Bucket,
  options: { now?: Date; policy?: Partial<RetentionPolicy> } = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const policy = { ...DEFAULT_POLICY, ...options.policy };

  const abandonedCutoff = daysBefore(now, policy.abandonedDays);
  const piiCutoff = daysBefore(now, policy.piiDays);
  const recordCutoff = yearsBefore(now, policy.recordYears);
  const nowIso = now.toISOString();

  const abandoned = await candidates(
    db
      .prepare(
        `select id, photo_key from applications a
         where status in ('DRAFT', 'AWAITING_PAYMENT', 'CANCELLED', 'REJECTED')
           and updated_at < ?
           and (retention_hold_until is null or retention_hold_until < ?)
           and not exists (
             select 1 from payments p
             where p.application_id = a.id and p.verification_status = 'VERIFIED'
           )
         order by updated_at asc limit ?`,
      )
      .bind(abandonedCutoff, nowIso, policy.batchSize),
  );

  const toErase = await candidates(
    db
      .prepare(
        `select id, photo_key from applications
         where status in ('COMPLETED', 'REFUNDED')
           and pii_erased_at is null and updated_at < ?
           and (retention_hold_until is null or retention_hold_until < ?)
         order by updated_at asc limit ?`,
      )
      .bind(piiCutoff, nowIso, policy.batchSize),
  );

  const expiredRecords = await candidates(
    db
      .prepare(
        `select a.id, a.photo_key from applications a
         where a.status in ('COMPLETED', 'REFUNDED')
           and a.pii_erased_at is not null
           and (a.retention_hold_until is null or a.retention_hold_until < ?)
           and coalesce(
             (select max(r.issued_at) from receipts r where r.application_id = a.id),
             a.updated_at
           ) < ?
         order by a.updated_at asc limit ?`,
      )
      .bind(nowIso, recordCutoff, policy.batchSize),
  );

  return {
    abandonedDeleted: await deleteApplications(db, bucket, abandoned),
    piiErased: await erasePii(db, bucket, toErase, now.toISOString()),
    recordsDeleted: await deleteApplications(db, bucket, expiredRecords),
  };
}
