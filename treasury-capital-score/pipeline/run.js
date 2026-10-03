// TCS-6 scoring pipeline: one pass over every scoreable registry entity.
//
//   node pipeline/run.js            # one run, then exit (cron / systemd)
//   node pipeline/run.js --loop     # run now and every TCS6_PIPELINE_INTERVAL_HOURS (default 12)
//
// Two stages because D1 is a same-cohort percentile: first compute every
// entity's NRT, then score each entity against its cohort's NRTs. A report
// only replaces the cached one after it passes schema validation; a failure
// leaves the previous report in place and is recorded in pipeline-state.json.
//
// TCS6_SNAPSHOTS=1 also records every scored bundle and its report in the snapshot history store
// (lib/snapshots.js, <TCS6_DATA_DIR>/snapshots.db). Off by default; it never changes a report, and
// a store failure is recorded in pipeline-state.json without blocking scoring.
"use strict";

const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const store = require("../lib/store");

const MAX_EVIDENCE_AGE_H = Number(process.env.TCS6_MAX_EVIDENCE_AGE_HOURS || 24);
const SPEC_VERSION = "tcs-6/1.0";
const WEIGHTS_VERSION = "blueprint-v1";

function openSnapshots(results) {
  if (process.env.TCS6_SNAPSHOTS !== "1") return null;
  try {
    return require("../lib/snapshots").open(store.DATA_DIR);
  } catch (e) {
    results.snapshot_errors.push(`open: ${String(e && e.message)}`);
    return null;
  }
}

function runOnce(now = new Date()) {
  store.ensureDirs();
  const entities = store.loadRegistry().filter((e) => e.scoreable);
  const results = { started_at: now.toISOString(), scored: [], skipped: [], failed: [], snapshot_errors: [] };
  const snaps = openSnapshots(results);

  const prepared = [];
  for (const entity of entities) {
    const bundle = store.readJson(store.paths.evidence(entity.entity_id));
    if (!bundle) {
      results.skipped.push({ entity_id: entity.entity_id, reason: "no evidence bundle" });
      continue;
    }
    const ageH = (now.getTime() - Date.parse(bundle.collected_at)) / 3.6e6;
    if (!Number.isFinite(ageH) || ageH > MAX_EVIDENCE_AGE_H) {
      results.skipped.push({ entity_id: entity.entity_id, reason: `evidence older than ${MAX_EVIDENCE_AGE_H}h; previous report kept` });
      continue;
    }
    prepared.push({ entity, bundle, base: S.computeBase(bundle) });
  }

  for (const p of prepared) {
    const peers = prepared.filter((q) => q.entity.peer_cohort === p.entity.peer_cohort && q.base.nrt !== null).map((q) => q.base.nrt);
    try {
      const report = buildReport(p.entity, p.bundle, p.base, peers);
      const v = validateReport(report);
      if (!v.ok) {
        results.failed.push({ entity_id: p.entity.entity_id, errors: v.errors.slice(0, 20) });
        continue;
      }
      store.writeJsonAtomic(store.paths.report(p.entity.entity_id), report);
      const scored = { entity_id: p.entity.entity_id, analysis_status: report.analysis_status, score: report.overall_score.score };
      if (snaps) {
        try {
          scored.snapshot_id = snaps.putSnapshot(p.bundle);
          snaps.putReport({ snapshot_id: scored.snapshot_id, spec_version: SPEC_VERSION, weights_version: WEIGHTS_VERSION, report, peer_nrts: peers });
        } catch (e) {
          results.snapshot_errors.push(`${p.entity.entity_id}: ${String(e && e.message)}`);
        }
      }
      results.scored.push(scored);
    } catch (e) {
      results.failed.push({ entity_id: p.entity.entity_id, errors: [String(e && e.message)] });
    }
  }

  if (snaps) {
    try {
      snaps.backupIfDue(now);
      results.snapshots = { ...snaps.counts(), ...snaps.sizeStatus() };
    } catch (e) {
      results.snapshot_errors.push(`backup: ${String(e && e.message)}`);
    }
    snaps.close();
  }
  results.finished_at = new Date().toISOString();
  store.writeJsonAtomic(store.paths.state(), results);
  return results;
}

if (require.main === module) {
  const tick = () => {
    const r = runOnce();
    console.log(JSON.stringify({ pipeline: "tcs6", ...r, scored: r.scored.length, skipped: r.skipped.length, failed: r.failed }));
  };
  tick();
  if (process.argv.includes("--loop")) {
    const hours = Number(process.env.TCS6_PIPELINE_INTERVAL_HOURS || 12);
    setInterval(tick, hours * 3.6e6);
  }
}

module.exports = { runOnce };
