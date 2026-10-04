// The collector's SQLite store, <PMIC_DATA_DIR>/pmic.db. Built on Node's built-in node:sqlite
// (Node >= 22.13), so zero npm dependencies, same as treasury-capital-score/lib/snapshots.js:
//   - writers (collector, hub ingest) open read-write; the query API opens read-only
//   - WAL journal, so the API keeps reading while the collector writes
//   - parameterized statements only; migrations in ../migrations applied in order
"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const DATA_DIR = path.resolve(process.env.PMIC_DATA_DIR || path.join(__dirname, "..", "var"));

function loadSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const msg = typeof w === "string" ? w : w && w.message;
    if (/SQLite is an experimental feature/.test(msg || "")) return;
    return orig.call(process, w, ...rest);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = orig;
  }
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_.+\.sql$/.test(x)).sort()) {
    if (done.has(f)) continue;
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

function dbFile(dataDir = DATA_DIR) {
  return path.join(dataDir, "pmic.db");
}

// Returns a raw DatabaseSync, or null when opening read-only and the file is not there yet.
function open({ dataDir = DATA_DIR, readOnly = false } = {}) {
  const { DatabaseSync } = loadSqlite();
  const file = dbFile(dataDir);
  if (readOnly) {
    if (!fs.existsSync(file)) return null;
    return new DatabaseSync(file, { readOnly: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX hosts */ }
  db.exec("PRAGMA journal_mode = WAL");
  // Generous: a manual `collect.js --force` can run while the --loop collector is mid-pass.
  db.exec("PRAGMA busy_timeout = 60000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Mirror the expanded config catalog into sources / assets_or_entities / series.
function syncCatalog(db, catalog, now = new Date().toISOString()) {
  tx(db, () => {
    const src = db.prepare(`INSERT INTO sources (source_id, name, homepage, terms_url, tier, reliability_score, cadence_minutes, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id) DO UPDATE SET name=excluded.name, homepage=excluded.homepage, terms_url=excluded.terms_url, tier=excluded.tier,
        reliability_score=excluded.reliability_score, cadence_minutes=excluded.cadence_minutes, notes=excluded.notes, updated_at=excluded.updated_at`);
    for (const s of catalog.sources) src.run(s.source_id, s.name, s.homepage || null, s.terms_url || null, s.tier, s.reliability_score, s.cadence_minutes, s.notes || null, now);

    const ent = db.prepare(`INSERT INTO assets_or_entities (entity_id, entity_type, name, ticker, cik, geography, industry, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (entity_id) DO UPDATE SET entity_type=excluded.entity_type, name=excluded.name, ticker=excluded.ticker, cik=excluded.cik,
        geography=excluded.geography, industry=excluded.industry, updated_at=excluded.updated_at`);
    for (const e of catalog.entities) ent.run(e.entity_id, e.entity_type, e.name, e.ticker || null, e.cik || null, e.geography || null, e.industry || null, now);

    const ser = db.prepare(`INSERT INTO series (series_id, source_id, entity_id, metric_name, label, unit, frequency, category, industry, geography,
        polarity, transform, retention_class, cross_check, cadence_minutes, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (series_id) DO UPDATE SET source_id=excluded.source_id, entity_id=excluded.entity_id, metric_name=excluded.metric_name,
        label=excluded.label, unit=excluded.unit, frequency=excluded.frequency, category=excluded.category, industry=excluded.industry,
        geography=excluded.geography, polarity=excluded.polarity, transform=excluded.transform, retention_class=excluded.retention_class,
        cross_check=excluded.cross_check, cadence_minutes=excluded.cadence_minutes, enabled=1, updated_at=excluded.updated_at`);
    for (const s of catalog.series) {
      ser.run(s.series_id, s.source_id, s.entity_id, s.metric_name, s.label, s.unit, s.frequency, s.category, s.industry || null, s.geography || null,
        s.polarity || 0, s.transform || "level", s.retention_class, s.cross_check || null, s.cadence_minutes, now);
    }
    // Series dropped from config stop being collected and served; their history ages out under retention.
    const ids = new Set(catalog.series.map((s) => s.series_id));
    for (const r of db.prepare("SELECT series_id FROM series WHERE enabled = 1").all()) {
      if (!ids.has(r.series_id)) {
        db.prepare("UPDATE series SET enabled = 0, updated_at = ? WHERE series_id = ?").run(now, r.series_id);
        db.prepare("UPDATE alerts SET resolved_at = ? WHERE series_id = ? AND resolved_at IS NULL").run(now, r.series_id);
      }
    }
  });
}

function kvGet(db, k) {
  const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k);
  return r ? JSON.parse(r.v) : null;
}

function kvSet(db, k, v) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
}

// Open alerts are deduplicated: repeating the same problem bumps count/last_seen instead of adding rows.
function raiseAlert(db, { kind, source_id = null, series_id = null, entity_id = null, detail, key }, now = new Date().toISOString()) {
  const dedupe = key || [kind, source_id, series_id, entity_id].join("|");
  const open = db.prepare("SELECT id FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL").get(dedupe);
  if (open) {
    db.prepare("UPDATE alerts SET last_seen = ?, count = count + 1, detail = ? WHERE id = ?").run(now, String(detail).slice(0, 1000), open.id);
    return open.id;
  }
  return Number(db.prepare(`INSERT INTO alerts (kind, source_id, series_id, entity_id, detail, dedupe_key, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, source_id, series_id, entity_id, String(detail).slice(0, 1000), dedupe, now, now).lastInsertRowid);
}

function resolveAlerts(db, { kind, source_id = null, series_id = null, entity_id = null, key }, now = new Date().toISOString()) {
  const dedupe = key || [kind, source_id, series_id, entity_id].join("|");
  db.prepare("UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL").run(now, dedupe);
}

module.exports = { open, tx, migrate, dbFile, syncCatalog, kvGet, kvSet, raiseAlert, resolveAlerts, DATA_DIR };
