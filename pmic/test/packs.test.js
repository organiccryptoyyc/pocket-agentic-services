// The three batch-1 service packs against a real hub filled from the stub upstreams: every
// vertical answers a scored, cited brief, scope and inputs are enforced, and bad input is a 400.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");
const { makeFetch } = require("./stub-upstream");

const HUB_PORT = 20100 + Math.floor(Math.random() * 300);
const BUNDLES = ["pmic-macro-signals", "pmic-company-signals", "pmic-pharma-signals", "pmic-public-sector-signals", "pmic-crypto-signals"];
const PORTS = Object.fromEntries(BUNDLES.map((b, i) => [b, HUB_PORT + 400 + i]));
const procs = [];
let HUB_DIR = null;

function start(script, cwd, env, marker) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
    let seen = "";
    p.stdout.on("data", (d) => { seen += d; if (seen.includes(marker)) resolve(p); });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("exit", (c) => reject(new Error(`${script} exited ${c}`)));
    procs.push(p);
  });
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-packs-"));
  HUB_DIR = dir;
  const catalog = catalogLib.load();
  const db = dbLib.open({ dataDir: dir });
  const now = new Date("2026-10-04T06:00:00Z");
  await collectOnce(db, catalog, { now, dataDir: dir, env: { BEA_API_KEY: "k", PMIC_SEC_USER_AGENT: "t t@example.com", PMIC_NVD_GAP_MS: "0", CONGRESS_API_KEY: "k" }, fetchImpl: makeFetch(catalog, { now, blsMirrorsFred: true }) });
  db.close();
  await start("server.js", path.join(__dirname, ".."), { PORT: String(HUB_PORT), PMIC_DATA_DIR: dir, PMIC_API_TOKEN: "hub-token", PMIC_INGEST_TOKEN: "" }, '"listening":true');
  for (const b of BUNDLES) {
    await start("server.js", path.join(__dirname, "..", "packs"), { PORT: String(PORTS[b]), PACK_FILE: `bundles/${b}.json`, PMIC_HUB_URL: `http://127.0.0.1:${HUB_PORT}`, PMIC_API_TOKEN: "hub-token" }, '"listening":true');
  }
});

after(() => { for (const p of procs) p.kill(); });

async function call(bundle, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${PORTS[bundle]}${route}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  assert.ok(json && typeof json === "object" && !Array.isArray(json), `${route} must answer a JSON object`);
  assert.ok(res.status < 500, `${route} answered ${res.status}`);
  return { status: res.status, json };
}

function checkBrief(b, bundle) {
  assert.equal(b.service, bundle);
  assert.equal(b.status, "ok", `${b.vertical}: ${b.summary}`);
  assert.ok(Number.isInteger(b.score) && b.score >= 0 && b.score <= 100, `${b.vertical} score ${b.score}`);
  assert.ok(typeof b.summary === "string" && b.summary.length > 20);
  assert.ok(b.label);
  assert.ok(Array.isArray(b.risk_flags));
  assert.ok(b.confidence && Number.isInteger(b.confidence.score));
  assert.ok(b.citations.length > 0 && b.citations.every((c) => /^https:\/\//.test(c.url)), `${b.vertical} citations`);
}

test("probes: version, health and the PSM healthz path", async () => {
  for (const b of BUNDLES) {
    assert.deepEqual((await call(b, "GET", "/v1/version")).json, { service: b, version: require(`../packs/bundles/${b}.json`).version });
    for (const p of ["/v1/health", "/healthz"]) {
      const h = await call(b, "GET", p);
      assert.equal(h.status, 200);
      assert.equal(h.json.status, "ok");
    }
  }
});

test("macro bundle: every vertical is a scored, cited brief", async () => {
  const list = (await call("pmic-macro-signals", "POST", "/v1/verticals", {})).json;
  assert.equal(list.count, 27);
  for (const id of ["housing", "consumer", "country-risk", "health-systems", "education", "yield-curve", "bank-health", "global-rates-fx"]) assert.ok(list.verticals.some((v) => v.id === id), `batch 2 vertical ${id}`);
  for (const v of list.verticals) {
    const r = await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: v.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    if (v.kind === "country_table") {
      assert.equal(r.json.status, "ok");
      if (v.id === "state-labor") { // PNF 2026-10-13: labels name no single state; the state is in each row
        assert.deepEqual(r.json.metrics.map((m) => m.label), ["Unemployment rate (BLS LAUS, SA)", "Nonfarm payroll employment (BLS CES, SA)"]);
        assert.ok(r.json.metrics.every((m) => m.rows.length > 1 && m.rows.every((row) => row.name || row.country)));
      }
      assert.ok(r.json.country_scores.length >= 7);
      assert.ok(r.json.metrics.every((m) => m.rows.every((row, i) => row.rank === i + 1)));
      continue;
    }
    checkBrief(r.json, "pmic-macro-signals");
    const members = require("../packs/bundles/pmic-macro-signals.json").verticals.find((x) => x.id === v.id).members.length;
    assert.ok(r.json.inputs.length >= 2 && r.json.inputs.length + r.json.watch.length >= Math.min(3, members), `${v.id} inputs`);
    // The stub hub has one scoring pass, so there is no stored score from 90 days ago yet.
    assert.equal(r.json.trend_basis, "input_trends");
    const words = require("../packs/bundles/pmic-macro-signals.json").verticals.find((x) => x.id === v.id).trend_words;
    assert.ok(["steady", words.up, words.down].includes(r.json.trend), `${v.id} trend ${r.json.trend}`);
  }
  const rates = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "rates" })).json;
  assert.equal(typeof rates.curve.inverted, "boolean");
  assert.ok(rates.inputs.some((m) => m.scoring === "percentile_inverted"), "neutral rate series are read as tightness");
  for (const m of rates.inputs.filter((x) => x.scoring && x.scoring.startsWith("percentile"))) {
    assert.ok(m.summary.includes(`Scored ${m.score}/100 in this brief`), `${m.series_id}: text must quote the brief's score, not the hub's`);
    assert.ok(!/Composite \d+\/100/.test(m.summary), `${m.series_id}: hub composite left in the text`);
  }
  const commodities = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "commodities" })).json;
  assert.ok(commodities.watch.some((m) => m.series_id === "fred:IQ"), "neutral members without a direction are watch items");
  const de = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "global-compare", countries: ["us", "de"] })).json;
  assert.equal(de.country_scores.length, 2);
});

test("macro overview and inflation calculator", async () => {
  const o = (await call("pmic-macro-signals", "POST", "/v1/overview", {})).json;
  assert.equal(o.count, 27);
  assert.ok(o.briefs.every((b) => b.status === "ok"));
  const range = (await call("pmic-macro-signals", "POST", "/v1/inflation/adjust", { amount: 100, from: "1990-01" }));
  assert.equal(range.status, 400);
  assert.equal(range.json.error.code, "out_of_range");
  const m = range.json.error.message.match(/(\d{4}-\d{2}) to (\d{4}-\d{2})/);
  const r = await call("pmic-macro-signals", "POST", "/v1/inflation/adjust", { amount: 100, from: m[1] });
  assert.equal(r.status, 200);
  assert.equal(r.json.to, m[2]);
  assert.ok(r.json.adjusted > 0 && r.json.citation_url.includes("CPIAUCSL"));
});

test("fed consensus: prediction market, bond market and data side by side (plan 3.2)", async () => {
  const r = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "fed-consensus" })).json;
  checkBrief(r, "pmic-macro-signals");
  const f = r.fed_consensus;
  // The stub's next meeting is October (hold 93.7%, small hike odds), so the market leans to no change.
  assert.equal(f.prediction_market.meeting, "Fed Decision in October?");
  assert.equal(f.prediction_market.most_likely, "No change");
  assert.equal(f.prediction_market.lean, "hold");
  assert.ok(Math.abs(f.prediction_market.p_cut + f.prediction_market.p_hold + f.prediction_market.p_hike - 1) < 0.001);
  assert.equal(f.prediction_market.stale, Date.now() - Date.parse(f.prediction_market.observed_at) > 48 * 3600000, "stale follows the 48 h rule (the test hub collected on 2026-10-04)");
  assert.ok(/^https:\/\/polymarket\.com\/event\//.test(f.prediction_market.url));
  assert.ok(Number.isFinite(f.bond_market.policy_rate_pct) && Number.isFinite(f.bond_market.treasury_2y_pct));
  assert.equal(f.bond_market.spread_2y_minus_policy_bp, Math.round((f.bond_market.treasury_2y_pct - f.bond_market.policy_rate_pct) * 100));
  assert.ok(["cut", "hold", "hike"].includes(f.bond_market.lean));
  assert.equal(f.data.score, r.score);
  assert.ok(["aligned", "mixed", "diverging"].includes(f.agreement));
  assert.ok(f.summary.startsWith("Prediction market: Fed Decision in October? priced for no change"));
  assert.deepEqual(r.upcoming_events.map((e) => e.detail.title), ["Fed Decision in October?", "Fed Decision in December?"], "soonest first, past meeting gone");
  assert.deepEqual(r.inputs.map((m) => m.series_id).sort(), ["fred:CPILFESL", "fred:PAYEMS", "fred:UNRATE"], "the score reads the data only");
});

test("fed consensus leans and agreement, from the numbers alone", () => {
  const V = require("../packs/lib/verticals");
  const m = (id, v) => ({ series_id: id, value: { current: v } });
  const ev = (implied, observed) => [{ event_type: "fed_decision_market", detail: { title: "Fed Decision in March?", implied_change_bp: implied, p_cut: 0.6, p_hold: 0.4, p_hike: 0, outcomes: [{ outcome: "25 bps decrease", p: 0.6 }, { outcome: "No change", p: 0.4 }], observed_at: observed, url: "https://polymarket.com/event/x" } }];
  const now = Date.parse("2027-03-01T00:00:00Z");
  const cutBoth = V.fedConsensus({ score: 65, label: "data lean toward cuts" }, [m("fred:DFF", 4.33), m("fred:DGS2", 3.9)], ev(-15, "2027-02-28T12:00:00Z"), now);
  assert.deepEqual([cutBoth.prediction_market.lean, cutBoth.bond_market.lean, cutBoth.data.lean, cutBoth.agreement], ["cut", "cut", "cut", "aligned"]);
  assert.equal(cutBoth.bond_market.spread_2y_minus_policy_bp, -43);
  const split = V.fedConsensus({ score: 30, label: "data lean toward hikes" }, [m("fred:DFF", 4.33), m("fred:DGS2", 3.9)], ev(-15, "2027-02-20T00:00:00Z"), now);
  assert.equal(split.agreement, "diverging");
  assert.equal(split.prediction_vs_bond, "aligned");
  assert.equal(split.prediction_market.stale, true, "odds older than 48 h");
  const thin = V.fedConsensus({ score: null, label: null }, [m("polymarket:implied_change_bp", 2)], [], now);
  assert.deepEqual([thin.prediction_market.lean, thin.bond_market.lean, thin.data.lean, thin.agreement], ["hold", null, null, null], "falls back to the snapshot series; no guesses");
});

test("company bundle: fundamentals and filing risk need a covered entity", async () => {
  for (const v of ["fundamentals", "filing-risk"]) {
    const r = await call("pmic-company-signals", "POST", "/v1/brief", { vertical: v, entity_id: "PFE" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    checkBrief(r.json, "pmic-company-signals");
    assert.equal(r.json.entity.entity_id, "pfe");
  }
  const jpm = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "fundamentals", entity_id: "jpm" })).json;
  assert.ok(!jpm.inputs.some((m) => m.series_id === "sec:JPM:current_ratio"), "metrics a bank does not report are left out, not counted missing");
  assert.equal((await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "fundamentals" })).json.error.code, "invalid_input");
  assert.equal((await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "fundamentals", entity_id: "tsla" })).json.error.code, "unknown_entity");
  const o = (await call("pmic-company-signals", "POST", "/v1/overview", { entity_id: "msft" })).json;
  assert.equal(o.count, 12);
  assert.equal((await call("pmic-company-signals", "POST", "/v1/events", {})).status, 400, "company events need an entity");
  const ev = await call("pmic-company-signals", "POST", "/v1/events", { entity_id: "aapl", limit: 5 });
  assert.equal(ev.status, 200);
  assert.ok(ev.json.events.every((e) => e.entity_id === "aapl"));
  // 0.9.0: every answer says what it searched, per source.
  assert.equal(ev.json.searched.filters.entity_id, "aapl");
  assert.equal(ev.json.searched.filters.limit, 5);
  assert.ok(ev.json.searched.sources.some((s) => s.source_id === "sec"), "SEC is searched for a company");
  assert.ok(!ev.json.searched.sources.some((s) => s.source_id === "openfda"), "openFDA is only searched for pharma companies");
  for (const s of ev.json.searched.sources) {
    assert.ok(["checked_ok", "empty", "stale", "failed"].includes(s.status), JSON.stringify(s));
    assert.equal(typeof s.events_returned, "number");
  }
  // An empty answer still lists the sources and says nothing matched.
  const none = (await call("pmic-company-signals", "POST", "/v1/events", { entity_id: "aapl", event_type: "no_such_type" })).json;
  assert.equal(none.count, 0);
  assert.ok(none.searched.sources.length >= 1);
  assert.ok(none.searched.notes.some((n) => /No events matched/.test(n)));
  // A misspelt field is refused, not ignored.
  const typo = await call("pmic-company-signals", "POST", "/v1/events", { entity: "aapl" });
  assert.equal(typo.status, 400);
  assert.match(typo.json.error.message, /unknown field\(s\): entity/);
  const pfe = (await call("pmic-pharma-signals", "POST", "/v1/events", { entity_id: "pfe" })).json;
  assert.deepEqual(pfe.searched.sources.map((s) => s.source_id).sort(), ["ctgov", "fdawl", "openfda"]);
  assert.equal((await call("pmic-pharma-signals", "POST", "/v1/events", { entity: "pfe" })).status, 400, "pharma refuses the typo too");
});

test("company batch 2: insider activity, balance sheet and peer ranking", async () => {
  const ins = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "insider-activity", entity_id: "aapl" })).json;
  checkBrief(ins, "pmic-company-signals");
  assert.equal(ins.inputs[0].series_id, "sec:AAPL:insider_form4_weekly");
  assert.equal(ins.inputs[0].scoring, "percentile_inverted", "more insider filings than usual reads as a lower score");
  assert.ok(ins.recent_events.every((e) => ["insider_form4", "ownership_13d"].includes(e.event_type)), "only insider and 13D events are listed");
  const bs = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "balance-sheet", entity_id: "msft" })).json;
  checkBrief(bs, "pmic-company-signals");
  assert.ok(bs.inputs.some((m) => m.series_id === "sec:MSFT:long_term_debt"));
  const peer = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "peer-ranking", entity_id: "nvda" })).json;
  checkBrief(peer, "pmic-company-signals");
  assert.ok(peer.peers.length >= 10, "ranks the covered companies");
  assert.deepEqual(peer.peers.map((p) => p.position), peer.peers.map((_, i) => i + 1));
  assert.equal(peer.position, peer.peers.find((p) => p.entity_id === "nvda").position);
  for (const m of peer.metrics) {
    assert.ok(m.rows.every((r, i) => r.rank === i + 1));
    assert.equal(m.rows[0].score, 100);
    assert.equal(m.rows[m.rows.length - 1].score, 0);
  }
  assert.equal((await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "peer-ranking" })).json.error.code, "invalid_input");
});

test("peer table: rank positions, polarity and too few metrics", () => {
  const V = require("../packs/lib/verticals");
  const sig = (id, v) => ({ status: "ok", entity: { entity_id: id, name: id.toUpperCase() }, metric: { label: "M", unit: "ratio", polarity: 1 }, value: { current: v, transformed: v, as_of: "2026-06-30" }, provenance: { citation_url: "https://www.sec.gov/x" } });
  const vertical = { id: "p", title: "Peer", labels: { high: "leader", mid: "mid", low: "laggard" }, metrics: [{ metric: "a", polarity: 1 }, { metric: "b", polarity: -1 }] };
  const by = new Map([["a", [sig("x", 3), sig("y", 2), sig("z", 1)]], ["b", [sig("x", 3), sig("y", 2), sig("z", 1)]]]);
  const out = V.peerTable(vertical, by, { horizon: "365d", entity: { entity_id: "y", name: "Y" }, peers: ["x", "y", "z"] });
  assert.equal(out.score, 50);
  assert.equal(out.metrics[1].rows[0].entity_id, "z", "polarity -1 ranks the lowest value first");
  const lone = V.peerTable(vertical, new Map([["a", [sig("x", 3), sig("y", 2)]]]), { horizon: "365d", entity: { entity_id: "z", name: "Z" }, peers: ["x", "y", "z"] });
  assert.equal(lone.status, "insufficient_data");
  assert.equal(lone.score, null);
});

test("macro batch 2: yield curve, bank health, euro rates and metals", async () => {
  const yc = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "yield-curve" })).json;
  checkBrief(yc, "pmic-macro-signals");
  assert.deepEqual(Object.keys(yc.term_structure.yields_pct), ["1m", "3m", "1y", "2y", "5y", "10y", "30y"]);
  assert.equal(typeof yc.term_structure.inverted_10y_3m, "boolean");
  assert.ok(yc.watch.some((m) => m.series_id === "fred:DGS30"), "tenor yields are watch items");
  const bank = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "bank-health" })).json;
  checkBrief(bank, "pmic-macro-signals");
  assert.ok(bank.inputs.some((m) => m.series_id === "fdic:failures_quarterly") && bank.inputs.some((m) => m.series_id === "cfpb:complaints_total_monthly"));
  assert.ok(bank.recent_events.length > 0 && bank.recent_events.every((e) => e.event_type === "bank_failure"));
  const eu = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "global-rates-fx" })).json;
  checkBrief(eu, "pmic-macro-signals");
  assert.equal(eu.inputs.find((m) => m.series_id === "ecb:FM.B.U2.EUR.4F.KR.DFR.LEV").scoring, "percentile_inverted", "a higher ECB rate reads as tighter");
  assert.equal(eu.watch.filter((m) => m.series_id.startsWith("ecb:EXR.")).length, 5);
  const com = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "commodities" })).json;
  assert.ok(com.inputs.some((m) => m.series_id === "fred:PALUMUSDM"));
  assert.ok(com.watch.some((m) => m.series_id === "pinksheet:gold" && m.value.current > 0), "gold from the Pink Sheet workbook");
});

test("company and pharma batch 2: insider dollar values, public attention, clinical pipeline", async () => {
  const ins = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "insider-activity", entity_id: "nvda" })).json;
  checkBrief(ins, "pmic-company-signals");
  assert.ok(ins.inputs.some((m) => m.series_id === "sec:NVDA:insider_sell_value_weekly" && m.weight === 2));
  const att = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "public-attention", entity_id: "jnj" })).json;
  checkBrief(att, "pmic-company-signals");
  assert.deepEqual(att.inputs.map((m) => m.series_id).sort(), ["wikimedia:JNJ:edits_weekly", "wikimedia:JNJ:pageviews_weekly"]);
  const ct = (await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "clinical-pipeline", entity_id: "pfe" })).json;
  checkBrief(ct, "pmic-pharma-signals");
  assert.ok(ct.inputs.some((m) => m.series_id === "ctgov:PFE:trial_starts_monthly"));
  assert.ok(ct.watch.some((m) => m.series_id === "ctgov:PFE:trial_completions_monthly"));
  assert.ok(ct.recent_events.length > 0 && ct.recent_events.every((e) => e.event_type === "trial_stopped"));
  const pfeOnly = (await call("pmic-pharma-signals", "POST", "/v1/signals", { entity_id: "pfe", limit: 100 })).json;
  assert.ok(pfeOnly.signals.length > 0 && pfeOnly.signals.every((x) => x.entity.entity_id === "pfe"), "an entity filter is not widened by the bundle's scope");
});

test("public sector bundle: recalls, political money and federal spending", async () => {
  const b = "pmic-public-sector-signals";
  const list = (await call(b, "POST", "/v1/verticals", {})).json;
  assert.deepEqual(list.verticals.map((v) => v.id), ["product-recalls", "political-money", "federal-spending", "natural-hazards", "cyber-threat", "disease-activity", "wildfire-activity", "climate-anomaly", "travel-demand", "rulemaking", "medicare-providers", "legislation", "environmental-compliance", "nonprofit-finance"]);
  for (const v of list.verticals) checkBrief((await call(b, "POST", "/v1/brief", { vertical: v.id })).json, b);
  const rec = (await call(b, "POST", "/v1/brief", { vertical: "product-recalls" })).json;
  assert.equal(rec.inputs.length, 6);
  assert.ok(rec.recent_events.length > 0 && rec.recent_events.every((e) => ["product_recall", "vehicle_recall"].includes(e.event_type)));
  const fed = (await call(b, "POST", "/v1/brief", { vertical: "federal-spending" })).json;
  assert.ok(fed.watch.some((m) => m.series_id === "usaspending:obligations_dod_monthly"), "agencies are watch items");
  assert.ok(fed.watch.some((m) => m.series_id === "fred:MTSR133FMS"), "receipts are a watch item");
  const o = (await call(b, "POST", "/v1/overview", {})).json;
  assert.equal(o.count, 14);
  const sig = (await call(b, "POST", "/v1/signals", { limit: 200 })).json;
  assert.ok(sig.signals.every((x) => /^(cpsc|nhtsa|openfda:food|fec|lda|usaspending|fred:MTS|fema|usgs|nws|cisa|nvd|cdc|nifc|noaa|tsa|fedreg|cms|congress|echo|irs990)/.test(x.series_id)), "only public sector series");
  assert.equal((await call(b, "POST", "/v1/signal", { series_id: "fred:UNRATE" })).json.error.code, "unknown_series");
  assert.equal((await call(b, "POST", "/v1/events", {})).status, 404, "no raw events route");
});

test("batch 3 verticals: every one is a scored, cited brief", async () => {
  for (const id of ["treasury-demand", "energy-supply", "trade-flows", "business-formation"]) {
    const r = await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    checkBrief(r.json, "pmic-macro-signals");
  }
  const td = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "treasury-demand" })).json;
  assert.ok(td.inputs.some((m) => m.series_id === "treasury:bid_to_cover_monthly"));
  assert.ok(Array.isArray(td.recent_events) && td.recent_events.every((e) => e.event_type === "weak_treasury_auction"), "only weak auctions are listed");
  const energy = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "energy-supply" })).json;
  assert.equal(energy.inputs.find((m) => m.series_id === "fred:GASREGW").direction, -1, "pump prices read as tightness");
  assert.ok(energy.watch.some((m) => m.series_id === "eia:WPULEUS3"));
  for (const id of ["earnings-quality"]) {
    const r = await call("pmic-company-signals", "POST", "/v1/brief", { vertical: id, entity_id: "aapl" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    checkBrief(r.json, "pmic-company-signals");
  }
  const shortages = (await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "drug-shortages" })).json;
  checkBrief(shortages, "pmic-pharma-signals");
  assert.ok(shortages.recent_events.length > 0 && shortages.recent_events.every((e) => e.event_type === "drug_shortage"), "shortages, not recalls or approvals");
  for (const id of ["natural-hazards", "cyber-threat", "disease-activity"]) {
    const r = await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    checkBrief(r.json, "pmic-public-sector-signals");
  }
  const hazards = (await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: "natural-hazards" })).json;
  assert.ok(hazards.recent_events.some((e) => e.event_type === "disaster_declaration") && hazards.recent_events.some((e) => e.event_type === "earthquake"));
  const cyber = (await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: "cyber-threat" })).json;
  assert.ok(cyber.recent_events.every((e) => e.event_type === "exploited_vulnerability"));
});

test("pharma bundle: market and company briefs", async () => {
  checkBrief((await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "drug-market" })).json, "pmic-pharma-signals");
  const c = (await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "company-safety", entity_id: "lly" })).json;
  checkBrief(c, "pmic-pharma-signals");
  const ids = c.inputs.map((m) => m.series_id).sort();
  assert.deepEqual(ids, ["openfda:LLY:adverse_event_reports_weekly", "openfda:LLY:approvals_weekly", "openfda:LLY:drug_recalls_weekly"], "recalls, adverse events and approvals are scored");
  assert.deepEqual(c.watch.map((m) => m.series_id), ["openfda:LLY:label_updates_weekly"]);
  assert.ok(Array.isArray(c.recent_events));
  assert.equal((await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "company-safety", entity_id: "aapl" })).json.error.code, "unknown_entity");
});

test("raw routes stay inside each bundle's scope; bad input is a 400", async () => {
  const s = (await call("pmic-pharma-signals", "POST", "/v1/signals", { limit: 50 })).json;
  assert.ok(s.count > 0 && s.signals.every((x) => /^(openfda|ctgov|bls|fdawl):/.test(x.series_id)));
  assert.ok(s.signals.every((x) => !x.series_id.startsWith("openfda:food:")), "food recalls belong to the public sector bundle");
  assert.equal((await call("pmic-pharma-signals", "POST", "/v1/signal", { series_id: "fred:UNRATE" })).json.error.code, "unknown_series");
  assert.equal((await call("pmic-macro-signals", "POST", "/v1/signal", { series_id: "fred:UNRATE" })).status, 200);
  assert.equal((await call("pmic-macro-signals", "POST", "/v1/signals", { source_id: "sec" })).json.error.code, "out_of_scope");
  const fred = (await call("pmic-macro-signals", "POST", "/v1/signals", { source_id: "fred", sort: "confidence", limit: 5 })).json;
  assert.ok(fred.signals.every((x) => x.series_id.startsWith("fred:")));
  assert.equal((await call("pmic-macro-signals", "POST", "/v1/events", {})).status, 404, "macro bundle sells no events route");
  for (const body of [[1], { vertical: "nope" }, { vertical: "labor", horizon: "2d" }, { vertical: "global-compare", countries: "us" }]) {
    assert.equal((await call("pmic-macro-signals", "POST", "/v1/brief", body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ amount: -1, from: "2026-01" }, { amount: 5, from: "2026-13" }, { amount: "5", from: "2026-01" }]) {
    assert.equal((await call("pmic-macro-signals", "POST", "/v1/inflation/adjust", body)).status, 400, JSON.stringify(body));
  }
});

test("batch 4 verticals: every one is a scored, cited brief", async () => {
  const plain = {
    "pmic-macro-signals": ["pokt-network-health", "supply-chain-pressure", "food-inflation", "economic-calendar"],
    "pmic-pharma-signals": ["device-safety", "drug-prices", "fda-enforcement"],
    "pmic-public-sector-signals": ["wildfire-activity", "climate-anomaly", "travel-demand", "rulemaking", "medicare-providers", "legislation", "environmental-compliance", "nonprofit-finance"],
  };
  for (const [bundle, ids] of Object.entries(plain)) {
    for (const id of ids) {
      const r = await call(bundle, "POST", "/v1/brief", { vertical: id });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      checkBrief(r.json, bundle);
    }
  }
  for (const id of ["shareholder-returns", "interest-coverage", "investment-cycle", "settlement-fails", "institutional-ownership"]) {
    const r = await call("pmic-company-signals", "POST", "/v1/brief", { vertical: id, entity_id: "msft" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    checkBrief(r.json, "pmic-company-signals");
  }
  const climate = (await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: "climate-anomaly" })).json;
  assert.ok(climate.inputs.every((m) => m.scoring === "unusualness_inverted"), "departures score as closeness to normal");
  const rules = (await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: "rulemaking" })).json;
  assert.equal(rules.inputs.length, 3, "neutral counts read as activity");
  assert.ok(rules.recent_events.length > 0 && rules.recent_events.every((e) => e.event_type === "significant_rule"));
  const states = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "state-labor" })).json;
  assert.equal(states.status, "ok");
  assert.equal(states.country_scores.length, 12);
  assert.match(states.summary, /^12 states /);
  assert.ok(states.citations.every((c) => c.source === "fred"));
  const two = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "state-labor", countries: ["us-ca", "us-tx"] })).json;
  assert.equal(two.country_scores.length, 2);
  const cal = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "economic-calendar" })).json;
  assert.ok(cal.inputs.length >= 6 && cal.inputs.every((m) => m.scoring === "unusualness_inverted"));
  assert.ok(cal.upcoming_events.length > 0, "the next major releases");
  assert.ok(cal.upcoming_events.every((e, i, a) => e.severity === "high" && (i === 0 || a[i - 1].event_time <= e.event_time)), "major only, soonest first");
  const cli = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "leading-indicators" })).json;
  assert.equal(cli.status, "ok");
  assert.equal(cli.country_scores.length, 8);
  assert.ok(cli.citations.every((c) => c.source === "oecd"));
  const fda = (await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "fda-enforcement" })).json;
  assert.ok(fda.recent_events.length > 0 && fda.recent_events.every((e) => e.event_type === "warning_letter"));
  const laws = (await call("pmic-public-sector-signals", "POST", "/v1/brief", { vertical: "legislation" })).json;
  assert.ok(laws.recent_events.every((e) => e.event_type === "public_law"));
  const imf = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "imf-outlook" })).json;
  assert.equal(imf.status, "ok");
  assert.equal(imf.country_scores.length, 8);
  assert.equal(imf.metrics.length, 4);
  const jpm = (await call("pmic-company-signals", "POST", "/v1/brief", { vertical: "interest-coverage", entity_id: "jpm" })).json;
  assert.ok(jpm.status !== "ok" || jpm.inputs.every((m) => !/interest_expense/.test(m.series_id)), "banks have no interest expense input");
});

test("selftest: every bundle passes end to end", async () => {
  for (const b of BUNDLES) {
    const r = await call(b, "GET", "/v1/selftest");
    assert.equal(r.status, 200, `${b}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.pass, true);
  }
  const c = (await call("pmic-company-signals", "GET", "/v1/selftest")).json;
  assert.ok(c.results.filter((x) => x.entity_id).every((x) => ["msft", "aapl", "pfe"].includes(x.entity_id)));
});

test("crypto bundle: every vertical scores; tools answer; no third-party price data in scope", async () => {
  const b = "pmic-crypto-signals";
  const list = (await call(b, "POST", "/v1/verticals", {})).json;
  assert.deepEqual(list.verticals.map((v) => v.id), ["stablecoin-supply", "crypto-liquidity", "futures-positioning", "crypto-prices", "network-fees", "pokt-network-health", "pokt-staking"]);
  for (const v of list.verticals) checkBrief((await call(b, "POST", "/v1/brief", { vertical: v.id })).json, b);
  const st = (await call(b, "POST", "/v1/brief", { vertical: "stablecoin-supply" })).json;
  assert.ok(st.inputs.some((m) => m.series_id === "chainrpc:usdt_supply:tron"));
  const fees = (await call(b, "POST", "/v1/brief", { vertical: "network-fees" })).json;
  assert.ok(fees.watch.some((m) => m.series_id === "chainrpc:block_fullness:eth"));
  const sig = (await call(b, "POST", "/v1/signals", { limit: 200 })).json;
  assert.ok(sig.signals.length > 0 && sig.signals.every((x) => /^(chainrpc|cftc|pokt):/.test(x.series_id)));
  const a = await call(b, "POST", "/v1/tools/address", { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" });
  assert.equal(a.status, 200);
  assert.equal(a.json.valid, true);
  const u = await call(b, "POST", "/v1/tools/units", { amount: "2.5", from: "pokt", to: "upokt" });
  assert.equal(u.json.result, "2500000");
  assert.equal((await call(b, "POST", "/v1/tools/units", { amount: "x", from: "eth", to: "wei" })).status, 400);
  assert.equal((await call("pmic-macro-signals", "POST", "/v1/tools/address", { address: "x" })).status, 404, "tools only on the crypto bundle");
});

// Strict JSON Schema subset (type, enum, minimum, maximum, properties, items). OpenAPI 3.0's
// "nullable" is ignored on purpose, as plain JSON Schema validators in gateways ignore it.
function schemaErrors(schema, v, at = "$") {
  const errs = [];
  const typeOk = (t) => (t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t);
  // A type list (["integer", "null"]) passes if any member matches, as in JSON Schema.
  if (schema.type && !(Array.isArray(schema.type) ? schema.type.some(typeOk) : typeOk(schema.type))) return [`${at}: ${JSON.stringify(v)} is not ${[].concat(schema.type).join(" or ")}`];
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${at}: below minimum`);
  if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${at}: above maximum`);
  if (schema.required && v && typeof v === "object") for (const k of schema.required) if (!(k in v)) errs.push(`${at}.${k}: missing`);
  if (schema.properties && v && typeof v === "object") for (const [k, s] of Object.entries(schema.properties)) if (k in v) errs.push(...schemaErrors(s, v[k], `${at}.${k}`));
  if (schema.items && Array.isArray(v)) v.forEach((x, i) => errs.push(...schemaErrors(schema.items, x, `${at}[${i}]`)));
  return errs;
}

test("the published Brief schemas reject a non-null score, label or trend_basis of the wrong type (PNF, 2026-10-07)", () => {
  for (const b of BUNDLES) {
    const portal = require(`../packs/ops/${b}/portal-descriptor.json`).outputSchema;
    const brief = require(`../packs/ops/${b}/openapi.json`).components.schemas.Brief;
    const good = require(`../packs/ops/${b}/portal-descriptor.json`).example.responseSummary;
    for (const schema of [portal, brief]) {
      assert.deepEqual(schemaErrors(schema, good), [], `${b}: the example must pass`);
      assert.deepEqual(schemaErrors(schema, { ...good, score: null, label: null, trend_basis: null }), [], `${b}: nulls must pass`);
    }
    // Only the portal descriptor can type a nullable field; the openapi spec leaves the type off.
    for (const bad of [{ score: "59" }, { score: 59.5 }, { score: 101 }, { score: -1 }, { label: 5 }, { trend_basis: true }]) {
      assert.notDeepEqual(schemaErrors(portal, { ...good, ...bad }), [], `${b}: ${JSON.stringify(bad)} must fail`);
    }
    assert.ok(!JSON.stringify(require(`../packs/ops/${b}/openapi.json`)).includes('"nullable"'), `${b}: openapi.json must not use nullable`);
  }
});

test("every brief, for every company and horizon, matches the declared Brief schema strictly", async () => {
  for (const b of BUNDLES) {
    const spec = require(`../packs/ops/${b}/openapi.json`);
    const brief = spec.components.schemas.Brief;
    const portal = require(`../packs/ops/${b}/portal-descriptor.json`);
    // A gateway may derive its response schema from the listing's example, so the example must be
    // a valid answer too (a string where the real answer has an object made every call fail).
    assert.deepEqual(schemaErrors(portal.outputSchema, portal.example.responseSummary), [], `${b} example`);
    const bundle = require(`../packs/bundles/${b}.json`);
    for (const v of bundle.verticals) {
      const entities = ["entity_composite", "entity_events", "peer_table"].includes(v.kind) ? bundle.entities : [null];
      for (const e of entities) {
        for (const horizon of ["7d", "30d", "90d", "365d"]) {
          const r = await call(b, "POST", "/v1/brief", { vertical: v.id, horizon, ...(e ? { entity_id: e } : {}) });
          assert.equal(r.status, 200);
          assert.deepEqual(schemaErrors(brief, r.json), [], `${b} ${v.id} ${e || ""} ${horizon}`);
          assert.deepEqual(schemaErrors(portal.outputSchema, r.json), [], `portal ${b} ${v.id} ${e || ""} ${horizon}`);
        }
      }
    }
  }
});

test("inputs the hub has never collected are pending, not missing", () => {
  const V = require("../packs/lib/verticals");
  const cur = (id, status, score) => ({ series_id: id, status, metric: { label: id, polarity: 1 }, composite_score: score, percentile: 50, trend: "flat", confidence: { score: 90 }, risk_flags: [] });
  const vertical = { id: "x", title: "X", labels: { high: "h", mid: "m", low: "l" } };
  const members = [
    V.scoreMember({ weight: 2 }, cur("a", "ok", 70), null),
    V.scoreMember({ weight: 2 }, cur("b", "no_data", null), null),
    V.scoreMember({ weight: 1 }, cur("c", "no_data", null), null),
  ];
  const out = V.combine(vertical, members, { horizon: "90d" });
  assert.equal(out.status, "ok");
  assert.equal(out.score, 70);
  assert.ok(out.risk_flags.includes("inputs_pending"));
  assert.deepEqual(out.pending_inputs.map((p) => p.series_id), ["b", "c"]);
  assert.equal(out.coverage.inputs, 1);
});

// The shared `verified` block (pocket-agentic-envelope/1, docs/envelope/): on every brief, overview, events and
// address answer of every bundle, valid against the repo schema, copied from the answer (never changing it).
test("verified: every brief, overview, events and address answer carries a valid shared block", async () => {
  const ENV = path.join(__dirname, "..", "..", "docs", "envelope");
  assert.equal(fs.readFileSync(path.join(__dirname, "..", "packs", "lib", "verified-core.js"), "utf8"), fs.readFileSync(path.join(ENV, "verified-core.js"), "utf8"), "packs/lib/verified-core.js must be an unchanged copy");
  const { validate } = await import(require("node:url").pathToFileURL(path.join(ENV, "validate.mjs")).href);
  const schema = JSON.parse(fs.readFileSync(path.join(ENV, "pocket-agentic-envelope-v1.schema.json"), "utf8"));
  const ok = (v, what) => { assert.ok(v, `${what}: verified missing`); assert.deepEqual(validate(schema, v), [], what); };
  for (const b of BUNDLES) {
    const bundle = require(`../packs/bundles/${b}.json`);
    for (const v of bundle.verticals) {
      const entities = ["entity_composite", "entity_events", "peer_table"].includes(v.kind) ? bundle.entities : [null];
      for (const e of entities) {
        const r = await call(b, "POST", "/v1/brief", { vertical: v.id, ...(e ? { entity_id: e } : {}) });
        const x = r.json.verified;
        ok(x, `${b} ${v.id} ${e || ""}`);
        assert.equal(x.service, b);
        assert.equal(x.service_version, bundle.version);
        assert.equal(x.route, "/v1/brief");
        assert.equal(x.assessment.native_status, r.json.status);
        assert.equal(x.assessment.score, r.json.score ?? null);
        assert.equal(x.assessment.scale, null, "PMIC scores read against the vertical's labels");
        if (e) assert.match(x.subject.id, /^company:(sec-cik:\d{10}|pmic:[a-z0-9]+)$/);
        else assert.equal(x.subject.id, `topic:pmic-${b.replace(/^pmic-/, "").replace(/-signals$/, "")}:${v.id}`);
        assert.ok(x.evidence.length > 0 || !(r.json.citations || []).length, `${b} ${v.id}: cited sources become evidence`);
      }
    }
    const ov = await call(b, "POST", "/v1/overview", {});
    if (ov.status === 200) {
      ok(ov.json.verified, `${b} overview`);
      assert.equal(ov.json.verified.evidence_more.route, "/v1/brief");
    }
  }
  // Companies are keyed by their SEC CIK (owner, 2026-11-11).
  const fund = (await call("pmic-company-signals", "POST", "/v1/overview", { entity_id: "aapl" })).json.verified;
  assert.equal(fund.subject.id, "company:sec-cik:0000320193");
  assert.equal(fund.subject.identifiers.ticker, "AAPL");
  const ev = await call("pmic-company-signals", "POST", "/v1/events", { entity_id: "aapl" });
  ok(ev.json.verified, "company events");
  assert.equal(ev.json.verified.subject.id, "company:sec-cik:0000320193");
  assert.equal(ev.json.verified.assessment.label, `${ev.json.events.length} event${ev.json.events.length === 1 ? "" : "s"}`);
  const ph = await call("pmic-pharma-signals", "POST", "/v1/events", {});
  ok(ph.json.verified, "pharma events");
  // Country tables link the countries asked for.
  const mac = require("../packs/bundles/pmic-macro-signals.json").verticals.find((v) => v.kind === "country_table");
  if (mac) {
    const ct = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: mac.id, countries: ["us", "de"] })).json.verified;
    assert.deepEqual(ct.subject.links.map((l) => [l.rel, l.id]), [["covers", "jurisdiction:iso3166:us"], ["covers", "jurisdiction:iso3166:de"]]);
  }
  const addr = await call("pmic-crypto-signals", "POST", "/v1/tools/address", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });
  ok(addr.json.verified, "address tool");
  assert.equal(addr.json.verified.subject.id, "wallet:evm-address:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
  // Errors carry no block.
  const bad = await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.verified, undefined);
});

// Build 3 (2026-11-14): POST /v1/evidence-packet on the company, pharma and public-sector packs.
test("evidence packet: dated, cited events per entity with per-source coverage, paging and filters", async () => {
  const ENV = path.join(__dirname, "..", "..", "docs", "envelope");
  const { validate } = await import(require("node:url").pathToFileURL(path.join(ENV, "validate.mjs")).href);
  const schema = JSON.parse(fs.readFileSync(path.join(ENV, "pocket-agentic-envelope-v1.schema.json"), "utf8"));

  // A pharma company in the company pack: SEC plus the three pharma sources, each with a coverage line.
  const pfe = await call("pmic-company-signals", "POST", "/v1/evidence-packet", { entity_id: "pfe" });
  assert.equal(pfe.status, 200);
  assert.equal(pfe.json.service, "pmic-company-signals");
  assert.equal(pfe.json.subject.entity_id, "pfe");
  assert.deepEqual(pfe.json.coverage.map((c) => c.source_id), ["sec", "openfda", "ctgov", "fdawl"]);
  assert.ok(pfe.json.items_total > 50 && pfe.json.items_returned === 50 && pfe.json.next_cursor === "50");
  assert.ok(pfe.json.window.days === 366);
  const dates = pfe.json.items.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "newest first");
  for (const i of pfe.json.items) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.kind && i.title && /^https?:\/\//.test(i.url) && /^[0-9a-f]{64}$/.test(i.evidence_hash), JSON.stringify(i));
    assert.ok(["sec", "openfda", "ctgov", "fdawl"].includes(i.source_id));
  }
  assert.equal(Object.values(pfe.json.kinds_found).reduce((a, b) => a + b, 0), pfe.json.items_total);
  assert.deepEqual(validate(schema, pfe.json.verified), [], "pfe verified");
  assert.equal(pfe.json.verified.route, "/v1/evidence-packet");
  assert.equal(pfe.json.verified.subject.kind, "company");

  // The second page continues the first; the packet hash covers every page.
  const page2 = await call("pmic-company-signals", "POST", "/v1/evidence-packet", { entity_id: "pfe", cursor: "50" });
  assert.equal(page2.json.items[0].evidence_hash !== pfe.json.items[0].evidence_hash, true);
  assert.ok(page2.json.items[0].date <= pfe.json.items[49].date);
  assert.equal(page2.json.packet_hash, pfe.json.packet_hash);

  // kinds and q narrow the packet; kinds_found still describes the whole window.
  const recalls = await call("pmic-company-signals", "POST", "/v1/evidence-packet", { entity_id: "pfe", kinds: ["drug_recall", "warning_letter"] });
  assert.ok(recalls.json.items_total >= 1 && recalls.json.items.every((i) => ["drug_recall", "warning_letter"].includes(i.kind)));
  assert.notEqual(recalls.json.packet_hash, pfe.json.packet_hash);
  const q = await call("pmic-company-signals", "POST", "/v1/evidence-packet", { entity_id: "pfe", q: "Unavailable" });
  assert.ok(q.json.items_total >= 1 && q.json.items.every((i) => `${i.title} ${JSON.stringify(i.fields)}`.toLowerCase().includes("unavailable")));

  // A non-pharma company: SEC only, no claim that openFDA was checked.
  const aapl = await call("pmic-company-signals", "POST", "/v1/evidence-packet", { entity_id: "aapl", max_items: 5 });
  assert.deepEqual(aapl.json.coverage.map((c) => c.source_id), ["sec"]);
  assert.ok(aapl.json.items.every((i) => i.source_id === "sec") && aapl.json.items_returned === 5);

  // Pharma pack: the drug market, from openFDA only; a sector entity is a topic, not a company.
  const mkt = await call("pmic-pharma-signals", "POST", "/v1/evidence-packet", { entity_id: "us-drug-market" });
  assert.equal(mkt.status, 200);
  assert.deepEqual(mkt.json.coverage.map((c) => c.source_id), ["openfda"]);
  assert.equal(mkt.json.verified.subject.kind, "topic");
  assert.deepEqual(validate(schema, mkt.json.verified), [], "us-drug-market verified");
  // The pharma pack does not sell SEC filings (pmic-company-signals does).
  const pfePharma = await call("pmic-pharma-signals", "POST", "/v1/evidence-packet", { entity_id: "pfe" });
  assert.ok(pfePharma.json.items_total > 0 && pfePharma.json.items.every((i) => i.source_id !== "sec"));

  // Public-sector pack: laws from Congress.gov; hazards from FEMA and USGS.
  const laws = await call("pmic-public-sector-signals", "POST", "/v1/evidence-packet", { entity_id: "us-congress" });
  assert.equal(laws.status, 200);
  assert.ok(laws.json.items_total > 0 && laws.json.items.every((i) => i.kind === "public_law" && i.source_id === "congress"));
  const hz = await call("pmic-public-sector-signals", "POST", "/v1/evidence-packet", { entity_id: "us-hazards" });
  assert.deepEqual(hz.json.coverage.map((c) => c.source_id), ["fema", "usgs"]);

  // A window with nothing in it: every applicable source answers `empty`, nothing is dropped.
  const old = await call("pmic-public-sector-signals", "POST", "/v1/evidence-packet", { entity_id: "us-congress", from: "2025-12-01", to: "2025-12-02" });
  assert.equal(old.json.items_total, 0);
  assert.ok(old.json.coverage.every((c) => c.status === "empty" || c.status === "stale"));

  // Bad input is a 400 with a JSON error; packs without the block don't have the route.
  for (const [b, body, why] of [
    ["pmic-company-signals", {}, "no entity"],
    ["pmic-company-signals", { entity_id: "us-congress" }, "entity of another pack"],
    ["pmic-company-signals", { entity_id: "pfe", from: "2026-13-01" }, "bad date"],
    ["pmic-company-signals", { entity_id: "pfe", from: "2025-01-01", to: "2026-06-01" }, "window over 366 days"],
    ["pmic-company-signals", { entity_id: "pfe", to: "2999-01-01" }, "future"],
    ["pmic-company-signals", { entity_id: "pfe", kinds: [] }, "empty kinds"],
    ["pmic-company-signals", { entity_id: "pfe", kinds: ["Drug Recall"] }, "bad kind"],
    ["pmic-company-signals", { entity_id: "pfe", max_items: 51 }, "max_items"],
    ["pmic-company-signals", { entity_id: "pfe", cursor: "x" }, "cursor"],
  ]) {
    const r = await call(b, "POST", "/v1/evidence-packet", body);
    assert.equal(r.status, 400, why);
    assert.ok(r.json.error && r.json.error.code, why);
  }
  assert.equal((await call("pmic-macro-signals", "POST", "/v1/evidence-packet", { entity_id: "us-congress" })).status, 404);
});

test("evidence packet: coverage statuses, truncation and the window rules (unit)", () => {
  const EV = require("../packs/lib/evidence");
  const now = Date.parse("2026-11-14T12:00:00Z");
  const cfg = { entities: ["pfe", "aapl", "us-congress"], sources: [{ source_id: "sec" }, { source_id: "openfda", industry: "pharma" }, { source_id: "congress", entities: ["us-congress"] }] };
  assert.deepEqual(EV.sourcesFor(cfg, { entity_id: "aapl", industry: "tech" }), ["sec"]);
  assert.deepEqual(EV.sourcesFor(cfg, { entity_id: "pfe", industry: "pharma" }), ["sec", "openfda"]);

  const health = new Map([
    ["sec", { name: "SEC EDGAR", cadence_minutes: 360, last_success_at: "2026-11-14T06:00:00Z" }],
    ["openfda", { name: "openFDA", cadence_minutes: 1440, last_success_at: "2026-11-01T00:00:00Z" }],
  ]);
  assert.equal(EV.coverageLine("sec", 3, health, now).status, "checked_ok");
  assert.equal(EV.coverageLine("sec", 0, health, now).status, "empty");
  assert.equal(EV.coverageLine("openfda", 0, health, now).status, "stale");
  assert.equal(EV.coverageLine("ctgov", 0, health, now).status, "failed");
  // Hub mode: the hub's own fetch log is empty, so freshness is the Pi's last push and its open alerts.
  const hubHealth = new Map([["congress", { name: "Congress.gov", cadence_minutes: 1440, last_success_at: null }], ["fedreg", { name: "Federal Register", last_success_at: null }]]);
  const pushed = { received_at: "2026-11-14T09:00:00Z", open_alerts: [{ kind: "api_failure", source_id: "fedreg", last_seen: "2026-11-14T08:00:00Z" }, { kind: "stale", source_id: "congress" }] };
  assert.equal(EV.coverageLine("congress", 4, hubHealth, now, pushed).status, "checked_ok", "a data alert (stale series) is not a fetch failure");
  assert.equal(EV.coverageLine("congress", 4, hubHealth, now, pushed).collector_pushed_at, "2026-11-14T09:00:00Z");
  assert.equal(EV.coverageLine("congress", 0, hubHealth, now, pushed).status, "empty");
  assert.match(EV.coverageLine("fedreg", 2, hubHealth, now, pushed).note, /api_failure/);
  assert.equal(EV.coverageLine("fedreg", 2, hubHealth, now, pushed).status, "stale");
  assert.equal(EV.coverageLine("congress", 4, hubHealth, now, { received_at: "2026-11-10T00:00:00Z", open_alerts: [] }).status, "stale", "the Pi stopped pushing");
  assert.equal(EV.coverageLine("congress", 4, hubHealth, now, null).status, "failed");

  const input = EV.parseInput({ entity_id: "pfe" }, cfg, { now });
  assert.deepEqual([input.from, input.to, input.days], ["2025-11-14", "2026-11-14", 366]);
  assert.throws(() => EV.parseInput({ entity_id: "pfe", from: "2023-01-01", to: "2023-06-01" }, cfg, { now }), /at most 1095 days back/);

  const ev = (d, src = "sec", type = "filing_8k") => ({ source_id: src, event_type: type, event_time: d, title: `${type} ${d}`, severity: "low", source_url: "https://example.gov/x", detail: {}, fetch_time: "2026-11-14T00:00:00Z" });
  // A full hub list that still ends after `from` may be cut short: incomplete, with a note.
  const full = Array.from({ length: EV.HUB_LIMIT }, (_, i) => ev(new Date(now - i * 3600000).toISOString().slice(0, 10)));
  const p = EV.buildPacket({ input, entity: { entity_id: "pfe", industry: "pharma" }, cfg, lists: [full], health, now });
  assert.equal(p.complete, false);
  assert.ok(p.notes.some((n) => n.includes("at most 500")) && p.notes.some((n) => n.includes("openfda (stale)")));
  // Duplicates across kind lists count once; events outside the window or from other sources are left out.
  const q = EV.buildPacket({ input, entity: { entity_id: "pfe", industry: "pharma" }, cfg, lists: [[ev("2026-11-01"), ev("2025-01-01"), ev("2026-11-02", "congress", "public_law")], [ev("2026-11-01")]], health, now });
  assert.equal(q.items_total, 1);
  assert.deepEqual(q.coverage.map((c) => [c.source_id, c.status, c.items_in_window]), [["sec", "checked_ok", 1], ["openfda", "stale", 0]]);
  // The same events give the same hashes.
  const again = EV.buildPacket({ input, entity: { entity_id: "pfe", industry: "pharma" }, cfg, lists: [[ev("2026-11-01")]], health, now });
  assert.equal(again.packet_hash, q.packet_hash);
  assert.equal(again.items[0].evidence_hash, q.items[0].evidence_hash);
});

// Build 2 (2026-11-15): POST /v1/token-risk on the crypto pack, from the hub's token-risk replica.
test("token risk: covered, not_covered (queued) and out_of_scope tokens; bad input is a 400", async () => {
  const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tokenrisk-batch.json"), "utf8"));
  const w = dbLib.open({ dataDir: HUB_DIR });
  require("../lib/tokenrisk").applyBatch(w, FIX.body, { publicKeyHex: FIX.public_key, now: new Date(Date.parse(FIX.built_at) + 60000) });
  w.close();
  const r = await call("pmic-crypto-signals", "POST", "/v1/token-risk", { tokens: [
    { chain: "eth", address: "0x" + "A0".repeat(20) },
    { chain: "base", address: "0x" + "b1".repeat(20) },
    { chain: "arbitrum", address: "0x" + "cc".repeat(20) },
    { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.json.service, "pmic-crypto-signals");
  const [a, b, c, d] = r.json.results;
  assert.equal(a.verdict, "low");
  assert.ok(["ok", "stale"].includes(a.status));
  assert.equal(a.input.chain, "eth");
  assert.equal(b.verdict, "high");
  assert.equal(c.status, "not_covered");
  assert.equal(c.see.service, "pump-check");
  assert.equal(d.status, "out_of_scope");
  assert.match(r.json.disclaimer, /Not financial advice/);
  const ENV = path.join(__dirname, "..", "..", "docs", "envelope");
  const { validate } = await import(require("node:url").pathToFileURL(path.join(ENV, "validate.mjs")).href);
  const schema = JSON.parse(fs.readFileSync(path.join(ENV, "pocket-agentic-envelope-v1.schema.json"), "utf8"));
  assert.deepEqual(validate(schema, r.json.verified), []);
  assert.equal(r.json.verified.route, "/v1/token-risk");
  const single = await call("pmic-crypto-signals", "POST", "/v1/token-risk", { tokens: [{ chain: "base", address: "0x" + "b1".repeat(20) }] });
  assert.equal(single.json.verified.subject.kind, "asset");
  assert.equal(single.json.verified.assessment.label, "high");
  // The uncovered token is now in the hub's queue for the Pi's next run.
  const q = dbLib.open({ dataDir: HUB_DIR });
  assert.equal(q.prepare("SELECT count FROM tokenrisk_requests WHERE asset = ?").get("arbitrum:0x" + "cc".repeat(20)).count >= 1, true);
  q.close();
  for (const bad of [{}, { tokens: [] }, { tokens: [{ chain: "eth" }] }, { tokens: Array(11).fill({ chain: "eth", address: "0x" + "a0".repeat(20) }) }]) {
    assert.equal((await call("pmic-crypto-signals", "POST", "/v1/token-risk", bad)).status, 400);
  }
  assert.equal((await call("pmic-company-signals", "POST", "/v1/token-risk", { tokens: [{ chain: "eth", address: "0x" + "a0".repeat(20) }] })).status, 404);
});

// 0.10.x: every 4xx says how to fix the call: valid values where they are known, a sample of real
// series ids, and a working example body for the route. A wrong path lists the real routes.
test("errors carry machine-readable hints and a working example", async () => {
  const b = "pmic-crypto-signals";
  const noVertical = await call(b, "POST", "/v1/brief", {});
  assert.equal(noVertical.status, 400);
  assert.equal(noVertical.json.error.code, "unknown_vertical");
  assert.equal(noVertical.json.error.field, "vertical");
  assert.ok(noVertical.json.error.valid.includes("crypto-prices"));
  assert.equal(noVertical.json.error.see, "POST /v1/verticals");
  assert.deepEqual(noVertical.json.error.example, { vertical: "stablecoin-supply", horizon: "30d" });
  const fixed = await call(b, "POST", "/v1/brief", noVertical.json.error.example);
  assert.equal(fixed.status, 200, "the example body works as sent");

  const noSeries = await call(b, "POST", "/v1/explain", {});
  assert.equal(noSeries.status, 400);
  assert.equal(noSeries.json.error.field, "series_id");
  assert.ok(noSeries.json.error.valid_count > 0 && noSeries.json.error.valid_sample.length > 0);
  const retry = await call(b, "POST", "/v1/explain", { series_id: noSeries.json.error.valid_sample[0] });
  assert.equal(retry.status, 200, "a sampled id answers");
  const unknown = await call(b, "POST", "/v1/signal", { series_id: "nope:nothing" });
  assert.equal(unknown.json.error.code, "unknown_series");
  assert.ok(unknown.json.error.valid_sample.length > 0);

  const units = await call(b, "POST", "/v1/tools/units", { amount: "1", from: "eth", to: "dollars" });
  assert.equal(units.status, 400);
  assert.ok(units.json.error.valid_units.includes("gwei"));
  assert.deepEqual(units.json.error.example, { amount: "1.5", from: "eth", to: "gwei" });
  assert.equal((await call(b, "POST", "/v1/tools/units", units.json.error.example)).status, 200);

  const sort = await call(b, "POST", "/v1/signals", { sort: "best" });
  assert.deepEqual(sort.json.error.valid, ["composite", "change", "abs_change", "confidence", "deviation"]);
  const horizon = await call(b, "POST", "/v1/brief", { vertical: "crypto-prices", horizon: "1y" });
  assert.deepEqual(horizon.json.error.valid, ["7d", "30d", "90d", "365d"]);

  const lost = await call(b, "POST", "/v1/scores", {});
  assert.equal(lost.status, 404);
  assert.ok(lost.json.error.routes.includes("POST /v1/brief") && lost.json.error.routes.includes("POST /v1/tools/units"));
  const odd = await call(b, "POST", "/v1/<b>x</b>", {});
  assert.ok(!odd.json.error.message.includes("<"), "the echoed path is stripped of markup");

  // Company: entity routes show an entity in their example.
  const ev = await call("pmic-company-signals", "POST", "/v1/events", { entity_id: "nope" });
  assert.equal(ev.status, 400);
  assert.ok(ev.json.error.example.entity_id);
});
