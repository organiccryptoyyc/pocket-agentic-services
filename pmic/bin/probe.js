#!/usr/bin/env node
// Live check of sources against their real APIs, into a throwaway database: nothing touches the
// collector's data, nothing is pushed. Prints one line per source and per series with how many
// observations parsed and the latest value, then FAILED lines with the reason.
//
//   node bin/probe.js                         the batch 2 sources
//   node bin/probe.js --source ecb,fdic       only these
//
// On the Pi, without rebuilding the image: sh ops/probe-batch2.sh (uses ~/pmic-src/pmic/.env)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");

const BATCH2 = ["ecb", "fdic", "cfpb", "wikimedia", "ctgov", "cpsc", "nhtsa", "fec", "lda", "usaspending", "pinksheet"];
const BATCH2_SERIES = /^(fred:(DGS1MO|DGS3MO|DGS1|DGS5|DGS30|T10Y3M|PALUMUSDM|PNICKUSDM|PZINCUSDM|PIORECRUSDM|MTSO133FMS|MTSR133FMS|MTSDS133FMS)|openfda:food:|sec:(AAPL|PFE):insider_(buy|sell)_value_weekly)/;

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--source");
  const sources = i >= 0 && args[i + 1] ? args[i + 1].split(",") : BATCH2;
  const catalog = catalogLib.load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-probe-"));
  const d = db.open({ dataDir: dir });
  const started = Date.now();
  const seriesIds = i >= 0 ? null : catalog.series.filter((s) => BATCH2.includes(s.source_id) || BATCH2_SERIES.test(s.series_id)).map((s) => s.series_id);
  console.log(`probing ${seriesIds ? seriesIds.length : "all"} series from ${sources.join(", ")}${seriesIds ? " plus the new FRED, food and Form 4 series" : ""} (this can take a few minutes: Form 4 documents and lobbying counts are read slowly on purpose)`);
  const summary = await collectOnce(d, catalog, { dataDir: dir, sources: seriesIds ? null : sources, seriesIds, force: true });
  let failed = 0;
  for (const s of summary.sources) {
    console.log(`\n${s.source_id}: ${s.series} series, ${s.inserted} observations, ${s.events} events${s.failed.length ? `, ${s.failed.length} FAILED` : ""}${s.error ? `, ERROR ${s.error}` : ""}`);
    for (const n of s.notes || []) console.log(`  note: ${n}`);
    for (const ser of catalog.series.filter((x) => x.source_id === s.source_id && (!seriesIds || seriesIds.includes(x.series_id)))) {
      const r = d.prepare("SELECT COUNT(*) n, MAX(observation_time) t FROM observations WHERE series_id = ?").get(ser.series_id);
      const last = r.n ? d.prepare("SELECT metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1").get(ser.series_id).v : null;
      const f = s.failed.find((x) => x.series_id === ser.series_id);
      if (f) failed++;
      console.log(`  ${f ? "FAILED" : r.n ? "ok    " : "EMPTY "} ${ser.series_id}: ${r.n} obs${r.n ? `, latest ${r.t} = ${Math.round(last * 1000) / 1000}` : ""}${f ? ` (${f.kind}: ${String(f.message).slice(0, 160)})` : ""}`);
    }
  }
  console.log(`\n${failed ? `${failed} series FAILED` : "all series ok"} in ${Math.round((Date.now() - started) / 1000)} s`);
  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`probe error: ${e.stack || e}`);
  process.exit(1);
});
