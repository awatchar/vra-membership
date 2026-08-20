-- Fixed-window rate limiting for the public endpoints that cost money
-- (Issue #1 section 57).
--
-- Privacy: `bucket` holds a keyed hash of the identifier, never the identifier
-- itself. A client IP address is personal data and has no business sitting in
-- the database in clear text, and a hash is all a counter needs.
--
-- Rows are disposable. Old windows are deleted opportunistically on write, so
-- the table stays small without a scheduled job.

CREATE TABLE rate_limits (
  -- Keyed hash of "<scope>:<identifier>".
  bucket TEXT NOT NULL,
  -- Unix seconds at the start of the window.
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (bucket, window_start),

  CHECK (count >= 0),
  CHECK (window_start >= 0)
);

-- Supports the opportunistic cleanup of expired windows.
CREATE INDEX idx_rate_limits_window_start ON rate_limits (window_start);
