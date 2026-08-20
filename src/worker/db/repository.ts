import { UniqueConstraintError, withTranslatedErrors } from './errors';
import {
  toAddressRecord,
  toApplicationEventRecord,
  toApplicationRecord,
  toEmailRecord,
  toPaymentRecord,
  toReceiptRecord,
} from './mappers';
import type {
  AddressInput,
  AddressRecord,
  ApplicationContactInput,
  ApplicationEventInput,
  ApplicationEventRecord,
  ApplicationIdentityInput,
  ApplicationListQuery,
  ApplicationRecord,
  ApplicationStatus,
  EmailInput,
  EmailRecord,
  EmailType,
  MembershipType,
  PaymentInput,
  PaymentRecord,
  PhotoSource,
  ReceiptInput,
  ReceiptRecord,
} from './types';

/**
 * Data access layer.
 *
 * Every method binds parameters; no SQL is assembled from caller-supplied
 * strings. Every method returns an internal model from `./types`, never a D1
 * row, so no caller can grow a dependency on the schema.
 *
 * Nothing here logs. Callers log an outcome plus an internal id; the values
 * passed through this module are exactly the personal data that must not reach
 * a log sink (see `src/worker/lib/logger.ts`).
 */

export interface RepositoryOptions {
  /** Injectable so tests can assert on timestamps. */
  now?: () => Date;
  /** Injectable so tests can produce deterministic ids. */
  newId?: () => string;
}

const DEFAULT_LIST_LIMIT = 50;
const MAXIMUM_LIST_LIMIT = 200;

/** Timestamps that a status change may set. Existing values are never cleared. */
export type StatusTimestamps = Partial<
  Record<'submittedAt' | 'managerAcknowledgedAt' | 'nbtcRecordedAt', string>
> & { nbtcRecordedBy?: string };

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

export interface ApplicationRepository {
  /**
   * Creates an application from identity data the applicant has reviewed.
   *
   * The row cannot exist without a protected citizen ID, which is why there is
   * no "empty draft" creation path: an abandoned OCR attempt leaves no data
   * behind at all.
   */
  create(input: ApplicationIdentityInput): Promise<ApplicationRecord>;
  findById(id: string): Promise<ApplicationRecord | null>;
  findByReferenceNo(referenceNo: string): Promise<ApplicationRecord | null>;
  /** Duplicate-applicant lookup. Returns ids only, ordered oldest first. */
  findIdsByCitizenIdHash(citizenIdHash: string): Promise<string[]>;
  updateIdentity(id: string, input: Omit<ApplicationIdentityInput, never>): Promise<void>;
  updateContact(id: string, input: ApplicationContactInput): Promise<void>;
  setMembership(id: string, type: MembershipType, amountSatang: number): Promise<void>;
  setPhoto(
    id: string,
    photo: { key: string; source: PhotoSource; uploadedAt?: string },
  ): Promise<void>;
  /** Assigns the application number. Fails with `UniqueConstraintError` if taken. */
  setReferenceNo(id: string, referenceNo: string): Promise<void>;
  /**
   * Highest reference number matching a `like` pattern, or null when none
   * exists. The sequence is zero-padded to a fixed width, so the lexicographic
   * maximum is also the numeric maximum.
   */
  findMaxReferenceNo(pattern: string): Promise<string | null>;
  /**
   * Compare-and-set on `status`. Returns false when the row was not in `from`,
   * which is how the state machine stays safe under concurrent requests
   * without a transaction.
   *
   * Records no audit event. Prefer `transitionStatus`, which cannot leave a
   * status change without its trail.
   */
  updateStatusIf(
    id: string,
    from: readonly ApplicationStatus[],
    to: ApplicationStatus,
    timestamps?: StatusTimestamps,
  ): Promise<boolean>;
  /**
   * Compare-and-set on `status` plus its audit events, in one D1 batch and
   * therefore one transaction.
   *
   * Writing the status and then the events as two round trips leaves a window
   * where a failure produces a status change with no trail, and Issue #1
   * requires the trail to be complete. Each event insert is guarded on the row
   * already holding `to`, so if the compare-and-set did not apply, the events
   * are skipped rather than recording something that did not happen.
   *
   * Returns false when the row was not in `from`.
   */
  transitionStatus(input: {
    id: string;
    from: ApplicationStatus;
    to: ApplicationStatus;
    timestamps?: StatusTimestamps;
    events: readonly ApplicationEventInput[];
  }): Promise<boolean>;
  list(query?: ApplicationListQuery): Promise<ApplicationRecord[]>;
}

export interface AddressRepository {
  /** Creates or replaces the single address record for an application. */
  upsert(applicationId: string, input: AddressInput): Promise<AddressRecord>;
  findByApplicationId(applicationId: string): Promise<AddressRecord | null>;
}

export interface PaymentRepository {
  /**
   * Records a verified payment. Throws `UniqueConstraintError` when the
   * transaction reference was already used, which is the database-level
   * duplicate-slip guard.
   */
  create(input: PaymentInput): Promise<PaymentRecord>;
  findById(id: string): Promise<PaymentRecord | null>;
  findByTransactionRef(transactionRef: string): Promise<PaymentRecord | null>;
  findByApplicationId(applicationId: string): Promise<PaymentRecord[]>;
}

export interface ReceiptRepository {
  create(input: ReceiptInput): Promise<ReceiptRecord>;
  findByApplicationId(applicationId: string): Promise<ReceiptRecord | null>;
  findByReceiptNo(receiptNo: string): Promise<ReceiptRecord | null>;
  /** Highest receipt number matching a `like` pattern, or null when none exists. */
  findMaxReceiptNo(pattern: string): Promise<string | null>;
  markEmailSent(id: string, sentAt?: string): Promise<void>;
}

export interface EmailRepository {
  create(input: EmailInput): Promise<EmailRecord>;
  findById(id: string): Promise<EmailRecord | null>;
  findByProviderEmailId(providerEmailId: string): Promise<EmailRecord | null>;
  findByApplicationIdAndType(applicationId: string, type: EmailType): Promise<EmailRecord[]>;
  markSent(id: string, providerEmailId: string, sentAt?: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  markDelivered(id: string, deliveredAt?: string): Promise<void>;
  markBounced(id: string): Promise<void>;
  /** Records the first open only. Returns true when this call set it. */
  recordFirstOpen(id: string, openedAt?: string): Promise<boolean>;
  /** Records the first click only. Returns true when this call set it. */
  recordFirstClick(id: string, clickedAt?: string): Promise<boolean>;
}

export interface EventRepository {
  append(input: ApplicationEventInput): Promise<ApplicationEventRecord>;
  listByApplicationId(applicationId: string): Promise<ApplicationEventRecord[]>;
  /** Used by idempotent transitions to check whether an event already exists. */
  existsForApplication(applicationId: string, eventType: string): Promise<boolean>;
}

export interface Repository {
  applications: ApplicationRepository;
  addresses: AddressRepository;
  payments: PaymentRepository;
  receipts: ReceiptRepository;
  emails: EmailRepository;
  events: EventRepository;
}

export function createRepository(db: D1Database, options: RepositoryOptions = {}): Repository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const first = async (statement: D1PreparedStatement): Promise<Record<string, unknown> | null> =>
    withTranslatedErrors(async () => statement.first<Record<string, unknown>>());

  const all = async (statement: D1PreparedStatement): Promise<Record<string, unknown>[]> =>
    withTranslatedErrors(async () => {
      const { results } = await statement.all<Record<string, unknown>>();
      return results;
    });

  const run = async (statement: D1PreparedStatement): Promise<D1Result> =>
    withTranslatedErrors(async () => statement.run());

  /** Compare-and-set on status. Never clears a timestamp that is already set. */
  const statusUpdate = (
    id: string,
    from: readonly ApplicationStatus[],
    to: ApplicationStatus,
    timestamps: StatusTimestamps | undefined,
  ): D1PreparedStatement =>
    db
      .prepare(
        `update applications set
           status = ?,
           submitted_at = coalesce(?, submitted_at),
           manager_acknowledged_at = coalesce(?, manager_acknowledged_at),
           nbtc_recorded_at = coalesce(?, nbtc_recorded_at),
           nbtc_recorded_by = coalesce(?, nbtc_recorded_by),
           updated_at = ?
         where id = ? and status in (${from.map(() => '?').join(', ')})`,
      )
      .bind(
        to,
        timestamps?.submittedAt ?? null,
        timestamps?.managerAcknowledgedAt ?? null,
        timestamps?.nbtcRecordedAt ?? null,
        timestamps?.nbtcRecordedBy ?? null,
        isoNow(now),
        id,
        ...from,
      );

  /**
   * Inserts an audit event only if the application still holds `requiredStatus`.
   *
   * This must be the status *before* the transition, and these inserts must be
   * batched *before* the status update. Guarding on the target status instead
   * looks equivalent but is not: once one request has committed the change,
   * every concurrent loser also sees the target status, so all of them would
   * insert an event for a change only one of them made.
   */
  const guardedEventInsert = (
    event: ApplicationEventInput,
    applicationId: string,
    requiredStatus: ApplicationStatus,
  ): D1PreparedStatement =>
    db
      .prepare(
        `insert into application_events (
           id, application_id, event_type, metadata_json, actor_type, actor_id, created_at
         )
         select ?, ?, ?, ?, ?, ?, ?
         where exists (select 1 from applications where id = ? and status = ?)`,
      )
      .bind(
        newId(),
        applicationId,
        event.eventType,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.actorType,
        event.actorId ?? null,
        isoNow(now),
        applicationId,
        requiredStatus,
      );

  const applications: ApplicationRepository = {
    async create(input) {
      const id = newId();
      const timestamp = isoNow(now);

      await run(
        db
          .prepare(
            `insert into applications (
               id, citizen_id_hash, citizen_id_ciphertext,
               title, first_name, last_name, first_name_en, last_name_en,
               birth_date, card_expiry_date,
               status, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
          )
          .bind(
            id,
            input.citizenIdHash,
            input.citizenIdCiphertext,
            input.title ?? null,
            input.firstName ?? null,
            input.lastName ?? null,
            input.firstNameEn ?? null,
            input.lastNameEn ?? null,
            input.birthDate ?? null,
            input.cardExpiryDate ?? null,
            timestamp,
            timestamp,
          ),
      );

      const created = await applications.findById(id);
      if (!created) throw new Error('Application was not persisted');
      return created;
    },

    async findById(id) {
      const row = await first(db.prepare('select * from applications where id = ?').bind(id));
      return row ? toApplicationRecord(row) : null;
    },

    async findByReferenceNo(referenceNo) {
      const row = await first(
        db.prepare('select * from applications where reference_no = ?').bind(referenceNo),
      );
      return row ? toApplicationRecord(row) : null;
    },

    async findIdsByCitizenIdHash(citizenIdHash) {
      const rows = await all(
        db
          .prepare('select id from applications where citizen_id_hash = ? order by created_at asc')
          .bind(citizenIdHash),
      );
      return rows.map((row) => String(row['id']));
    },

    async updateIdentity(id, input) {
      await run(
        db
          .prepare(
            `update applications set
               citizen_id_hash = ?, citizen_id_ciphertext = ?,
               title = ?, first_name = ?, last_name = ?,
               first_name_en = ?, last_name_en = ?,
               birth_date = ?, card_expiry_date = ?,
               updated_at = ?
             where id = ?`,
          )
          .bind(
            input.citizenIdHash,
            input.citizenIdCiphertext,
            input.title ?? null,
            input.firstName ?? null,
            input.lastName ?? null,
            input.firstNameEn ?? null,
            input.lastNameEn ?? null,
            input.birthDate ?? null,
            input.cardExpiryDate ?? null,
            isoNow(now),
            id,
          ),
      );
    },

    async updateContact(id, input) {
      await run(
        db
          .prepare(
            `update applications set phone = ?, email = ?, callsign = ?, updated_at = ?
             where id = ?`,
          )
          .bind(input.phone ?? null, input.email ?? null, input.callsign ?? null, isoNow(now), id),
      );
    },

    async setMembership(id, type, amountSatang) {
      await run(
        db
          .prepare(
            `update applications set membership_type = ?, membership_amount = ?, updated_at = ?
             where id = ?`,
          )
          .bind(type, amountSatang, isoNow(now), id),
      );
    },

    async setPhoto(id, photo) {
      const timestamp = isoNow(now);
      await run(
        db
          .prepare(
            `update applications set photo_key = ?, photo_source = ?, photo_uploaded_at = ?,
               updated_at = ?
             where id = ?`,
          )
          .bind(photo.key, photo.source, photo.uploadedAt ?? timestamp, timestamp, id),
      );
    },

    async setReferenceNo(id, referenceNo) {
      const result = await run(
        db
          .prepare(
            `update applications set reference_no = ?, updated_at = ?
             where id = ? and reference_no is null`,
          )
          .bind(referenceNo, isoNow(now), id),
      );

      if (result.meta.changes === 0) {
        // Either the application already has a number or it does not exist.
        // Both are caller bugs, and neither may silently overwrite a number
        // that has already been printed on a document.
        throw new UniqueConstraintError('applications.reference_no');
      }
    },

    async findMaxReferenceNo(pattern) {
      const row = await first(
        db
          .prepare(
            `select reference_no from applications
             where reference_no like ?
             order by reference_no desc limit 1`,
          )
          .bind(pattern),
      );
      const value = row?.['reference_no'];
      return typeof value === 'string' ? value : null;
    },

    async updateStatusIf(id, from, to, timestamps) {
      const result = await run(statusUpdate(id, from, to, timestamps));
      return result.meta.changes > 0;
    },

    async transitionStatus({ id, from, to, timestamps, events }) {
      if (from === to) {
        // Both the guard and the update key off `from`, so a same-status call
        // would record a transition that never happened.
        throw new Error('A status transition must change the status');
      }

      // Events first, each guarded on the pre-transition status, then the
      // compare-and-set. Every statement therefore keys off the same `from`, so
      // either all of them apply or none of them do.
      const statements = [
        ...events.map((event) => guardedEventInsert(event, id, from)),
        statusUpdate(id, [from], to, timestamps),
      ];

      const results = await withTranslatedErrors(async () => db.batch(statements));
      // D1 runs a batch as one transaction. The update is last, so its change
      // count is the answer to "did this transition apply".
      return (results.at(-1)?.meta.changes ?? 0) > 0;
    },

    async list(query = {}) {
      // An explicitly empty filter means "no status matches". Treating it as
      // "no filter" would turn an admin UI that computed an empty filter set
      // into a full-table dump of personal data.
      if (query.statuses !== undefined && query.statuses.length === 0) {
        return [];
      }

      const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAXIMUM_LIST_LIMIT);
      const offset = Math.max(query.offset ?? 0, 0);
      const statuses = query.statuses ?? [];

      const statement =
        statuses.length > 0
          ? db
              .prepare(
                `select * from applications
                 where status in (${statuses.map(() => '?').join(', ')})
                 order by created_at desc limit ? offset ?`,
              )
              .bind(...statuses, limit, offset)
          : db
              .prepare('select * from applications order by created_at desc limit ? offset ?')
              .bind(limit, offset);

      const rows = await all(statement);
      return rows.map(toApplicationRecord);
    },
  };

  const addresses: AddressRepository = {
    async upsert(applicationId, input) {
      const timestamp = isoNow(now);
      await run(
        db
          .prepare(
            `insert into addresses (
               id, application_id,
               id_address, id_subdistrict, id_district, id_province,
               mail_same_as_id,
               mail_recipient, mail_address, mail_subdistrict, mail_district,
               mail_province, mail_postcode, mail_phone,
               created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (application_id) do update set
               id_address = excluded.id_address,
               id_subdistrict = excluded.id_subdistrict,
               id_district = excluded.id_district,
               id_province = excluded.id_province,
               mail_same_as_id = excluded.mail_same_as_id,
               mail_recipient = excluded.mail_recipient,
               mail_address = excluded.mail_address,
               mail_subdistrict = excluded.mail_subdistrict,
               mail_district = excluded.mail_district,
               mail_province = excluded.mail_province,
               mail_postcode = excluded.mail_postcode,
               mail_phone = excluded.mail_phone,
               updated_at = excluded.updated_at`,
          )
          .bind(
            newId(),
            applicationId,
            input.idAddress,
            input.idSubdistrict,
            input.idDistrict,
            input.idProvince,
            bool(input.mailSameAsId),
            input.mailRecipient,
            input.mailAddress,
            input.mailSubdistrict,
            input.mailDistrict,
            input.mailProvince,
            input.mailPostcode,
            input.mailPhone,
            timestamp,
            timestamp,
          ),
      );

      const record = await addresses.findByApplicationId(applicationId);
      if (!record) throw new Error('Address was not persisted');
      return record;
    },

    async findByApplicationId(applicationId) {
      const row = await first(
        db.prepare('select * from addresses where application_id = ?').bind(applicationId),
      );
      return row ? toAddressRecord(row) : null;
    },
  };

  const payments: PaymentRepository = {
    async create(input) {
      const id = newId();
      await run(
        db
          .prepare(
            `insert into payments (
               id, application_id, provider, transaction_ref, amount,
               sending_bank, receiving_bank, receiver_account_tail, transaction_at,
               receiver_matched, amount_matched, verification_status, verified_at, created_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.applicationId,
            input.provider,
            input.transactionRef,
            input.amountSatang,
            input.sendingBank,
            input.receivingBank,
            input.receiverAccountTail,
            input.transactionAt,
            bool(input.receiverMatched),
            bool(input.amountMatched),
            input.verificationStatus,
            input.verifiedAt,
            isoNow(now),
          ),
      );

      const created = await payments.findById(id);
      if (!created) throw new Error('Payment was not persisted');
      return created;
    },

    async findById(id) {
      const row = await first(db.prepare('select * from payments where id = ?').bind(id));
      return row ? toPaymentRecord(row) : null;
    },

    async findByTransactionRef(transactionRef) {
      const row = await first(
        db.prepare('select * from payments where transaction_ref = ?').bind(transactionRef),
      );
      return row ? toPaymentRecord(row) : null;
    },

    async findByApplicationId(applicationId) {
      const rows = await all(
        db
          .prepare('select * from payments where application_id = ? order by created_at asc')
          .bind(applicationId),
      );
      return rows.map(toPaymentRecord);
    },
  };

  const receipts: ReceiptRepository = {
    async create(input) {
      const id = newId();
      await run(
        db
          .prepare(
            `insert into receipts (
               id, application_id, payment_id, receipt_no, amount, issued_at
             ) values (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.applicationId,
            input.paymentId,
            input.receiptNo,
            input.amountSatang,
            input.issuedAt,
          ),
      );

      const row = await first(db.prepare('select * from receipts where id = ?').bind(id));
      if (!row) throw new Error('Receipt was not persisted');
      return toReceiptRecord(row);
    },

    async findByApplicationId(applicationId) {
      const row = await first(
        db.prepare('select * from receipts where application_id = ?').bind(applicationId),
      );
      return row ? toReceiptRecord(row) : null;
    },

    async findByReceiptNo(receiptNo) {
      const row = await first(
        db.prepare('select * from receipts where receipt_no = ?').bind(receiptNo),
      );
      return row ? toReceiptRecord(row) : null;
    },

    async findMaxReceiptNo(pattern) {
      const row = await first(
        db
          .prepare(
            `select receipt_no from receipts
             where receipt_no like ?
             order by receipt_no desc limit 1`,
          )
          .bind(pattern),
      );
      const value = row?.['receipt_no'];
      return typeof value === 'string' ? value : null;
    },

    async markEmailSent(id, sentAt) {
      await run(
        db
          .prepare('update receipts set email_sent_at = coalesce(email_sent_at, ?) where id = ?')
          .bind(sentAt ?? isoNow(now), id),
      );
    },
  };

  const emails: EmailRepository = {
    async create(input) {
      const id = newId();
      const timestamp = isoNow(now);
      await run(
        db
          .prepare(
            `insert into emails (
               id, application_id, type, recipient, provider, status, created_at, updated_at
             ) values (?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
          )
          .bind(
            id,
            input.applicationId,
            input.type,
            input.recipient,
            input.provider,
            timestamp,
            timestamp,
          ),
      );

      const created = await emails.findById(id);
      if (!created) throw new Error('Email record was not persisted');
      return created;
    },

    async findById(id) {
      const row = await first(db.prepare('select * from emails where id = ?').bind(id));
      return row ? toEmailRecord(row) : null;
    },

    async findByProviderEmailId(providerEmailId) {
      const row = await first(
        db.prepare('select * from emails where provider_email_id = ?').bind(providerEmailId),
      );
      return row ? toEmailRecord(row) : null;
    },

    async findByApplicationIdAndType(applicationId, type) {
      const rows = await all(
        db
          .prepare(
            `select * from emails where application_id = ? and type = ?
             order by created_at asc`,
          )
          .bind(applicationId, type),
      );
      return rows.map(toEmailRecord);
    },

    async markSent(id, providerEmailId, sentAt) {
      const timestamp = isoNow(now);
      await run(
        db
          .prepare(
            `update emails set status = 'SENT', provider_email_id = ?, sent_at = ?, updated_at = ?
             where id = ?`,
          )
          .bind(providerEmailId, sentAt ?? timestamp, timestamp, id),
      );
    },

    async markFailed(id) {
      await run(
        db
          .prepare(`update emails set status = 'FAILED', updated_at = ? where id = ?`)
          .bind(isoNow(now), id),
      );
    },

    async markDelivered(id, deliveredAt) {
      const timestamp = isoNow(now);
      await run(
        db
          .prepare(
            `update emails set
               status = 'DELIVERED',
               delivered_at = coalesce(delivered_at, ?),
               updated_at = ?
             where id = ?`,
          )
          .bind(deliveredAt ?? timestamp, timestamp, id),
      );
    },

    async markBounced(id) {
      await run(
        db
          .prepare(`update emails set status = 'BOUNCED', updated_at = ? where id = ?`)
          .bind(isoNow(now), id),
      );
    },

    async recordFirstOpen(id, openedAt) {
      // `where first_opened_at is null` makes a replayed webhook a no-op, which
      // is what keeps the processing email from being sent more than once.
      const timestamp = isoNow(now);
      const result = await run(
        db
          .prepare(
            `update emails set first_opened_at = ?, updated_at = ?
             where id = ? and first_opened_at is null`,
          )
          .bind(openedAt ?? timestamp, timestamp, id),
      );
      return result.meta.changes > 0;
    },

    async recordFirstClick(id, clickedAt) {
      const timestamp = isoNow(now);
      const result = await run(
        db
          .prepare(
            `update emails set first_clicked_at = ?, updated_at = ?
             where id = ? and first_clicked_at is null`,
          )
          .bind(clickedAt ?? timestamp, timestamp, id),
      );
      return result.meta.changes > 0;
    },
  };

  const events: EventRepository = {
    async append(input) {
      const id = newId();
      await run(
        db
          .prepare(
            `insert into application_events (
               id, application_id, event_type, metadata_json, actor_type, actor_id, created_at
             ) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.applicationId,
            input.eventType,
            input.metadata ? JSON.stringify(input.metadata) : null,
            input.actorType,
            input.actorId ?? null,
            isoNow(now),
          ),
      );

      const row = await first(db.prepare('select * from application_events where id = ?').bind(id));
      if (!row) throw new Error('Application event was not persisted');
      return toApplicationEventRecord(row);
    },

    async listByApplicationId(applicationId) {
      const rows = await all(
        db
          .prepare(
            `select * from application_events where application_id = ?
             order by created_at asc, id asc`,
          )
          .bind(applicationId),
      );
      return rows.map(toApplicationEventRecord);
    },

    async existsForApplication(applicationId, eventType) {
      const row = await first(
        db
          .prepare(
            `select 1 as found from application_events
             where application_id = ? and event_type = ? limit 1`,
          )
          .bind(applicationId, eventType),
      );
      return row !== null;
    },
  };

  return { applications, addresses, payments, receipts, emails, events };
}
