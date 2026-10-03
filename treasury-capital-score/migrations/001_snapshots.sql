-- 001: evidence snapshots and the reports built from them (CLAUDE §10 D5).
-- Migrations are append-only and never delete snapshot rows.
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id   TEXT PRIMARY KEY,          -- snap_<sha256 of canonical bundle JSON>
  entity_id     TEXT NOT NULL,
  collected_at  TEXT NOT NULL,             -- bundle.collected_at (RFC 3339)
  stored_at     TEXT NOT NULL,
  bundle_json   TEXT NOT NULL              -- canonical JSON; derived values + citations only
);
CREATE INDEX IF NOT EXISTS snapshots_entity_time ON snapshots (entity_id, collected_at);

CREATE TABLE IF NOT EXISTS reports (
  snapshot_id     TEXT NOT NULL REFERENCES snapshots (snapshot_id),
  spec_version    TEXT NOT NULL,           -- e.g. tcs-6/1.0
  weights_version TEXT NOT NULL,           -- e.g. blueprint-v1
  schema_version  TEXT NOT NULL,           -- e.g. tcs-6-paid-response/1.0
  peer_nrts_json  TEXT NOT NULL,           -- cohort NRTs used for D1 (needed to reproduce)
  analysis_status TEXT NOT NULL,
  overall_score   INTEGER,
  built_at        TEXT NOT NULL,
  report_json     TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, spec_version, weights_version, schema_version, built_at)
);
CREATE INDEX IF NOT EXISTS reports_snapshot ON reports (snapshot_id);
