// Batch 2 source parsers: the edge cases each API's docs warn about, without the network.
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
const { pinkSheetXlsx } = require("./stub-batch2");
const { readSheet } = require("../lib/xlsx");
const { pricesFrom } = require("../lib/adapters/pinksheet");
const { monthCounts } = require("../lib/adapters/cfpb");
const { units } = require("../lib/adapters/cpsc");
const { fiscalToMonth } = require("../lib/adapters/usaspending");
const { periodDate } = require("../lib/adapters/ecb");
const { studyOf } = require("../lib/adapters/ctgov");
const { form4Values, form4XmlUrl } = require("../lib/adapters/sec");
const { completeQuarters } = require("../lib/adapters/fdic");
const { anyDate, parseCsvRows, completeMonths } = require("../lib/adapters/common");

const NOW = new Date("2026-10-04T06:00:00Z");
const catalog = catalogLib.load();

async function run(sources, stub = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-b2-"));
  const db = dbLib.open({ dataDir: dir });
  const fetchImpl = makeFetch(catalog, { now: NOW, ...stub });
  const summary = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: { PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl, sources });
  return { db, summary, fetchImpl, dir };
}

test("common: dates, CSV quoting, complete months", () => {
  assert.equal(anyDate("9/30/2026"), "2026-09-30");
  assert.equal(anyDate("2026-09-30T00:00:00.000"), "2026-09-30");
  assert.equal(anyDate("20260930"), "2026-09-30");
  assert.equal(anyDate("soon"), null);
  assert.deepEqual(parseCsvRows('a,b\r\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(completeMonths("2026-07-01", NOW), ["2026-07-01", "2026-08-01", "2026-09-01"]);
  assert.deepEqual(completeQuarters("2026-02-10", NOW), ["2026-01-01", "2026-04-01", "2026-07-01"]);
});

test("xlsx: shared, inline and numeric cells from a deflated workbook; Pink Sheet columns by header", () => {
  const rows = readSheet(pinkSheetXlsx(NOW), "Monthly Prices");
  assert.equal(rows.get(5)[2], "Gold");
  assert.equal(rows.get(5)[4], "Silver", "inline string");
  const p = pricesFrom(rows, ["Gold", "Silver", "Platinum"]);
  assert.ok(p.Gold.length > 40 && p.Gold.every(([d, v]) => /^\d{4}-\d{2}-01$/.test(d) && v > 1000));
  assert.ok(p.Silver[0][1] > 20 && p.Silver[0][1] < 30);
  assert.throws(() => pricesFrom(rows, ["Unobtainium"]), /no header row/);
  assert.throws(() => readSheet(pinkSheetXlsx(NOW), "Annual Prices"), /no sheet named/);
});

test("CFPB: exact counts from the product aggregation even when hits.total is capped", () => {
  const c = monthCounts({ hits: { total: { value: 10000, relation: "gte" } }, aggregations: { product: { doc_count: 12, product: { buckets: [{ key: "Mortgage", doc_count: 30000 }, { key: "Credit card", doc_count: 5 }] } } } });
  assert.equal(c.total, 30005);
  assert.equal(c.products["Credit card"], 5);
  assert.equal(monthCounts({ hits: { total: 42 } }).total, 42);
  assert.throws(() => monthCounts({}), /neither/);
});

test("CPSC units text, USAspending fiscal months, ECB periods, ClinicalTrials.gov dates", () => {
  assert.equal(units("About 1.2 million"), 1200000);
  assert.equal(units("About 12,000 (in addition, about 500 were sold in Canada)"), 12000);
  assert.equal(units(""), 0);
  assert.equal(fiscalToMonth("2026", "1"), "2025-10-01");
  assert.equal(fiscalToMonth(2026, 3), "2025-12-01");
  assert.equal(fiscalToMonth(2026, 4), "2026-01-01");
  assert.equal(fiscalToMonth(2026, 12), "2026-09-01");
  assert.equal(fiscalToMonth(2026, 13), null);
  assert.equal(periodDate("2026-08"), "2026-08-01");
  assert.equal(periodDate("2026-Q3"), "2026-07-01");
  const st = studyOf({ protocolSection: { identificationModule: { nctId: "NCT1" }, statusModule: { overallStatus: "TERMINATED", startDateStruct: { date: "2025-03", type: "ACTUAL" }, completionDateStruct: { date: "2027-01-01", type: "ESTIMATED" }, lastUpdatePostDateStruct: { date: "2026-09-02" } } } });
  assert.deepEqual([st.start, st.completion, st.updated], ["2025-03-01", null, "2026-09-02"], "estimated dates are not counted");
});

test("Form 4: open-market P and S only, footnoted prices, raw XML next to the rendered copy", () => {
  const xml = `<ownershipDocument><nonDerivativeTable>
    <nonDerivativeTransaction><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>150.5</value><footnoteId id="F1"/></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>
    <nonDerivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>10</value></transactionShares><transactionPricePerShare><value>2</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>
    <nonDerivativeTransaction><transactionCoding><transactionCode>F</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>99</value></transactionShares><transactionPricePerShare><value>150</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>
  </nonDerivativeTable></ownershipDocument>`;
  assert.deepEqual(form4Values(xml), { buy: 20, sell: 150500 });
  assert.throws(() => form4Values("<html>"), /ownershipDocument/);
  assert.equal(form4XmlUrl("0000320193", "0000320193-26-000001", "xslF345X05/wk-form4.xml"), "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/wk-form4.xml");
  assert.equal(form4XmlUrl("0000320193", "0000320193-26-000001", "doc.htm"), null);
});

test("Form 4 values: each document is read once; a capped backlog leaves its weeks out until read", async () => {
  process.env.PMIC_FORM4_PER_PASS = "30";
  delete require.cache[require.resolve("../lib/adapters/sec")];
  delete require.cache[require.resolve("../lib/collect")];
  const { collectOnce: collectCapped } = require("../lib/collect");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-f4-"));
  const db = dbLib.open({ dataDir: dir });
  const seriesIds = ["sec:AAPL:insider_sell_value_weekly", "sec:AAPL:insider_buy_value_weekly"];
  const f1 = makeFetch(catalog, { now: NOW });
  await collectCapped(db, catalog, { now: NOW, dataDir: dir, env: { PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl: f1, seriesIds });
  const xml1 = f1.calls.filter((c) => c.url.endsWith(".xml")).length;
  assert.equal(xml1, 30);
  const weeks1 = db.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = ?").get(seriesIds[0]).n;
  const f2 = makeFetch(catalog, { now: NOW });
  for (let i = 0; i < 4; i++) await collectCapped(db, catalog, { now: NOW, dataDir: dir, env: { PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl: f2, seriesIds, force: true });
  const weeks2 = db.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = ?").get(seriesIds[0]).n;
  assert.ok(weeks2 > weeks1, "more weeks appear as the backlog is read");
  const f3 = makeFetch(catalog, { now: NOW });
  await collectCapped(db, catalog, { now: NOW, dataDir: dir, env: { PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl: f3, seriesIds, force: true });
  assert.equal(f3.calls.filter((c) => c.url.endsWith(".xml")).length, 0, "nothing is re-read once cached");
  delete process.env.PMIC_FORM4_PER_PASS;
  delete require.cache[require.resolve("../lib/adapters/sec")];
  delete require.cache[require.resolve("../lib/collect")];
});

test("batch 2 sources: every series collects and events land on their sector entities", async () => {
  const sources = ["ecb", "fdic", "cfpb", "wikimedia", "ctgov", "cpsc", "nhtsa", "fec", "lda", "usaspending", "pinksheet"];
  const { db, summary } = await run(sources);
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  for (const s of catalog.series.filter((x) => sources.includes(x.source_id))) {
    assert.ok(db.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = ?").get(s.series_id).n > 0, `${s.series_id} has observations`);
  }
  const ev = Object.fromEntries(db.prepare("SELECT event_type, entity_id, COUNT(*) n FROM events GROUP BY 1, 2").all().map((r) => [`${r.event_type}:${r.entity_id}`, r.n]));
  assert.ok(ev["bank_failure:us-banking"] > 0 && ev["product_recall:us-consumer-products"] > 0 && ev["vehicle_recall:us-vehicles"] > 0 && ev["trial_stopped:pfe"] > 0);
  // Monthly counts are complete months only; weekly sums are complete weeks only.
  assert.equal(db.prepare("SELECT MAX(observation_time) m FROM observations WHERE series_id = 'cfpb:complaints_total_monthly'").get().m, "2026-09-01");
  assert.equal(db.prepare("SELECT MAX(observation_time) m FROM observations WHERE series_id = 'wikimedia:AAPL:pageviews_weekly'").get().m, "2026-09-21");
  // The Pink Sheet link is read from the page, not the fallback.
  assert.ok(db.prepare("SELECT COUNT(*) n FROM fetch_logs WHERE url LIKE '%test-0090012026%'").get().n === 1);
});

test("months already read are not re-read (CFPB, FEC, LDA), except the latest three", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-b2c-"));
  const db = dbLib.open({ dataDir: dir });
  await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: {}, fetchImpl: makeFetch(catalog, { now: NOW }), sources: ["cfpb", "fec", "lda"] });
  const f = makeFetch(catalog, { now: NOW });
  await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: {}, fetchImpl: f, sources: ["cfpb", "fec", "lda"], force: true });
  const hosts = f.calls.map((c) => new URL(c.url).host);
  assert.equal(hosts.filter((h) => h === "www.consumerfinance.gov").length, 3);
  assert.equal(hosts.filter((h) => h === "api.open.fec.gov").length, 3);
  assert.equal(hosts.filter((h) => h === "lda.senate.gov").length, 6, "two LDA series, three months each");
  assert.ok(f.calls.filter((c) => c.url.includes("api.open.fec.gov")).every((c) => c.url.includes("api_key=DEMO_KEY")), "DEMO_KEY without FEC_API_KEY");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fetch_logs WHERE url LIKE '%DEMO_KEY%'").get().n, 0, "the key is redacted in logs");
});

test("LDA falls back to lda.gov when lda.senate.gov fails; FDIC falls back to its old host", async () => {
  const { summary, fetchImpl } = await run(["lda", "fdic"], { fail: (u) => u.host === "lda.senate.gov" || u.host === "api.fdic.gov" });
  // The stub answers neither fallback host, so both fail, but only after trying it.
  const hosts = new Set(fetchImpl.calls.map((c) => new URL(c.url).host));
  assert.ok(hosts.has("lda.gov") && hosts.has("banks.data.fdic.gov"));
  assert.ok(summary.sources.every((s) => s.failed.length > 0));
});
