-- One email of each type per application.
--
-- Every one of the four transactional emails answers a question that is asked
-- once about an application: here is your receipt, here is a new application,
-- work has started, registration is recorded. A second row of the same type is
-- never a legitimate second message - it is two callers having both read "no
-- email yet" before either wrote one, which is exactly what happens when the
-- post-payment workflow is resumed while a first attempt is still running.
--
-- Retries do not create rows: they reuse the existing one, which keeps the
-- provider idempotency key stable so a send whose outcome was never learned
-- cannot be delivered twice. So this costs nothing legitimate and makes the
-- guarantee the database's rather than a read-then-write check's.
--
-- 0001 already indexed the same two columns for lookup. A unique index serves
-- that lookup equally well, so the plain one is replaced rather than added to -
-- keeping the name means nothing else has to change.

DROP INDEX idx_emails_application_id_type;

CREATE UNIQUE INDEX idx_emails_application_id_type ON emails (application_id, type);
