// Migration 008: drops the market FAERS partial week stored before the lag trim, keeps everything else.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");

test("008 removes only the pre-trim 2026-06-29 market FAERS week and touches the last complete week", () => {
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-m008-")) });
  dbLib.syncCatalog(db, catalogLib.load());
  const ins = db.prepare(`INSERT INTO observations (source_id, series_id, entity_id, metric_name, metric_value, unit, observation_time, fetch_time, source_url, transform_version, retention_class, confidence_score, updated_at)
    VALUES ('openfda', ?, ?, 'adverse_event_reports_weekly', ?, 'count', ?, ?, 'u', '1', 'standard', 0.9, '2026-10-04T15:01:55.799Z')`);
  ins.run("openfda:adverse_event_reports_weekly", "us-drug-market", 26375, "2026-06-22", "2026-10-04T15:01:55.799Z");
  ins.run("openfda:adverse_event_reports_weekly", "us-drug-market", 13030, "2026-06-29", "2026-10-04T15:01:55.799Z");
  ins.run("openfda:PFE:adverse_event_reports_weekly", "pfe", 900, "2026-06-29", "2026-10-04T15:01:55.799Z"); // other series: untouched
  db.exec(fs.readFileSync(path.join(__dirname, "..", "migrations", "008_drop_faers_partial_week.sql"), "utf8"));
  const rows = db.prepare("SELECT series_id, observation_time t, updated_at u FROM observations ORDER BY series_id, t").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => [r.series_id, r.t]), [["openfda:PFE:adverse_event_reports_weekly", "2026-06-29"], ["openfda:adverse_event_reports_weekly", "2026-06-22"]]);
  assert.ok(rows[1].u > "2026-10-04T15:01:55.799Z", "the last complete week is resent");
  assert.equal(rows[0].u, "2026-10-04T15:01:55.799Z");
});
