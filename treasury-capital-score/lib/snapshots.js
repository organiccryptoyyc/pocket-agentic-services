// Snapshot history store (CLAUDE §10 D5): one SQLite file per network on that network's data
// volume, <TCS6_DATA_DIR>/snapshots.db. Uses Node's built-in node:sqlite, so still zero npm
// dependencies (Node >= 22.13; the deploy image is node:22-alpine).
//
//   - Writers (pipeline, ingest) open read-write; the API opens read-only.
//   - File mode 600; WAL journal; parameterized statements only.
//   - snapshot_id = snap_<sha256(canonical bundle)>; every read re-hashes the stored bundle and
//     refuses it if the hash no longer matches its id.
//   - Migrations in ../migrations are applied in order, recorded in schema_migrations, and never
//     delete snapshot rows.
//   - backupIfDue() writes snapshots-backup-<YYYY-MM-DD>.db inside the same volume once a day;
//     sizeStatus() flags the file above 1 GB.
// Not exposed on any port and never shipped in a deploy folder: it lives only on the volume.
"use strict";

const fs = require("fs");
const path = require("path");
const { canonicalJson, snapshotId } = require("./canonical");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const SIZE_ALERT_BYTES = 1024 ** 3;

function loadSqlite() {
  // node:sqlite prints an ExperimentalWarning on first load in Node 22/24; silence only that one.
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

function dbPath(dataDir) {
  return path.join(dataDir, "snapshots.db");
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    if (/\b(DROP\s+TABLE\s+snapshots|DELETE\s+FROM\s+snapshots)\b/i.test(sql)) throw new Error(`migration ${f} would delete snapshot rows`);
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

function open(dataDir, { readOnly = false } = {}) {
  const { DatabaseSync } = loadSqlite();
  const file = dbPath(dataDir);
  if (readOnly) {
    if (!fs.existsSync(file)) return null;
    return wrap(new DatabaseSync(file, { readOnly: true }), file, true);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX hosts */ }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return wrap(db, file, false);
}

function wrap(db, file, readOnly) {
  function verify(row) {
    if (!row) return null;
    const bundle = JSON.parse(row.bundle_json);
    if (snapshotId(bundle) !== row.snapshot_id) throw new Error(`snapshot ${row.snapshot_id} failed its integrity check`);
    return { snapshot_id: row.snapshot_id, entity_id: row.entity_id, collected_at: row.collected_at, stored_at: row.stored_at, bundle };
  }

  return {
    file,
    readOnly,

    // Idempotent: the same bundle always maps to the same id and is stored once.
    putSnapshot(bundle, storedAt = new Date().toISOString()) {
      if (readOnly) throw new Error("snapshot store opened read-only");
      const id = snapshotId(bundle);
      db.prepare("INSERT OR IGNORE INTO snapshots (snapshot_id, entity_id, collected_at, stored_at, bundle_json) VALUES (?, ?, ?, ?, ?)")
        .run(id, String(bundle.entity_id), String(bundle.collected_at), storedAt, canonicalJson(bundle));
      return id;
    },

    putReport({ snapshot_id, spec_version, weights_version, report, peer_nrts, built_at = new Date().toISOString() }) {
      if (readOnly) throw new Error("snapshot store opened read-only");
      db.prepare(`INSERT OR REPLACE INTO reports (snapshot_id, spec_version, weights_version, schema_version, peer_nrts_json,
                  analysis_status, overall_score, built_at, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshot_id, spec_version, weights_version, report.schema_version, JSON.stringify(peer_nrts || []),
          report.analysis_status, report.overall_score ? report.overall_score.score : null, built_at, JSON.stringify(report));
    },

    getSnapshot(id) {
      return verify(db.prepare("SELECT * FROM snapshots WHERE snapshot_id = ?").get(String(id)));
    },

    latestSnapshot(entityId) {
      return verify(db.prepare("SELECT * FROM snapshots WHERE entity_id = ? ORDER BY collected_at DESC LIMIT 1").get(String(entityId)));
    },

    // Score history for trend: newest first, ids and scores only.
    history(entityId, limit = 30) {
      return db.prepare(`SELECT s.snapshot_id, s.collected_at, r.spec_version, r.weights_version, r.analysis_status, r.overall_score, r.built_at
                         FROM snapshots s JOIN reports r ON r.snapshot_id = s.snapshot_id
                         WHERE s.entity_id = ? ORDER BY s.collected_at DESC, r.built_at DESC LIMIT ?`)
        .all(String(entityId), Math.max(1, Math.min(500, Number(limit) || 30)));
    },

    reportsFor(id) {
      return db.prepare("SELECT spec_version, weights_version, schema_version, peer_nrts_json, built_at, report_json FROM reports WHERE snapshot_id = ? ORDER BY built_at")
        .all(String(id)).map((r) => ({ ...r, peer_nrts: JSON.parse(r.peer_nrts_json), report: JSON.parse(r.report_json) }));
    },

    counts() {
      return {
        snapshots: db.prepare("SELECT COUNT(*) n FROM snapshots").get().n,
        reports: db.prepare("SELECT COUNT(*) n FROM reports").get().n,
      };
    },

    sizeStatus() {
      let bytes = 0;
      for (const f of [file, `${file}-wal`]) { try { bytes += fs.statSync(f).size; } catch { /* absent */ } }
      return { bytes, alert: bytes > SIZE_ALERT_BYTES, alert_threshold_bytes: SIZE_ALERT_BYTES };
    },

    // One backup per UTC day, kept beside the database on the same volume.
    backupIfDue(now = new Date()) {
      if (readOnly) return null;
      const target = path.join(path.dirname(file), `snapshots-backup-${now.toISOString().slice(0, 10)}.db`);
      if (fs.existsSync(target)) return null;
      db.prepare("VACUUM INTO ?").run(target);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
      return target;
    },

    close() { db.close(); },
  };
}

module.exports = { open, dbPath, SIZE_ALERT_BYTES };
