-- 001: the collector's normalized store. Raw payloads live outside SQLite as append-only
-- gzip JSONL under <PMIC_DATA_DIR>/raw (lib/raw.js); rows here point at them by sha256.
-- Every time is RFC 3339 UTC text. Migrations are append-only.

CREATE TABLE IF NOT EXISTS sources (
  source_id         TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  homepage          TEXT,
  terms_url         TEXT,
  tier              INTEGER NOT NULL,
  reliability_score REAL NOT NULL,
  cadence_minutes   INTEGER NOT NULL,
  notes             TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets_or_entities (
  entity_id   TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,              -- geography | sector | company | commodity
  name        TEXT NOT NULL,
  ticker      TEXT,
  cik         TEXT,
  geography   TEXT,
  industry    TEXT,
  updated_at  TEXT NOT NULL
);

-- Catalog of what is collected; one row per series. Mirrors config/series.json after expansion.
CREATE TABLE IF NOT EXISTS series (
  series_id        TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources (source_id),
  entity_id        TEXT NOT NULL REFERENCES assets_or_entities (entity_id),
  metric_name      TEXT NOT NULL,
  label            TEXT NOT NULL,
  unit             TEXT NOT NULL,
  frequency        TEXT NOT NULL,         -- daily | weekly | monthly | quarterly | annual
  category         TEXT NOT NULL,
  industry         TEXT,
  geography        TEXT,
  polarity         INTEGER NOT NULL DEFAULT 0,
  transform        TEXT NOT NULL DEFAULT 'level',
  retention_class  TEXT NOT NULL,
  cross_check      TEXT,
  cadence_minutes  INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_attempt_at  TEXT,
  last_success_at  TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS series_entity ON series (entity_id);
CREATE INDEX IF NOT EXISTS series_category ON series (category, industry);

CREATE TABLE IF NOT EXISTS observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL,
  series_id        TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  metric_name      TEXT NOT NULL,
  metric_value     REAL NOT NULL,
  unit             TEXT NOT NULL,
  observation_time TEXT NOT NULL,         -- period end / as-of date the value describes
  period           TEXT,                  -- source's own period label, e.g. 2026-M08, 2026Q2, CY2025
  fetch_time       TEXT NOT NULL,         -- first time this exact value was fetched
  source_url       TEXT NOT NULL,         -- human-checkable citation
  raw_sha256       TEXT,                  -- raw payload this value was parsed from
  transform_version TEXT NOT NULL,
  retention_class  TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  qc_flags         TEXT NOT NULL DEFAULT '[]',
  revision         INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  UNIQUE (source_id, entity_id, observation_time, metric_name)
);
CREATE INDEX IF NOT EXISTS observations_series_time ON observations (series_id, observation_time);
CREATE INDEX IF NOT EXISTS observations_updated ON observations (updated_at);

-- Every value an observation held before a source revised it: the provenance trail survives revisions.
CREATE TABLE IF NOT EXISTS observation_revisions (
  observation_id   INTEGER NOT NULL,
  revision         INTEGER NOT NULL,
  metric_value     REAL NOT NULL,
  fetch_time       TEXT NOT NULL,
  raw_sha256       TEXT,
  replaced_at      TEXT NOT NULL,
  PRIMARY KEY (observation_id, revision)
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL,
  external_id      TEXT NOT NULL,         -- accession number, recall number, application+submission
  entity_id        TEXT NOT NULL,
  event_type       TEXT NOT NULL,         -- filing_10k, filing_8k, insider_form4, drug_recall, drug_approval, ...
  event_time       TEXT NOT NULL,
  title            TEXT NOT NULL,
  severity         TEXT NOT NULL,         -- low | medium | high
  detail_json      TEXT NOT NULL DEFAULT '{}',
  source_url       TEXT NOT NULL,
  raw_sha256       TEXT,
  fetch_time       TEXT NOT NULL,
  retention_class  TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS events_entity_time ON events (entity_id, event_time);
CREATE INDEX IF NOT EXISTS events_type_time ON events (event_type, event_time);

CREATE TABLE IF NOT EXISTS derived_metrics (
  series_id        TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  metric_name      TEXT NOT NULL,
  as_of            TEXT NOT NULL,         -- observation_time of the latest observation used
  derived_name     TEXT NOT NULL,         -- pct_change_30d, zscore_365d, transformed_value, ...
  value            REAL,
  computed_at      TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  retention_class  TEXT NOT NULL DEFAULT 'derived',
  PRIMARY KEY (series_id, as_of, derived_name, transform_version)
);

CREATE TABLE IF NOT EXISTS scores (
  series_id         TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  metric_name       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  as_of             TEXT NOT NULL,
  computed_at       TEXT NOT NULL,
  current_value     REAL NOT NULL,
  unit              TEXT NOT NULL,
  transformed_value REAL,
  pct_change_7d     REAL,
  pct_change_30d    REAL,
  pct_change_90d    REAL,
  pct_change_365d   REAL,
  zscore            REAL,
  percentile        REAL,
  freshness_score   REAL NOT NULL,
  reliability_score REAL NOT NULL,
  composite_score   INTEGER,
  trend             TEXT NOT NULL,        -- up | down | flat | unknown
  confidence_score  REAL NOT NULL,
  confidence_label  TEXT NOT NULL,
  risk_flags        TEXT NOT NULL DEFAULT '[]',
  rationale         TEXT NOT NULL,
  citation_url      TEXT NOT NULL,
  provenance_json   TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  PRIMARY KEY (series_id, as_of, transform_version)
);
CREATE INDEX IF NOT EXISTS scores_entity ON scores (entity_id, as_of);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,              -- api_failure | empty_response | schema_change | gap | outlier | impossible_value | cross_source_mismatch | stale | missing_key
  source_id   TEXT,
  series_id   TEXT,
  entity_id   TEXT,
  detail      TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open ON alerts (dedupe_key) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS fetch_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL,
  job_key      TEXT NOT NULL,
  url          TEXT NOT NULL,             -- with any API key redacted
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  http_status  INTEGER,
  ok           INTEGER NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  records      INTEGER NOT NULL DEFAULT 0,
  raw_sha256   TEXT,
  raw_file     TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS fetch_logs_source_time ON fetch_logs (source_id, started_at);

CREATE TABLE IF NOT EXISTS rollups_weekly (
  series_id   TEXT NOT NULL,
  week_start  TEXT NOT NULL,              -- Monday, YYYY-MM-DD
  n           INTEGER NOT NULL,
  avg_value   REAL NOT NULL,
  min_value   REAL NOT NULL,
  max_value   REAL NOT NULL,
  last_value  REAL NOT NULL,
  PRIMARY KEY (series_id, week_start)
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
