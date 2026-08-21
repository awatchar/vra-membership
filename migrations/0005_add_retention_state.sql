-- Retention lifecycle for Issue #19.
--
-- `pii_erased_at` is deliberately separate from `updated_at`: erasing personal
-- data must not reset the clock used to remove the remaining accounting
-- record. The citizen-id columns remain NOT NULL for compatibility with D1's
-- SQLite ALTER TABLE support; erasure replaces them with empty strings while
-- the dedicated timestamp is the authoritative marker.

ALTER TABLE applications ADD COLUMN pii_erased_at TEXT;
ALTER TABLE applications ADD COLUMN retention_hold_until TEXT;

CREATE INDEX idx_applications_retention
  ON applications (status, updated_at, pii_erased_at, retention_hold_until);
