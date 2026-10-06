#!/usr/bin/env node
// Collector entry point.
//
//   node bin/collect.js                 one pass: collect whatever is due, score, maintain, push
//   node bin/collect.js --loop          repeat every PMIC_LOOP_MINUTES (default 15)
//   node bin/collect.js --force         ignore cadence and fetch every selected series now
//   node bin/collect.js --source fred,bls   only these sources
//   node bin/collect.js --series fred:UNRATE
//   node bin/collect.js --rescore       recompute scores from stored data, no fetching
//   node bin/collect.js --maintain      run retention/rollups/backup now
//   node bin/collect.js --push          push to the hub now (needs PMIC_PUSH_URL, PMIC_PUSH_TOKEN)
//   node bin/collect.js --push --resend-events   also send every stored event again
//   node bin/collect.js --push --resend-source echo,irs990   also send every observation of these sources again
//
// Pushing also happens after every pass when PMIC_PUSH_URL is set.
"use strict";

const db = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce, rescoreAll } = require("../lib/collect");
const { maintain } = require("../lib/maintain");
const { push } = require("../lib/sync");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1].split(",").map((x) => x.trim()).filter(Boolean) : null;
};
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

async function pass(d, catalog) {
  const summary = await collectOnce(d, catalog, { dataDir: db.DATA_DIR, force: has("--force"), sources: val("--source"), seriesIds: val("--series") });
  log({ collect: summary.sources.map((s) => ({ source: s.source_id, series: s.series, inserted: s.inserted, revised: s.revised, events: s.events, scored: s.scored, failed: s.failed ? s.failed.length : 0, error: s.error })) , due: summary.due });
  for (const s of summary.sources) for (const f of s.failed || []) log({ failed: f.series_id, kind: f.kind, message: f.message });
  const m = maintain(d, catalog, db.DATA_DIR);
  if (m) log({ maintenance: m });
  if (process.env.PMIC_PUSH_URL) {
    try {
      log({ push: await push(d, { url: process.env.PMIC_PUSH_URL, token: process.env.PMIC_PUSH_TOKEN }) });
    } catch (e) {
      log({ push_error: e.message });
    }
  }
}

async function main() {
  const catalog = catalogLib.load();
  const d = db.open();
  db.syncCatalog(d, catalog);
  require("../lib/raw").purgeSources(db.DATA_DIR, catalog.purged_sources);
  if (has("--rescore")) return log({ rescored: rescoreAll(d, catalog) });
  if (has("--maintain")) return log({ maintenance: maintain(d, catalog, db.DATA_DIR, { force: true }) });
  if (has("--push")) return log({ push: await push(d, { url: process.env.PMIC_PUSH_URL, token: process.env.PMIC_PUSH_TOKEN, resendEvents: has("--resend-events"), resendSources: val("--resend-source") || [] }) });
  if (!has("--loop")) return pass(d, catalog);
  const minutes = Number(process.env.PMIC_LOOP_MINUTES || 15);
  log({ loop: "started", every_minutes: minutes, data_dir: db.DATA_DIR, series: catalog.series.length });
  for (;;) {
    try {
      await pass(d, catalog);
    } catch (e) {
      log({ pass_error: String(e.stack || e) });
    }
    await new Promise((r) => setTimeout(r, minutes * 60000));
  }
}

main().catch((e) => {
  log({ fatal: String(e.stack || e) });
  process.exit(1);
});
