-- Read-only replica of the Pi's shared price bank (TCS-6 Build B). Replaced as a whole by each
-- signed, newer batch; the replica's version/built_at live in kv 'pricebank_replica'.
CREATE TABLE IF NOT EXISTS pricebank_rows (
  asset TEXT PRIMARY KEY,
  usd REAL,
  status TEXT NOT NULL,
  observed_at TEXT,
  row_json TEXT NOT NULL
);
