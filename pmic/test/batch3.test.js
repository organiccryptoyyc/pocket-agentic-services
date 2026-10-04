// Batch 3 adapters: parsing and edge cases against the stub (the live check is bin/probe.js).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");
const { makeFetch } = require("./stub-upstream");

const NOW = new Date("2026-10-04T06:00:00Z");
const catalog = catalogLib.load();
const ENV = { PATENTSVIEW_API_KEY: "k", PMIC_NVD_GAP_MS: "0", PMIC_PATENTSVIEW_GAP_MS: "0", PMIC_SEC_USER_AGENT: "t t@example.com" };

async function run(sources, env = ENV) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-b3-"));
  const db = dbLib.open({ dataDir: dir });
  const summary = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env, fetchImpl: makeFetch(catalog, { now: NOW }), sources });
  return { db, summary };
}
const obs = (db, id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time").all(id);

test("treasury: monthly means over auctions; TIPS stay out of the yield spread", () => {
  const { auctionsOf, monthlyMeans } = require("../lib/adapters/treasury");
  const rows = auctionsOf([
    { cusip: "A", auctionDate: "2026-08-05T00:00:00", bidToCoverRatio: "2.400000", totalAccepted: "100", indirectBidderAccepted: "60", primaryDealerAccepted: "10", highYield: "5.10", averageMedianYield: "5.04", tips: "No" },
    { cusip: "B", auctionDate: "2026-08-20T00:00:00", bidToCoverRatio: "2.600000", totalAccepted: "100", indirectBidderAccepted: "40", primaryDealerAccepted: "20", highYield: "2.10", averageMedianYield: "1.90", tips: "Yes" },
  ]);
  assert.deepEqual(monthlyMeans(rows, "btc", "2026-08-01", NOW), [["2026-08-01", 2.5]]);
  assert.deepEqual(monthlyMeans(rows, "indirect", "2026-08-01", NOW), [["2026-08-01", 0.5]]);
  assert.deepEqual(monthlyMeans(rows, "spread_bp", "2026-08-01", NOW), [["2026-08-01", 6]], "the TIPS auction has no nominal spread");
});

test("fema counts each disaster once, not once per county", () => {
  const { declarationsOf } = require("../lib/adapters/fema");
  const d = declarationsOf([
    { disasterNumber: 1, declarationDate: "2026-09-01T00:00:00.000Z", declarationType: "DR", state: "TX" },
    { disasterNumber: 1, declarationDate: "2026-09-01T00:00:00.000Z", declarationType: "DR", state: "TX" },
    { disasterNumber: 2, declarationDate: "2026-09-03T00:00:00.000Z", declarationType: "EM", state: "FL" },
  ]);
  assert.equal(d.length, 2);
  assert.equal(d.find((x) => x.number === 1).areas, 2);
});

test("batch 3 sources collect against the stub, with events", async () => {
  const { db, summary } = await run(["treasury", "fema", "usgs", "nws", "cisa", "nvd", "cdc", "patentsview"]);
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  assert.ok(obs(db, "treasury:bid_to_cover_monthly").length >= 20);
  assert.ok(obs(db, "fema:declarations_monthly").length >= 20);
  assert.equal(obs(db, "nws:severe_alerts_active").length, 1, "a daily snapshot");
  assert.equal(obs(db, "nws:severe_alerts_active")[0].v, 12, "Severe and Extreme only");
  assert.ok(obs(db, "cisa:kev_added_weekly").length >= 50);
  assert.ok(obs(db, "nvd:critical_cves_monthly").every((o) => o.v >= 150 && o.v < 210));
  assert.ok(obs(db, "cdc:ed_flu_weekly").length >= 50);
  assert.ok(obs(db, "patentsview:AAPL:patent_grants_monthly").length >= 20);
  const types = new Set(db.prepare("SELECT DISTINCT event_type t FROM events").all().map((r) => r.t));
  for (const t of ["disaster_declaration", "earthquake", "exploited_vulnerability"]) assert.ok(types.has(t), t);
});

test("patentsview without a key is skipped with a missing_key alert, not a failure loop", async () => {
  const { db, summary } = await run(["patentsview"], { PMIC_PATENTSVIEW_GAP_MS: "0" });
  const s = summary.sources.find((x) => x.source_id === "patentsview");
  assert.ok(s.failed.every((f) => f.kind === "missing_key"));
  assert.equal(obs(db, "patentsview:AAPL:patent_grants_monthly").length, 0);
});

test("drug shortages: new postings and discontinuations by first posting date", async () => {
  const { db } = await run(["openfda"], {});
  const added = obs(db, "openfda:drug_shortages_new_weekly").reduce((a, o) => a + o.v, 0);
  const disc = obs(db, "openfda:drug_discontinuations_weekly").reduce((a, o) => a + o.v, 0);
  assert.ok(added > 50 && disc > 5 && disc < added);
  const ev = db.prepare("SELECT entity_id e, severity s FROM events WHERE event_type = 'drug_shortage'").all();
  assert.ok(ev.some((x) => x.e === "pfe"), "a Pfizer shortage is tied to Pfizer");
  const { usDate } = require("../lib/adapters/openfda");
  assert.equal(usDate("9/7/2026"), "2026-09-07");
});
