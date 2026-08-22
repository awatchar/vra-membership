-- Manual payment review for an image SlipOK cannot read.
--
-- The slip itself is deliberately absent: the request keeps it in memory only
-- and discards it after SlipOK returns. The manager reconciles the association
-- bank statement and records the bank transaction reference in the portal.

CREATE TABLE payment_reviews (
  application_id TEXT PRIMARY KEY REFERENCES applications (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,

  CHECK (reason IN ('SLIP_UNREADABLE')),
  CHECK (status IN ('PENDING', 'APPROVED', 'AUTOMATICALLY_VERIFIED')),
  CHECK (
    (status = 'PENDING' AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status = 'APPROVED' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL) OR
    (status = 'AUTOMATICALLY_VERIFIED' AND resolved_at IS NOT NULL AND resolved_by IS NULL)
  )
);

CREATE INDEX idx_payment_reviews_status_requested
  ON payment_reviews (status, requested_at);

-- Payment is a one-way workflow boundary: an application can be paid once.
-- This is also the final concurrent-request guard for automatic verification
-- racing a manager approval with a different transaction reference.
CREATE UNIQUE INDEX idx_payments_one_per_application ON payments (application_id);

-- SQLite cannot extend a CHECK constraint in place. No table references
-- `emails`, so rebuilding it is isolated and preserves every delivery field.
CREATE TABLE emails_with_payment_review (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  provider TEXT NOT NULL,
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
      'MANAGER_PAYMENT_REVIEW',
      'MEMBER_PROCESSING',
      'MEMBER_NBTC_COMPLETED'
    )
  ),
  CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'))
);

INSERT INTO emails_with_payment_review (
  id, application_id, type, recipient, provider, provider_email_id,
  sent_at, delivered_at, first_opened_at, first_clicked_at,
  status, created_at, updated_at
)
SELECT
  id, application_id, type, recipient, provider, provider_email_id,
  sent_at, delivered_at, first_opened_at, first_clicked_at,
  status, created_at, updated_at
FROM emails;

DROP TABLE emails;
ALTER TABLE emails_with_payment_review RENAME TO emails;

CREATE UNIQUE INDEX idx_emails_application_id_type ON emails (application_id, type);
