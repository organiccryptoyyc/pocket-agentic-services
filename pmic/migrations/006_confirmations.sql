-- Verified layer 1.5: independent cross-checks of collected values (same columns as the TCS-6
-- evidence bank on the Pi). Only a sha256 of the other source's reading is kept, never the payload.
-- Written by lib/verify.js after each collect pass; nothing here feeds scores or the hub.
CREATE TABLE IF NOT EXISTS confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  field TEXT NOT NULL,
  entity_id TEXT,
  our_value TEXT,
  upstream_service TEXT NOT NULL,
  upstream_supplier TEXT,
  upstream_value_hash TEXT,
  agreement TEXT NOT NULL CHECK (agreement IN ('agree','disagree','partial','unavailable')),
  delta_pct REAL,
  tolerance_pct REAL,
  observed_at TEXT NOT NULL,
  app_address TEXT,
  cu_spent INTEGER NOT NULL DEFAULT 0,
  session_height INTEGER
);
CREATE INDEX IF NOT EXISTS confirmations_field ON confirmations (entity_id, field, observed_at);
CREATE INDEX IF NOT EXISTS confirmations_run ON confirmations (run_id);
CREATE TABLE IF NOT EXISTS upstream_quality (
  service_id TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  schema_fails INTEGER NOT NULL DEFAULT 0,
  disagreements INTEGER NOT NULL DEFAULT 0,
  median_latency_ms REAL,
  last_seen TEXT,
  PRIMARY KEY (service_id, supplier)
);
