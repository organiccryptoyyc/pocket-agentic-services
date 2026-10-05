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
const BUNDLES = ["pmic-macro-signals", "pmic-company-signals", "pmic-pharma-signals", "pmic-public-sector-signals"];
const PORTS = Object.fromEntries(BUNDLES.map((b, i) => [b, HUB_PORT + 400 + i]));
const procs = [];

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
    "pmic-macro-signals": ["pokt-network-health", "crypto-liquidity", "supply-chain-pressure", "food-inflation", "economic-calendar"],
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
