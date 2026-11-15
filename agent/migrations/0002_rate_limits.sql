-- Per-client daily rate limits for the sandbox endpoints (/api/sample-receipt, /api/register).
-- `client` is keccak256(day ‖ ip), never the raw IP; rows older than today are deleted on write.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket  TEXT NOT NULL,     -- endpoint name
  client  TEXT NOT NULL,
  day     TEXT NOT NULL,     -- YYYY-MM-DD (UTC)
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, client, day)
);
