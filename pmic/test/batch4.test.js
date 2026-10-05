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
  const { db, summary } = await run(["pokt", "defillama", "nifc", "noaa", "tsa", "imf", "fedreg", "cms", "secftd"]);
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

test("batch 4 second half: calendar, OECD, warning letters, Congress, ECHO, Form 990 and 13F", async () => {
  const { db, summary } = await run(["releases", "oecd", "fdawl", "congress", "echo", "irs990", "sec13f"], { ...ENV, CONGRESS_API_KEY: "k" });
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  assert.equal(obs(db, "releases:major_releases_next_30d").length, 1, "a daily snapshot");
  const upcoming = db.prepare("SELECT event_time t, severity s, title FROM events WHERE event_type = 'scheduled_release' AND event_time > '2026-10-04T06' ORDER BY event_time").all();
  assert.ok(upcoming.length > 10 && upcoming.some((e) => e.s === "high") && upcoming.some((e) => e.s === "low"));
  assert.ok(upcoming.every((e) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.t)), "UTC times");
  assert.ok(upcoming.some((e) => e.t.endsWith("T12:30:00Z")), "08:30 Eastern in October is 12:30 UTC");
  assert.ok(obs(db, "oecd:de:CLI").length >= 20);
  assert.ok(obs(db, "oecd:de:CLI").every((o) => o.v > 95 && o.v < 105), "amplitude-adjusted rows only");
  const all = obs(db, "fdawl:warning_letters_monthly");
  const drug = obs(db, "fdawl:drug_warning_letters_monthly");
  assert.ok(all.length >= 20 && drug.every((o, i) => o.v <= all[i].v));
  const letters = db.prepare("SELECT entity_id e FROM events WHERE event_type = 'warning_letter'").all();
  assert.ok(letters.length > 0 && letters.some((x) => x.e === "pfe"), "a Pfizer letter is tied to Pfizer");
  assert.ok(obs(db, "congress:bills_introduced_monthly").length >= 20);
  assert.ok(obs(db, "congress:laws_enacted_monthly").some((o) => o.v > 0));
  assert.ok(db.prepare("SELECT COUNT(*) n FROM events WHERE event_type = 'public_law'").get().n > 0);
  const pen = obs(db, "echo:penalties_usd_monthly");
  assert.ok(pen.length >= 20 && pen.every((o) => o.v > 0));
  assert.ok(obs(db, "echo:judicial_cases_monthly").every((o) => o.v >= 20));
  const rev = obs(db, "irs990:total_revenue");
  assert.deepEqual(rev.map((o) => o.t), ["2018-01-01", "2019-01-01", "2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01", "2024-01-01"], "from 2018; 2025 is not out yet");
  assert.ok(obs(db, "irs990:filers").every((o) => o.v > 2000));
  const holders = obs(db, "sec13f:AAPL:institutional_holders");
  assert.equal(holders.length, 11, "Q4 2023 to Q2 2026");
  assert.equal(holders[holders.length - 1].t, "2026-04-01", "the Jun-Aug 2026 window is the June quarter");
  assert.ok(holders.every((o) => o.v > 150 && o.v < 400), "late filers and options are left out");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fetch_logs WHERE source_id = 'sec13f' AND url LIKE '%.zip'").get().n, 11);
});

test("bulk zips are read once and not kept in the raw store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-b4bulk-"));
  const db = dbLib.open({ dataDir: dir });
  const fetchImpl = makeFetch(catalog, { now: NOW });
  await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: ENV, fetchImpl, sources: ["irs990", "sec13f"] });
  const raw = require("../lib/raw");
  const log = db.prepare("SELECT raw_file, raw_sha256, bytes FROM fetch_logs WHERE url LIKE '%eoextract990.zip' AND http_status = 200 LIMIT 1").get();
  assert.ok(log.bytes > 10000);
  assert.match(raw.read(dir, log.raw_file, log.raw_sha256).body, /^\[bulk file not kept: \d+ bytes, sha256 [0-9a-f]{64}\]$/);
  const later = new Date(NOW.getTime() + 8 * 86400000);
  await collectOnce(db, catalog, { now: later, dataDir: dir, env: ENV, fetchImpl, sources: ["irs990", "sec13f"], force: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fetch_logs WHERE url LIKE '%.zip' AND http_status = 200").get().n, 18, "no zip is downloaded twice");
});

test("congress without a key: laws only", async () => {
  const { db, summary } = await run(["congress"], {});
  const s = summary.sources.find((x) => x.source_id === "congress");
  assert.ok(obs(db, "congress:laws_enacted_monthly").length >= 20);
  assert.equal(obs(db, "congress:bills_introduced_monthly").length, 0);
  assert.ok(JSON.stringify(s).includes("CONGRESS_API_KEY"));
});

test("release calendar: unfolded lines, Eastern times to UTC, major releases", () => {
  const { icsEvents, startUtc, isMajor } = require("../lib/adapters/releases");
  const ev = icsEvents("BEGIN:VEVENT\r\nSUMMARY:Gross Domestic Product\, 3rd Quarter\r\n  (Advance)\r\nDTSTART;TZID=US-Eastern:20260115T083000\r\nUID:x\r\nEND:VEVENT\r\n");
  assert.equal(ev[0].SUMMARY, "Gross Domestic Product, 3rd Quarter (Advance)");
  assert.equal(startUtc(ev[0]), "2026-01-15T13:30:00Z", "EST is UTC-5");
  assert.equal(startUtc({ DTSTART: "20260715T083000", DTSTART_TZID: "US-Eastern" }), "2026-07-15T12:30:00Z", "EDT is UTC-4");
  assert.equal(startUtc({ DTSTART: "20261029T123000Z" }), "2026-10-29T12:30:00Z");
  assert.ok(isMajor("Employment Situation") && !isMajor("Real Earnings"));
});

test("13F dates and data set links", () => {
  const { secDate, windowsOf } = require("../lib/adapters/sec13f");
  assert.equal(secDate("30-JUN-2026"), "2026-06-30");
  const w = windowsOf('<a href="/files/x/data/form-13f-data-sets/01dec2025-28feb2026_form13f.zip">x</a><a href="/files/x/2023q4_form13f.zip">old</a>');
  assert.deepEqual(w.map((x) => x.end), ["2026-02-28"]);
});
