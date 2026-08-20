-- Capability token for applicant access to their own application.
--
-- The application id is a UUID that appears in URLs and in the confirmation
-- page, so it is not a secret. On its own it must not be enough to read
-- someone's identity data, which means the applicant needs something the id
-- does not give them.
--
-- Only a keyed hash of the token is stored. A leaked database therefore does
-- not hand over working capabilities, in the same way that
-- `citizen_id_ciphertext` does not hand over citizen IDs.
--
-- Nullable on purpose: a row with no hash cannot be read by anyone, which is
-- the correct failure mode. Adding it as NOT NULL would also have required
-- rebuilding the table on SQLite.

ALTER TABLE applications ADD COLUMN access_token_hash TEXT;

-- The token is presented without an id in some flows, so it has to be
-- lookupable on its own.
CREATE UNIQUE INDEX idx_applications_access_token_hash
  ON applications (access_token_hash)
  WHERE access_token_hash IS NOT NULL;
