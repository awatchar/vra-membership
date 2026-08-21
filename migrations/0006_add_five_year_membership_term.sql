-- Correct the ordinary-membership term from annual to five years.
--
-- `membership_type` cannot be renamed or have its CHECK constraint changed in
-- place on SQLite without rebuilding the parent table. Rebuilding it would put
-- every child row behind a foreign-key/cascade migration risk, so the legacy
-- column is retained as a compatibility mirror and the canonical term lives in
-- this constrained column. Application writes keep both values in sync.

ALTER TABLE applications ADD COLUMN membership_term TEXT
  CHECK (membership_term IS NULL OR membership_term IN ('FIVE_YEAR', 'LIFETIME'));

UPDATE applications
SET membership_term = CASE membership_type
  WHEN 'ANNUAL' THEN 'FIVE_YEAR'
  WHEN 'LIFETIME' THEN 'LIFETIME'
  ELSE NULL
END;
