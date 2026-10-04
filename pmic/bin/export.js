#!/usr/bin/env node
// CSV export of the normalized store.
//   node bin/export.js scores                 latest score per series
//   node bin/export.js observations fred:UNRATE
//   node bin/export.js events [entity_id]
//   node bin/export.js alerts                 open alerts, grouped by kind and source, then each one
// Writes to stdout.
"use strict";

const db = require("../lib/db");

function csv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const [what, arg] = process.argv.slice(2);
const d = db.open({ readOnly: true });
if (!d) {
  console.error("no database yet");
  process.exit(1);
}
let rows;
if (what === "scores") {
  rows = d.prepare(`SELECT s.series_id, s.entity_id, s.metric_name, s.source_id, s.as_of, s.current_value, s.unit, s.pct_change_7d, s.pct_change_30d,
    s.pct_change_90d, s.pct_change_365d, s.zscore, s.percentile, s.freshness_score, s.reliability_score, s.composite_score, s.trend,
    s.confidence_score, s.confidence_label, s.risk_flags, s.citation_url, s.rationale
    FROM scores s WHERE s.rowid = (SELECT rowid FROM scores x WHERE x.series_id = s.series_id ORDER BY x.as_of DESC, x.computed_at DESC LIMIT 1)
    ORDER BY s.series_id`).all();
} else if (what === "observations" && arg) {
  rows = d.prepare("SELECT series_id, observation_time, period, metric_value, unit, fetch_time, source_url, raw_sha256, qc_flags, revision FROM observations WHERE series_id = ? ORDER BY observation_time").all(arg);
} else if (what === "events") {
  rows = d.prepare("SELECT source_id, entity_id, event_type, event_time, severity, title, source_url FROM events WHERE (? IS NULL OR entity_id = ?) ORDER BY event_time DESC").all(arg || null, arg || null);
} else if (what === "alerts") {
  const summary = d.prepare("SELECT kind, source_id, COUNT(*) n FROM alerts WHERE resolved_at IS NULL GROUP BY kind, source_id ORDER BY n DESC").all();
  process.stdout.write(csv(summary) + "\n");
  rows = d.prepare("SELECT kind, source_id, series_id, count, last_seen, detail FROM alerts WHERE resolved_at IS NULL ORDER BY kind, series_id").all();
} else {
  console.error("usage: export.js scores | observations <series_id> | events [entity_id] | alerts");
  process.exit(2);
}
process.stdout.write(csv(rows));
