-- Verified layer, Phase 3: signed input attestations per series, received from the collector.
-- Hub side only (the collector keeps its signing state in kv "attest:<series_id>"). The latest
-- envelope per series, stored exactly as signed; the service packs verify it again before use.
CREATE TABLE IF NOT EXISTS attestations (
  series_id TEXT PRIMARY KEY,
  attestation_id TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
