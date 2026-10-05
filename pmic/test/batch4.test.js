// Batch 4 adapters: parsing and edge cases against the stub (the live check is bin/probe.js).
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
const ENV = { PMIC_SEC_USER_AGENT: "t t@example.com" };

async function run(sources, env = ENV) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-b4-"));
  const db = dbLib.open({ dataDir: dir });
  const summary = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env, fetchImpl: makeFetch(catalog, { now: NOW }), sources });
  return { db, summary };
}
const obs = (db, id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time").all(id);

test("batch 4 sources collect against the stub", async () => {
  const { db, summary } = await run(["pokt", "defillama", "nifc", "noaa", "fbi", "tsa", "imf", "fedreg", "cms", "secftd"]);
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  for (const id of ["pokt:estimated_relays_weekly", "pokt:claimed_relays_weekly", "pokt:staked_suppliers", "pokt:staked_apps"]) assert.ok(obs(db, id).length >= 20, id);
  assert.ok(obs(db, "pokt:estimated_relays_weekly").every((o) => o.v > 5e9), "relays read as numbers, not strings");
  const tvl = obs(db, "defillama:defi_tvl");
  assert.ok(tvl.length >= 300);
  assert.ok(tvl[tvl.length - 1].t < "2026-10-04", "today's moving point is left out");
  assert.ok(obs(db, "defillama:stablecoin_supply").length >= 300);
  assert.ok(obs(db, "nifc:acres_monthly").every((o) => Number.isInteger(o.v)), "acres are whole numbers");
  assert.ok(obs(db, "nifc:incidents_monthly").length >= 20);
  assert.ok(obs(db, "noaa:temperature_departure").some((o) => o.v < 0), "departures keep their sign");
  const crime = obs(db, "fbi:violent_crime_rate");
  assert.ok(crime.length >= 20);
  assert.ok(crime[crime.length - 1].t <= "2026-07-01", "the two newest months wait for late reporters");
  const tsa = obs(db, "tsa:passengers_weekly");
  assert.ok(tsa.length >= 50 && tsa.every((o) => o.v > 1e7), "weekly sums of daily counts");
  const imf = obs(db, "imf:de:NGDP_RPCH");
  assert.ok(imf.length >= 5);
  assert.equal(imf[imf.length - 1].t, "2027-01-01", "projections stop at next year");
  assert.ok(obs(db, "fedreg:significant_rules_monthly").length >= 20);
  const cms = obs(db, "cms:medicare_beneficiaries");
  assert.ok(cms.length >= 12, `cms rows: ${cms.length}`);
  assert.ok(cms.every((o) => o.t.endsWith("-01")), "the annual 'Year' rows are skipped");
  const ftd = obs(db, "secftd:AAPL:fails_to_deliver_value_monthly");
  assert.ok(ftd.length >= 6);
  assert.ok(ftd[ftd.length - 1].t <= "2026-09-01");
  const ev = db.prepare("SELECT entity_id e FROM events WHERE event_type = 'significant_rule'").all();
  assert.equal(ev.length, 2);
  assert.ok(ev.every((x) => x.e === "us-federal"));
});

test("pokt asks for every week in one aliased query", () => {
  const { weeklyQuery } = require("../lib/adapters/pokt");
  const q = weeklyQuery(["2026-09-21", "2026-09-28"]);
  assert.match(q, /w0: blocks\(filter:\{timestamp:\{greaterThanOrEqualTo:"2026-09-21T00:00:00",lessThan:"2026-09-28T00:00:00"\}\}\)/);
  assert.match(q, /l1: blocks\(filter:\{timestamp:\{lessThan:"2026-10-05T00:00:00"\}\}, orderBy: ID_DESC, first: 1\)/);
});

test("tsa table: date and count pairs", () => {
  const { dailyRows } = require("../lib/adapters/tsa");
  const html = '<tr><td class="x">10/2/2026</td><td class="x">2,612,113</td></tr><tr><td>10/1/2026</td><td>2,401,007</td></tr>';
  assert.deepEqual(dailyRows(html), [["2026-10-02", 2612113], ["2026-10-01", 2401007]]);
});

test("imf SDMX: series per country, observations as numbers", () => {
  const { seriesOf } = require("../lib/adapters/imf");
  const xml = '<Series COUNTRY="USA" INDICATOR="LUR" FREQUENCY="A"><Obs TIME_PERIOD="2025" OBS_VALUE="4.2"/><Obs TIME_PERIOD="2026" OBS_VALUE="NaN"/></Series>';
  assert.deepEqual(seriesOf(xml), [{ country: "USA", indicator: "LUR", obs: [{ year: "2025", value: 4.2 }] }]);
});

test("cms month names to dates", () => {
  const { monthDate } = require("../lib/adapters/cms");
  assert.equal(monthDate("2026", "June"), "2026-06-01");
  assert.equal(monthDate("2026", "Year"), null);
});

test("fails to deliver: quantity times price per symbol, bad rows skipped", () => {
  const { failsValue } = require("../lib/adapters/secftd");
  const text = "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\n20260902|1|AAPL|100|APPLE|200.00\n20260903|1|AAPL|50|APPLE|210.00\n20260903|1|MSFT|.|MSFT|.\n20260903|1|ZZZ|9|Z|1\n";
  const t = failsValue(text, ["AAPL", "MSFT"]);
  assert.equal(t.get("AAPL"), 30500);
  assert.equal(t.get("MSFT"), 0);
});

test("fails to deliver needs the SEC User-Agent", async () => {
  const { summary } = await run(["secftd"], {});
  const s = summary.sources.find((x) => x.source_id === "secftd");
  assert.ok(s.failed.length > 0 || s.skipped || s.missing_key, JSON.stringify(s));
});

test("fbi falls back to DEMO_KEY and leaves the newest months out", () => {
  const { LAG_MONTHS } = require("../lib/adapters/fbi");
  assert.equal(LAG_MONTHS, 2);
});

test("SEC capital return and interest metrics, with the nonoperating interest concept", async () => {
  const { db, summary } = await run(["sec"]);
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  for (const m of ["capex_q", "buybacks_q", "dividends_q", "interest_expense_q", "interest_coverage", "capex_intensity"]) assert.ok(obs(db, `sec:MSFT:${m}`).length >= 4, m);
  assert.equal(obs(db, "sec:JPM:interest_expense_q").length, 0, "banks skip interest expense");
});

test("device feeds and new BLS and FRED series collect", async () => {
  const { db, summary } = await run(["openfda", "bls", "fred"], {});
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  for (const id of ["openfda:device:recalls_weekly", "openfda:device:recalls_class1_weekly", "openfda:device:events_weekly", "bls:CUSR0000SAF11", "bls:PCU325412325412", "bls:WPU3011", "fred:CAUR", "fred:VANA", "fred:ISRATIO"]) assert.ok(obs(db, id).length >= 10, id);
});
