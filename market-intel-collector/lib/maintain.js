// Retention, rollups and backups. Runs once per UTC day from the collector loop (or
// `node bin/collect.js --maintain`). Every horizon comes from config/retention.json.
"use strict";

const fs = require("fs");
const path = require("path");
const raw = require("./raw");
const { rollupWeekly } = require("./derive");
const { kvGet, kvSet } = require("./db");

const DAY = 86400000;

function cutoff(now, days) {
  return new Date(now.getTime() - days * DAY).toISOString();
}

function prune(db, catalog, dataDir, now = new Date()) {
  const R = catalog.retention.classes;
  const out = {};
  const run = (name, sql, ...args) => { out[name] = (out[name] || 0) + Number(db.prepare(sql).run(...args).changes); };

  for (const [cls, days] of Object.entries(R)) {
    run("observations", "DELETE FROM observations WHERE retention_class = ? AND observation_time < ?", cls, cutoff(now, days).slice(0, 10));
  }
  run("observation_revisions", "DELETE FROM observation_revisions WHERE observation_id NOT IN (SELECT id FROM observations)");
  run("events", "DELETE FROM events WHERE retention_class = 'event_standard' AND event_time < ?", cutoff(now, R.event_standard).slice(0, 10));
  run("events", "DELETE FROM events WHERE retention_class = 'event_high' AND event_time < ?", cutoff(now, R.event_high).slice(0, 10));
  // Scores and derived rows age by when they were computed; the newest per series is always kept
  // so a slow (annual) series never loses its only score.
  run("scores", `DELETE FROM scores WHERE computed_at < ? AND as_of < (SELECT MAX(s2.as_of) FROM scores s2 WHERE s2.series_id = scores.series_id)`, cutoff(now, R.scores));
  run("derived_metrics", `DELETE FROM derived_metrics WHERE computed_at < ? AND as_of < (SELECT MAX(d2.as_of) FROM derived_metrics d2 WHERE d2.series_id = derived_metrics.series_id)`, cutoff(now, R.derived));
  run("rollups_weekly", "DELETE FROM rollups_weekly WHERE week_start < ?", cutoff(now, R.rollup_weekly).slice(0, 10));
  run("fetch_logs", "DELETE FROM fetch_logs WHERE started_at < ?", cutoff(now, R.fetch_logs));
  run("alerts", "DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?", cutoff(now, R.alerts));
  out.raw_files = raw.prune(dataDir, R.raw, now);
  return out;
}

function backup(db, dataDir, keep, now = new Date()) {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `pmic-${now.toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(target)) {
    db.prepare("VACUUM INTO ?").run(target);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
  }
  const files = fs.readdirSync(dir).filter((f) => /^pmic-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  return target;
}

function maintain(db, catalog, dataDir, { now = new Date(), force = false } = {}) {
  const day = now.toISOString().slice(0, 10);
  if (!force && kvGet(db, "maintenance_day") === day) return null;
  for (const s of catalog.series.filter((x) => x.frequency === "daily")) rollupWeekly(db, s.series_id);
  const pruned = prune(db, catalog, dataDir, now);
  const backupFile = process.env.PMIC_BACKUPS === "0" ? null : backup(db, dataDir, catalog.retention.backups_to_keep, now);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const result = { day, pruned, backup: backupFile && path.relative(dataDir, backupFile) };
  kvSet(db, "maintenance_day", day);
  kvSet(db, "maintenance_last", result);
  return result;
}

module.exports = { prune, backup, maintain };
