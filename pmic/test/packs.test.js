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
const BUNDLES = ["pmic-macro-signals", "pmic-company-signals", "pmic-pharma-signals"];
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
  await collectOnce(db, catalog, { now, dataDir: dir, env: { BEA_API_KEY: "k", PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl: makeFetch(catalog, { now, blsMirrorsFred: true }) });
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
    assert.deepEqual((await call(b, "GET", "/v1/version")).json, { service: b, version: "0.1.0" });
    for (const p of ["/v1/health", "/healthz"]) {
      const h = await call(b, "GET", p);
      assert.equal(h.status, 200);
      assert.equal(h.json.status, "ok");
    }
  }
});

test("macro bundle: every vertical is a scored, cited brief", async () => {
  const list = (await call("pmic-macro-signals", "POST", "/v1/verticals", {})).json;
  assert.equal(list.count, 7);
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
    assert.ok(r.json.inputs.length >= 4);
    // The stub hub has one scoring pass, so there is no stored score from 90 days ago yet.
    assert.equal(r.json.trend_basis, "input_trends");
    const words = require("../packs/bundles/pmic-macro-signals.json").verticals.find((x) => x.id === v.id).trend_words;
    assert.ok(["steady", words.up, words.down].includes(r.json.trend), `${v.id} trend ${r.json.trend}`);
  }
  const rates = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "rates" })).json;
  assert.equal(typeof rates.curve.inverted, "boolean");
  assert.ok(rates.inputs.some((m) => m.scoring === "percentile_inverted"), "neutral rate series are read as tightness");
  const commodities = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "commodities" })).json;
  assert.ok(commodities.watch.some((m) => m.series_id === "fred:IQ"), "neutral members without a direction are watch items");
  const de = (await call("pmic-macro-signals", "POST", "/v1/brief", { vertical: "global-compare", countries: ["us", "de"] })).json;
  assert.equal(de.country_scores.length, 2);
});

test("macro overview and inflation calculator", async () => {
  const o = (await call("pmic-macro-signals", "POST", "/v1/overview", {})).json;
  assert.equal(o.count, 7);
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
  assert.equal(o.count, 2);
  assert.equal((await call("pmic-company-signals", "POST", "/v1/events", {})).status, 400, "company events need an entity");
  const ev = await call("pmic-company-signals", "POST", "/v1/events", { entity_id: "aapl", limit: 5 });
  assert.equal(ev.status, 200);
  assert.ok(ev.json.events.every((e) => e.entity_id === "aapl"));
});

test("pharma bundle: market and company briefs", async () => {
  checkBrief((await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "drug-market" })).json, "pmic-pharma-signals");
  const c = (await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "company-safety", entity_id: "lly" })).json;
  checkBrief(c, "pmic-pharma-signals");
  assert.ok(Array.isArray(c.recent_events));
  assert.equal((await call("pmic-pharma-signals", "POST", "/v1/brief", { vertical: "company-safety", entity_id: "aapl" })).json.error.code, "unknown_entity");
});

test("raw routes stay inside each bundle's scope; bad input is a 400", async () => {
  const s = (await call("pmic-pharma-signals", "POST", "/v1/signals", { limit: 50 })).json;
  assert.ok(s.count > 0 && s.signals.every((x) => x.series_id.startsWith("openfda:")));
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
