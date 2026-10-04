#!/usr/bin/env node
// Finds the current ECB key for a stale series: lists every series in a wildcard query whose latest
// observation is recent, with its title. Default: euro area HICP annual rates, any area code.
//
//   node bin/find-ecb.js                          ICP M..N..4.ANR, titles matching "overall|all-items"
//   node bin/find-ecb.js ICP "M.U2..." "energy"   another flow, key and title filter
"use strict";

const { fetchText } = require("../lib/net");
const { csvObjects } = require("../lib/adapters/common");

async function main() {
  const [flow = "ICP", key = "M..N..4.ANR", match = "overall|all[- ]items"] = process.argv.slice(2);
  const url = `https://data-api.ecb.europa.eu/service/data/${flow}/${key}?format=csvdata&lastNObservations=1`;
  console.log(`reading ${url}`);
  const r = await fetchText(url, { headers: { Accept: "text/csv" } }, { timeoutMs: 120000 });
  console.log(`HTTP ${r.status}, ${r.text.length} bytes`);
  if (r.status !== 200) return console.log(r.text.slice(0, 500));
  const rows = csvObjects(r.text);
  const re = new RegExp(match, "i");
  const hits = rows.filter((x) => re.test(`${x.TITLE || ""} ${x.TITLE_COMPL || ""}`)).sort((a, b) => (a.TIME_PERIOD < b.TIME_PERIOD ? 1 : -1));
  console.log(`${rows.length} series, ${hits.length} with a matching title; freshest first:`);
  for (const x of hits.slice(0, 25)) console.log(`  ${x.TIME_PERIOD}  ${x.KEY}  = ${x.OBS_VALUE}  ${x.TITLE}`);
  const periods = [...new Set(rows.map((x) => x.TIME_PERIOD))].sort().slice(-3);
  console.log(`latest periods anywhere in the answer: ${periods.join(", ")}`);
}

main().catch((e) => {
  console.error(`find-ecb error: ${e.message}`);
  process.exit(1);
});
