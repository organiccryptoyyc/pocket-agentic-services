-- 009: read-only replica of the Pi's token-risk snapshot (Build 2, 2026-11-15). Replaced as a whole by each signed,
-- newer batch (same key and rules as the price bank replica); version/built_at live in kv 'tokenrisk_replica'.
CREATE TABLE IF NOT EXISTS tokenrisk_rows (
  asset TEXT PRIMARY KEY,           -- chain:0xtoken, lower case
  verdict TEXT NOT NULL,
  row_json TEXT NOT NULL
);
-- Tokens agents asked for that the replica doesn't cover; handed to the Pi with each push reply, oldest first.
CREATE TABLE IF NOT EXISTS tokenrisk_requests (
  asset TEXT PRIMARY KEY,
  first_requested_at TEXT NOT NULL,
  last_requested_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
