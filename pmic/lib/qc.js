// Quality control at ingestion: impossible values are rejected, the rest are upserted on the
// spec's dedupe key (source_id, entity_id, observation_time, metric_name). A changed value on
// re-fetch is a source revision: the old value moves to observation_revisions and the row's
// revision counter goes up, so the provenance trail survives. Jumps that are extreme against the
// series' own history of changes are stored but flagged as outliers and alerted.
"use strict";

const { raiseAlert } = require("./db");

const TRANSFORM_VERSION = "pmic-ingest/1.0";
const OUTLIER_ROBUST_Z = 8;
// Only new data is checked: a historical backfill is what the source published, and real shocks
// (2020 GDP, a winter gas spike, a bond issue) are not errors. "New" = within one period plus the
// usual publication lag of the series' frequency.
const OUTLIER_RECENT_DAYS = { daily: 10, weekly: 30, monthly: 120, quarterly: 270, annual: 1000 };
// A step must also be at least this many times the largest step in the recent window, so lumpy
// series with a tiny median step (debt, filings) are not flagged for an ordinary jump.
const OUTLIER_MAX_STEP_MULT = 2;

function impossible(series, v) {
  if (!Number.isFinite(v)) return "value is not a finite number";
  if (series.bounds) {
    if (series.bounds.min !== undefined && v < series.bounds.min) return `below configured minimum ${series.bounds.min}`;
    if (series.bounds.max !== undefined && v > series.bounds.max) return `above configured maximum ${series.bounds.max}`;
  }
  switch (series.unit) {
    case "count":
      return v < 0 || !Number.isInteger(v) ? "count must be a non-negative integer" : null;
    case "index":
      return v <= 0 ? "index level must be positive" : null;
    case "percent":
      return v < -100 || v > 10000 ? "percent outside -100..10000" : null;
    case "thousands":
      return v < 0 ? "level in thousands cannot be negative" : null;
    default:
      return null;
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Robust z of this observation's step from its predecessor, against the series' recent steps.
function outlierScore(db, series, obsTime, v, nowIso = new Date().toISOString()) {
  const recentDays = OUTLIER_RECENT_DAYS[series.frequency] || 30;
  if (Date.parse(nowIso) - Date.parse(`${obsTime.slice(0, 10)}T00:00:00Z`) > recentDays * 86400000) return null;
  const prior = db.prepare(`SELECT metric_value FROM observations WHERE series_id = ? AND observation_time < ?
    ORDER BY observation_time DESC LIMIT 25`).all(series.series_id, obsTime).map((r) => r.metric_value).reverse();
  if (prior.length < 13) return null;
  const steps = [];
  for (let i = 1; i < prior.length; i++) steps.push(prior[i] - prior[i - 1]);
  const med = median(steps);
  const mad = median(steps.map((x) => Math.abs(x - med)));
  if (!(mad > 0)) return null;
  const step = v - prior[prior.length - 1];
  if (Math.abs(step) < OUTLIER_MAX_STEP_MULT * Math.max(...steps.map(Math.abs))) return null;
  return (step - med) / (1.4826 * mad);
}

function baseConfidence(source, flags) {
  let c = source.reliability_score;
  if (flags.includes("preliminary")) c -= 10;
  if (flags.includes("outlier")) c -= 25;
  return Math.max(0, Math.min(100, c));
}

// rec: {series_id, observation_time, period, value, source_url, raw_sha256, qc_flags?}
// Returns "inserted" | "revised" | "unchanged" | "rejected".
function ingestObservation(db, ctx, series, rec) {
  const now = ctx.nowIso;
  const bad = impossible(series, rec.value);
  if (bad) {
    raiseAlert(db, { kind: "impossible_value", source_id: series.source_id, series_id: series.series_id, entity_id: series.entity_id,
      detail: `${rec.observation_time}: ${rec.value} rejected (${bad})`, key: `impossible|${series.series_id}|${rec.observation_time}` }, now);
    return "rejected";
  }
  const existing = db.prepare(`SELECT id, metric_value, revision, qc_flags, fetch_time, raw_sha256 FROM observations
    WHERE source_id = ? AND entity_id = ? AND observation_time = ? AND metric_name = ?`)
    .get(series.source_id, series.entity_id, rec.observation_time, series.metric_name);
  const flags = new Set(rec.qc_flags || []);

  if (existing) {
    const same = Math.abs(existing.metric_value - rec.value) <= 1e-9 * Math.max(1, Math.abs(rec.value));
    const oldFlags = JSON.parse(existing.qc_flags);
    if (same) {
      // A value that was preliminary and is now final clears the flag.
      if (oldFlags.includes("preliminary") && !flags.has("preliminary")) {
        const kept = oldFlags.filter((f) => f !== "preliminary");
        db.prepare("UPDATE observations SET qc_flags = ?, confidence_score = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(kept), baseConfidence(ctx.source, kept), now, existing.id);
      }
      return "unchanged";
    }
    db.prepare(`INSERT OR IGNORE INTO observation_revisions (observation_id, revision, metric_value, fetch_time, raw_sha256, replaced_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(existing.id, existing.revision, existing.metric_value, existing.fetch_time, existing.raw_sha256, now);
    for (const f of oldFlags) if (f === "outlier") flags.add(f);
    flags.add("revised");
    const list = [...flags];
    db.prepare(`UPDATE observations SET metric_value = ?, period = ?, fetch_time = ?, source_url = ?, raw_sha256 = ?, qc_flags = ?,
      confidence_score = ?, revision = revision + 1, transform_version = ?, updated_at = ? WHERE id = ?`)
      .run(rec.value, rec.period || null, now, rec.source_url, rec.raw_sha256 || null, JSON.stringify(list), baseConfidence(ctx.source, list), TRANSFORM_VERSION, now, existing.id);
    return "revised";
  }

  const z = outlierScore(db, series, rec.observation_time, rec.value, now);
  if (z !== null && Math.abs(z) >= OUTLIER_ROBUST_Z) {
    flags.add("outlier");
    raiseAlert(db, { kind: "outlier", source_id: series.source_id, series_id: series.series_id, entity_id: series.entity_id,
      detail: `${rec.observation_time}: ${rec.value} is a step of robust z ${z.toFixed(1)} against recent changes`, key: `outlier|${series.series_id}|${rec.observation_time}` }, now);
  }
  const list = [...flags];
  db.prepare(`INSERT INTO observations (source_id, series_id, entity_id, metric_name, metric_value, unit, observation_time, period, fetch_time,
      source_url, raw_sha256, transform_version, retention_class, confidence_score, qc_flags, revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(series.source_id, series.series_id, series.entity_id, series.metric_name, rec.value, series.unit, rec.observation_time, rec.period || null,
      now, rec.source_url, rec.raw_sha256 || null, TRANSFORM_VERSION, series.retention_class, baseConfidence(ctx.source, list), JSON.stringify(list), now);
  return "inserted";
}

// Events are immutable facts keyed by (source_id, external_id); a re-fetch only refreshes detail.
function ingestEvent(db, ctx, ev) {
  const now = ctx.nowIso;
  const cls = ev.severity === "high" ? "event_high" : "event_standard";
  const r = db.prepare(`INSERT INTO events (source_id, external_id, entity_id, event_type, event_time, title, severity, detail_json, source_url,
      raw_sha256, fetch_time, retention_class, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, external_id) DO UPDATE SET title = excluded.title, severity = excluded.severity, detail_json = excluded.detail_json,
      retention_class = excluded.retention_class, updated_at = excluded.updated_at
    WHERE events.detail_json <> excluded.detail_json OR events.severity <> excluded.severity`)
    .run(ctx.source.source_id, ev.external_id, ev.entity_id, ev.event_type, ev.event_time, String(ev.title).slice(0, 400), ev.severity,
      JSON.stringify(ev.detail || {}), ev.source_url, ev.raw_sha256 || null, now, cls, now);
  return Number(r.changes) > 0;
}

module.exports = { ingestObservation, ingestEvent, impossible, outlierScore, median, TRANSFORM_VERSION, OUTLIER_ROBUST_Z, OUTLIER_RECENT_DAYS };
