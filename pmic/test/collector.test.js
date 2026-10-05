// Collector pipeline against the upstream stub: ingestion, dedupe, revisions, QC, events,
// scoring, retention, hub sync. Every test uses its own temp data dir.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce, rescoreAll } = require("../lib/collect");
const { maintain, prune } = require("../lib/maintain");
const sync = require("../lib/sync");
const Q = require("../lib/query");
const { parseCsv } = require("../lib/adapters/fred");
const { periodToDate } = require("../lib/adapters/bls");
const { quarterOf } = require("../lib/adapters/bea");
const { weeklyCounts, completeWeeks } = require("../lib/adapters/common");
const { transformed } = require("../lib/derive");
const { makeFetch } = require("./stub-upstream");

const NOW = new Date("2026-10-04T06:00:00Z");
const ENV = { BEA_API_KEY: "test-key", PMIC_SEC_USER_AGENT: "PMIC test test@example.com", PMIC_NVD_GAP_MS: "0", CONGRESS_API_KEY: "test-key" };
const catalog = catalogLib.load();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pmic-test-"));
}

async function fresh(opts = {}) {
  const dir = tmp();
  const db = dbLib.open({ dataDir: dir });
  const fetchImpl = makeFetch(catalog, { now: NOW, blsMirrorsFred: true, ...opts.stub });
  const summary = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: opts.env || ENV, fetchImpl, sources: opts.sources || null });
  return { dir, db, summary, fetchImpl };
}

const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

test("parsers: FRED csv headers, BLS periods, BEA quarters, weekly buckets", () => {
  assert.deepEqual(parseCsv("observation_date,UNRATE\n2026-08-01,4.3\n2026-09-01,.\n", "UNRATE"), [{ date: "2026-08-01", value: "4.3" }, { date: "2026-09-01", value: "." }]);
  assert.equal(parseCsv("DATE,UNRATE\n2026-08-01,4.3\n", "UNRATE").length, 1);
  assert.throws(() => parseCsv("<html>", "X"), /unexpected header/);
  assert.equal(periodToDate("2026", "M08"), "2026-08-01");
  assert.equal(periodToDate("2026", "M13"), null);
  assert.equal(periodToDate("2026", "Q03"), "2026-07-01");
  assert.deepEqual(quarterOf({ TimePeriod: "2026Q2" }), { year: 2026, q: 2, label: "2026Q2" });
  assert.deepEqual(quarterOf({ Year: "2026", Quarter: "III" }), { year: 2026, q: 3, label: "2026Q3" });
  const weeks = completeWeeks("2026-09-01", NOW); // Tue -> first full week starts Mon 09-07; last complete week starts 09-21
  assert.deepEqual(weeks, ["2026-09-07", "2026-09-14", "2026-09-21"]);
  assert.deepEqual(weeklyCounts([["2026-09-08", 2], ["2026-09-13", 1], ["2026-09-30", 5]], "2026-09-01", NOW), [["2026-09-07", 3], ["2026-09-14", 0], ["2026-09-21", 0]]);
});

test("yoy transform compares against the observation a year earlier", () => {
  const pts = [];
  for (let m = 0; m < 24; m++) {
    const d = `${2024 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    pts.push({ ms: Date.parse(`${d}T00:00:00Z`), time: d, v: 100 + m });
  }
  const tr = transformed({ transform: "yoy_pct", frequency: "monthly" }, pts);
  assert.equal(tr.length, 12);
  assert.equal(tr[0].time, "2025-01-01");
  assert.ok(Math.abs(tr[0].v - 12) < 1e-9); // 112 vs 100
});

test("first pass ingests every source, stores raw payloads, logs fetches, scores every series", async () => {
  const { db, dir, summary } = await fresh();
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  assert.equal(summary.due, catalog.series.length);
  assert.equal(count(db, "SELECT COUNT(DISTINCT series_id) n FROM scores"), catalog.series.length);
  assert.ok(count(db, "SELECT COUNT(*) n FROM observations") > 5000);
  assert.equal(count(db, "SELECT COUNT(*) n FROM fetch_logs WHERE ok = 0"), 0);

  // Raw: every logged payload is in a gzip JSONL day file and hashes back to its sha.
  const log = db.prepare("SELECT raw_sha256, raw_file FROM fetch_logs WHERE source_id = 'fred' LIMIT 1").get();
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, log.raw_file))).toString("utf8").trim().split("\n").map(JSON.parse);
  const rec = lines.find((l) => l.sha256 === log.raw_sha256);
  assert.ok(rec && rec.body.startsWith("observation_date,"));
  assert.equal(require("../lib/raw").sha256(rec.body), log.raw_sha256);

  // API keys never reach logs or citations.
  assert.equal(count(db, "SELECT COUNT(*) n FROM fetch_logs WHERE url LIKE '%test-key%'"), 0);
  assert.ok(count(db, "SELECT COUNT(*) n FROM fetch_logs WHERE url LIKE '%UserID=REDACTED%'") > 0);

  // "." holiday values are skipped, M13 annual averages are skipped.
  assert.equal(count(db, "SELECT COUNT(*) n FROM observations WHERE series_id LIKE 'bls:%' AND period LIKE '%M13'"), 0);
  // Retention window: nothing older than the series class horizon was ingested.
  assert.equal(count(db, "SELECT COUNT(*) n FROM observations WHERE retention_class = 'standard' AND observation_time < '2025-08-30'"), 0);
  // BLS preliminary footnote becomes a qc flag.
  const prelim = db.prepare("SELECT qc_flags FROM observations WHERE series_id = 'bls:LNS14000000' ORDER BY observation_time DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(prelim.qc_flags), ["preliminary"]);
});

test("SEC: framed facts only, concept fallback, ratios, filing events with 8-K severity, weekly Form 4 counts", async () => {
  const { db } = await fresh({ sources: ["sec"] });
  // The duplicated comparative (val + 999, no frame) must never be stored.
  const rev = db.prepare("SELECT metric_value, period, source_url FROM observations WHERE series_id = 'sec:AAPL:revenue_q' ORDER BY observation_time").all();
  assert.ok(rev.length >= 8);
  assert.ok(rev.every((r) => /^CY\d{4}Q[1-3]$/.test(r.period)));
  assert.ok(rev.every((r) => r.source_url.startsWith("https://www.sec.gov/Archives/edgar/data/320193/")));
  const fy = db.prepare("SELECT period FROM observations WHERE series_id = 'sec:AAPL:revenue_fy'").all();
  assert.ok(fy.length >= 2 && fy.every((r) => /^CY\d{4}$/.test(r.period)));
  const cr = db.prepare("SELECT metric_value FROM observations WHERE series_id = 'sec:AAPL:current_ratio' LIMIT 1").get();
  assert.ok(cr.metric_value > 0.5 && cr.metric_value < 2);
  const high = db.prepare("SELECT severity, event_type FROM events WHERE entity_id = 'aapl' AND detail_json LIKE '%4.02%'").get();
  assert.deepEqual({ ...high }, { severity: "high", event_type: "filing_8k" });
  assert.equal(count(db, "SELECT COUNT(*) n FROM events WHERE detail_json LIKE '%\"form\":\"S-8\"%'"), 0);
  const f4 = db.prepare("SELECT observation_time, metric_value FROM observations WHERE series_id = 'sec:AAPL:insider_form4_weekly' ORDER BY observation_time").all();
  assert.ok(f4.length >= 50);
  assert.ok(f4.every((r) => new Date(`${r.observation_time}T00:00:00Z`).getUTCDay() === 1));
});

test("openFDA: weekly counts, NOT_FOUND is a valid zero, recall and approval events mapped to companies", async () => {
  const { db, summary } = await fresh({ sources: ["openfda"] });
  assert.equal(summary.sources[0].failed.length, 0);
  const lilly = db.prepare("SELECT COUNT(*) n, SUM(metric_value) s FROM observations WHERE series_id = 'openfda:LLY:drug_recalls_weekly'").get();
  assert.ok(lilly.n > 50);
  assert.equal(lilly.s, 0);
  const pfizer = db.prepare("SELECT entity_id, severity FROM events WHERE external_id = 'recall:D-0001-2027'").get();
  assert.deepEqual({ ...pfizer }, { entity_id: "pfe", severity: "high" });
  assert.equal(db.prepare("SELECT entity_id FROM events WHERE external_id LIKE 'approval:NDA200003%' OR external_id LIKE 'approval:BLA200003%'").get().entity_id, "lly");
  assert.equal(count(db, "SELECT COUNT(*) n FROM events WHERE external_id LIKE 'approval:ANDA%'"), 0);
  const nda = count(db, "SELECT SUM(metric_value) n FROM observations WHERE series_id = 'openfda:approvals_nda_bla_weekly'");
  const anda = count(db, "SELECT SUM(metric_value) n FROM observations WHERE series_id = 'openfda:approvals_anda_weekly'");
  assert.ok(nda > 0 && anda > nda);
});

test("re-running is idempotent; a changed upstream value is a revision with history kept", async () => {
  const { db, dir } = await fresh({ sources: ["fred"] });
  const before = count(db, "SELECT COUNT(*) n FROM observations");
  const again = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: ENV, fetchImpl: makeFetch(catalog, { now: NOW }), sources: ["fred"], force: true });
  assert.equal(again.sources[0].inserted, 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM observations"), before);
  // Identical payloads are stored once.
  const files = db.prepare("SELECT COUNT(DISTINCT raw_sha256) n, COUNT(*) logs FROM fetch_logs WHERE source_id = 'fred'").get();
  assert.equal(files.logs, 2 * files.n);

  const revised = await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: ENV, fetchImpl: makeFetch(catalog, { now: NOW, bump: { UNRATE: 1.05 } }), sources: ["fred"], force: true });
  assert.equal(revised.sources[0].revised, 1);
  const row = db.prepare("SELECT id, revision, qc_flags FROM observations WHERE series_id = 'fred:UNRATE' ORDER BY observation_time DESC LIMIT 1").get();
  assert.equal(row.revision, 1);
  assert.ok(JSON.parse(row.qc_flags).includes("revised"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM observation_revisions WHERE observation_id = ?", row.id), 1);
});

test("cadence: nothing is due right after a pass; a failure backs off and raises an alert", async () => {
  const { db, dir } = await fresh({ sources: ["worldbank"] });
  const next = await collectOnce(db, catalog, { now: new Date(NOW.getTime() + 3600e3), dataDir: dir, env: ENV, fetchImpl: makeFetch(catalog, { now: NOW }), sources: ["worldbank"] });
  assert.equal(next.due, 0);

  const d2 = tmp();
  const db2 = dbLib.open({ dataDir: d2 });
  const failing = makeFetch(catalog, { now: NOW, fail: (u) => u.host === "api.worldbank.org" });
  const s = await collectOnce(db2, catalog, { now: NOW, dataDir: d2, env: ENV, fetchImpl: failing, sources: ["worldbank"] });
  assert.equal(s.sources[0].failed.length, catalog.series.filter((x) => x.source_id === "worldbank").length);
  assert.ok(count(db2, "SELECT COUNT(*) n FROM alerts WHERE kind = 'api_failure' AND resolved_at IS NULL") > 0);
  assert.ok(count(db2, "SELECT COUNT(*) n FROM fetch_logs WHERE ok = 0 AND http_status = 503") > 0);
  const soon = await collectOnce(db2, catalog, { now: new Date(NOW.getTime() + 10 * 60e3), dataDir: d2, env: ENV, fetchImpl: failing, sources: ["worldbank"] });
  assert.equal(soon.due, 0);
  // Recovery resolves the alert.
  const later = await collectOnce(db2, catalog, { now: new Date(NOW.getTime() + 2 * 3600e3), dataDir: d2, env: ENV, fetchImpl: makeFetch(catalog, { now: NOW }), sources: ["worldbank"] });
  assert.equal(later.sources[0].failed.length, 0);
  assert.equal(count(db2, "SELECT COUNT(*) n FROM alerts WHERE kind = 'api_failure' AND resolved_at IS NULL"), 0);
});

test("missing keys skip the source with an alert instead of failing the pass", async () => {
  const { db, summary } = await fresh({ env: {}, sources: ["bea", "sec", "fred"] });
  const bea = summary.sources.find((s) => s.source_id === "bea");
  assert.ok(bea.failed.every((f) => f.kind === "missing_key"));
  assert.ok(count(db, "SELECT COUNT(*) n FROM alerts WHERE kind = 'missing_key' AND source_id = 'sec'") > 0);
  assert.equal(summary.sources.find((s) => s.source_id === "fred").failed.length, 0);
});

test("schema change and impossible values are caught", async () => {
  const dir = tmp();
  const db = dbLib.open({ dataDir: dir });
  const base = makeFetch(catalog, { now: NOW });
  const broken = async (url, init) => {
    if (url.includes("fredgraph.csv?id=UNRATE")) return { status: 200, ok: true, text: "<html>maintenance</html>" };
    if (url.includes("fredgraph.csv?id=PAYEMS")) return { status: 200, ok: true, text: "observation_date,PAYEMS\n2026-07-01,-5\n2026-08-01,159000\n" };
    return base(url, init);
  };
  await collectOnce(db, catalog, { now: NOW, dataDir: dir, env: ENV, fetchImpl: broken, sources: ["fred"] });
  assert.equal(db.prepare("SELECT kind FROM alerts WHERE series_id = 'fred:UNRATE'").get().kind, "schema_change");
  assert.equal(count(db, "SELECT COUNT(*) n FROM alerts WHERE kind = 'impossible_value' AND series_id = 'fred:PAYEMS'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM observations WHERE series_id = 'fred:PAYEMS'"), 1);
});

test("cross-source mismatch lowers confidence and is flagged", async () => {
  const { db } = await fresh({ stub: { blsMirrorsFred: false }, sources: ["fred", "bls"] });
  const sc = db.prepare("SELECT risk_flags FROM scores WHERE series_id = 'fred:UNRATE' ORDER BY as_of DESC LIMIT 1").get();
  assert.ok(JSON.parse(sc.risk_flags).includes("cross_source_mismatch"));
  assert.ok(count(db, "SELECT COUNT(*) n FROM alerts WHERE kind = 'cross_source_mismatch'") > 0);
});

test("score fields: ranges, citation, provenance back to the raw payload", async () => {
  const { db } = await fresh({ sources: ["fred", "bls"] });
  for (const sc of db.prepare("SELECT * FROM scores").all()) {
    assert.ok(sc.composite_score === null || (sc.composite_score >= 0 && sc.composite_score <= 100), sc.series_id);
    assert.ok(sc.confidence_score >= 0 && sc.confidence_score <= 100);
    assert.ok(["high", "medium", "low"].includes(sc.confidence_label));
    assert.ok(["up", "down", "flat", "unknown"].includes(sc.trend));
    assert.match(sc.citation_url, /^https:\/\//);
    assert.ok(sc.rationale.length > 40);
    const prov = JSON.parse(sc.provenance_json);
    assert.ok(prov.raw_sha256 && prov.raw_file, sc.series_id);
  }
  // No 7-day change on a monthly series.
  assert.equal(db.prepare("SELECT pct_change_7d FROM scores WHERE series_id = 'fred:UNRATE'").get().pct_change_7d, null);
  assert.notEqual(db.prepare("SELECT pct_change_7d FROM scores WHERE series_id = 'fred:DGS10'").get().pct_change_7d, null);
});

test("retention prunes by class, keeps high-severity events longer, keeps the latest score", async () => {
  const { db, dir } = await fresh({ sources: ["fred", "openfda", "worldbank"] });
  const later = new Date(NOW.getTime() + 500 * 86400e3);
  db.prepare(`INSERT INTO events (source_id, external_id, entity_id, event_type, event_time, title, severity, source_url, fetch_time, retention_class, updated_at)
    VALUES ('openfda', 'old-high', 'us-drug-market', 'drug_recall', '2026-01-01', 't', 'high', 'https://x', '2026-01-01', 'event_high', '2026-01-01'),
           ('openfda', 'old-low', 'us-drug-market', 'drug_recall', '2026-01-01', 't', 'low', 'https://x', '2026-01-01', 'event_standard', '2026-01-01')`).run();
  const out = prune(db, catalog, dir, later);
  assert.ok(out.observations > 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM events WHERE external_id = 'old-high'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM events WHERE external_id = 'old-low'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM observations WHERE series_id = 'fred:DGS10'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM scores WHERE series_id = 'worldbank:us:NY.GDP.MKTP.KD.ZG'"), 1);
  assert.ok(out.raw_files > 0);

  const m = maintain(db, catalog, dir, { now: NOW, force: true });
  assert.ok(fs.existsSync(path.join(dir, m.backup)));
  assert.ok(count(db, "SELECT COUNT(*) n FROM rollups_weekly") >= 0);
  assert.equal(maintain(db, catalog, dir, { now: NOW }), null); // once per day
});

test("hub sync: pushed rows land on the hub and rescore to the same numbers", async () => {
  const { db } = await fresh({ sources: ["fred", "sec"] });
  const hubDir = tmp();
  const hub = dbLib.open({ dataDir: hubDir });
  dbLib.syncCatalog(hub, catalog);
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer t0k");
    const res = sync.apply(hub, catalog, JSON.parse(init.body), NOW);
    return { ok: true, status: 200, text: async () => JSON.stringify(res) };
  };
  const sent = await sync.push(db, { url: "https://hub.example/ingest/sync", token: "t0k", fetchImpl });
  assert.ok(sent.requests > 1);
  assert.equal(count(hub, "SELECT COUNT(*) n FROM observations"), count(db, "SELECT COUNT(*) n FROM observations"));
  assert.equal(count(hub, "SELECT COUNT(*) n FROM events"), count(db, "SELECT COUNT(*) n FROM events"));
  rescoreAll(db, catalog, { now: NOW });
  const a = db.prepare("SELECT composite_score, zscore, percentile FROM scores WHERE series_id = 'fred:CPIAUCSL' ORDER BY as_of DESC LIMIT 1").get();
  const b = hub.prepare("SELECT composite_score, zscore, percentile FROM scores WHERE series_id = 'fred:CPIAUCSL' ORDER BY as_of DESC LIMIT 1").get();
  assert.deepEqual({ ...b }, { ...a });
  // Nothing new: one heartbeat request carrying collector status, no rows.
  const again = await sync.push(db, { url: "https://hub.example/ingest/sync", token: "t0k", fetchImpl });
  assert.deepEqual(again, { observations: 0, events: 0, requests: 1 });
  assert.ok(dbLib.kvGet(hub, "collector_status"));
});

test("query layer: marketplace answer shape, filters, explain, bad input", async () => {
  const { db } = await fresh({ sources: ["fred", "bls", "sec", "openfda"] });
  const a = Q.signal(db, { series_id: "fred:UNRATE" });
  for (const k of ["summary", "composite_score", "trend", "risk_flags", "confidence", "provenance"]) assert.ok(k in a, k);
  assert.match(a.provenance.citation_url, /fred\.stlouisfed\.org\/series\/UNRATE/);
  const two = Q.signal(db, { entity_id: "us", metric_name: "unemployment_rate" });
  assert.equal(two.count, 2);
  const ranked = Q.signals(db, { category: "health", horizon: "30d", sort: "abs_change", limit: 5 });
  assert.ok(ranked.count > 0 && ranked.signals.every((s) => s.metric.category === "health"));
  const ex = Q.explain(db, { series_id: "fred:DGS10", horizon: "90d" });
  assert.equal(ex.status, "ok");
  assert.ok(ex.explanation.includes("Composite moved") || ex.explanation.includes("No stored score"));
  assert.ok(Q.events(db, { entity_id: "pfe", severity: "high" }).count >= 1);
  assert.ok(Q.catalog(db, { industry: "banking" }).count > 0);
  assert.throws(() => Q.signal(db, { series_id: "nope" }), /not in the catalog/);
  assert.throws(() => Q.signals(db, { horizon: "2d" }), /horizon/);
  assert.throws(() => Q.series(db, {}), /series_id/);
});

test("outliers: only new observations are checked, ordinary lumpy steps are not flagged, backfill flags are cleared", () => {
  const { outlierScore } = require("../lib/qc");
  const dir = tmp();
  const db = dbLib.open({ dataDir: dir });
  dbLib.syncCatalog(db, catalog);
  const s = catalog.series.find((x) => x.series_id === "fred:DGS10");
  const ins = db.prepare(`INSERT INTO observations (source_id, series_id, entity_id, metric_name, metric_value, unit, observation_time, fetch_time, source_url,
    transform_version, retention_class, confidence_score, qc_flags, updated_at) VALUES ('fred', ?, 'us', ?, ?, 'percent', ?, '2026-10-01', 'https://x', 't', 'standard', 90, ?, '2026-10-01')`);
  for (let i = 0; i < 20; i++) ins.run(s.series_id, s.metric_name, 4 + (i % 2 ? 0.01 : -0.01) + i * 0.001, `2026-09-${String(i + 5).padStart(2, "0")}`, "[]");
  const now = "2026-10-01T00:00:00Z";
  assert.ok(Math.abs(outlierScore(db, s, "2026-09-30", 9, now)) > 8, "a recent huge jump is flagged");
  assert.equal(outlierScore(db, s, "2026-09-30", 4.05, now), null, "a step within twice the largest recent step is not");
  assert.equal(outlierScore(db, s, "2026-09-30", 9, "2028-01-01T00:00:00Z"), null, "old data is never checked");

  // Migration 002 on a store that already carries backfill flags.
  ins.run(s.series_id, s.metric_name, 1, "2020-04-01", '["outlier"]');
  dbLib.raiseAlert(db, { kind: "outlier", series_id: s.series_id, detail: "2020-04-01: 1 is a step", key: "outlier|x|2020-04-01" });
  dbLib.raiseAlert(db, { kind: "outlier", series_id: s.series_id, detail: `${new Date().toISOString().slice(0, 10)}: 9 is a step`, key: "outlier|x|recent" });
  db.exec(fs.readFileSync(path.join(__dirname, "..", "migrations", "002_clear_backfill_outliers.sql"), "utf8"));
  assert.equal(db.prepare("SELECT qc_flags FROM observations WHERE observation_time = '2020-04-01'").get().qc_flags, "[]");
  assert.equal(count(db, "SELECT COUNT(*) n FROM alerts WHERE kind = 'outlier' AND resolved_at IS NULL"), 1);
});
