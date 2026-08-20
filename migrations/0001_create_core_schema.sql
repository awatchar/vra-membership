-- Core schema for the VRA membership registration system.
--
-- Privacy notes (see docs/security-privacy.md and Issue #1 sections 8, 44):
--  * No column stores a full ID-card image, a payment-slip image, a raw
--    provider response, bounding boxes, religion, gender or card issue date.
--  * The citizen ID is never stored in clear text. `citizen_id_ciphertext`
--    holds an AES-GCM envelope for the rare case the manager must read it, and
--    `citizen_id_hash` is a keyed hash used only for duplicate lookups.
--  * `applications.photo_key` is a random R2 object key with no personal data.
--
-- All timestamps are ISO 8601 UTC strings. Display conversion to Asia/Bangkok
-- happens in the application layer (Issue #1 section 69).

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  reference_no TEXT UNIQUE,

  -- Keyed hash for duplicate detection; ciphertext for authorised reads only.
  citizen_id_hash TEXT NOT NULL,
  citizen_id_ciphertext TEXT NOT NULL,

  title TEXT,
  first_name TEXT,
  last_name TEXT,
  first_name_en TEXT,
  last_name_en TEXT,

  birth_date TEXT,
  card_expiry_date TEXT,

  phone TEXT,
  email TEXT,
  callsign TEXT,

  membership_type TEXT,
  membership_amount INTEGER,

  photo_key TEXT,
  photo_source TEXT,
  photo_uploaded_at TEXT,

  status TEXT NOT NULL DEFAULT 'DRAFT',

  submitted_at TEXT,
  manager_acknowledged_at TEXT,
  nbtc_recorded_at TEXT,
  nbtc_recorded_by TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (membership_type IS NULL OR membership_type IN ('ANNUAL', 'LIFETIME')),
  -- Amounts are stored in satang so arithmetic stays exact.
  CHECK (membership_amount IS NULL OR membership_amount > 0),
  CHECK (photo_source IS NULL OR photo_source IN ('ID_CARD', 'UPLOAD')),
  CHECK (
    status IN (
      'DRAFT',
      'AWAITING_PAYMENT',
      'PAYMENT_VERIFIED',
      'SUBMITTED',
      'MANAGER_NOTIFIED',
      'NBTC_PROCESSING',
      'NBTC_RECORDED',
      'COMPLETED',
      'REJECTED',
      'CANCELLED',
      'REFUND_REQUIRED',
      'REFUNDED'
    )
  )
);

-- Duplicate applicant lookup without exposing the citizen ID.
CREATE INDEX idx_applications_citizen_id_hash ON applications (citizen_id_hash);
-- Admin dashboard: filter by status, newest first (Issue #1 section 52).
CREATE INDEX idx_applications_status_created_at ON applications (status, created_at DESC);
CREATE INDEX idx_applications_created_at ON applications (created_at DESC);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  -- One address record per application.
  application_id TEXT NOT NULL UNIQUE REFERENCES applications (id) ON DELETE CASCADE,

  -- From the ID card. A Thai ID card carries no postcode, so there is no
  -- id_postcode column and none may be guessed (Issue #1 section 9.1).
  id_address TEXT,
  id_subdistrict TEXT,
  id_district TEXT,
  id_province TEXT,

  mail_same_as_id INTEGER NOT NULL DEFAULT 0,

  mail_recipient TEXT,
  mail_address TEXT,
  mail_subdistrict TEXT,
  mail_district TEXT,
  mail_province TEXT,
  mail_postcode TEXT,
  mail_phone TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (mail_same_as_id IN (0, 1)),
  CHECK (mail_postcode IS NULL OR mail_postcode GLOB '[0-9][0-9][0-9][0-9][0-9]')
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,

  provider TEXT NOT NULL,
  -- A slip may be used once, across every application (Issue #1 section 21).
  transaction_ref TEXT NOT NULL UNIQUE,

  amount INTEGER NOT NULL,

  sending_bank TEXT,
  receiving_bank TEXT,
  receiver_account_tail TEXT,

  transaction_at TEXT,

  receiver_matched INTEGER NOT NULL DEFAULT 0,
  amount_matched INTEGER NOT NULL DEFAULT 0,

  verification_status TEXT NOT NULL,
  verified_at TEXT,

  created_at TEXT NOT NULL,

  CHECK (amount > 0),
  CHECK (receiver_matched IN (0, 1)),
  CHECK (amount_matched IN (0, 1)),
  CHECK (verification_status IN ('VERIFIED', 'REJECTED'))
);

CREATE INDEX idx_payments_application_id ON payments (application_id);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  -- One receipt per application, and one receipt per payment.
  application_id TEXT NOT NULL UNIQUE REFERENCES applications (id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments (id) ON DELETE CASCADE,

  receipt_no TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,

  issued_at TEXT NOT NULL,
  email_sent_at TEXT,

  CHECK (amount > 0)
);

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,

  type TEXT NOT NULL,
  recipient TEXT NOT NULL,

  provider TEXT NOT NULL,
  -- Provider id is the join key for webhook events; unique when known.
  provider_email_id TEXT UNIQUE,

  sent_at TEXT,
  delivered_at TEXT,
  first_opened_at TEXT,
  first_clicked_at TEXT,

  status TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (
    type IN (
      'RECEIPT',
      'MANAGER_NEW_APPLICATION',
      'MEMBER_PROCESSING',
      'MEMBER_NBTC_COMPLETED'
    )
  ),
  CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'))
);

CREATE INDEX idx_emails_application_id_type ON emails (application_id, type);

CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  -- Small JSON object of non-personal metadata only. Never a provider payload,
  -- never form data, never an image (Issue #1 section 49).
  metadata_json TEXT,

  actor_type TEXT NOT NULL,
  actor_id TEXT,

  created_at TEXT NOT NULL,

  CHECK (actor_type IN ('APPLICANT', 'MANAGER', 'SYSTEM', 'PROVIDER'))
);

CREATE INDEX idx_application_events_application_id_created_at
  ON application_events (application_id, created_at);
