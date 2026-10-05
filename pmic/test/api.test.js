// Starts the real server on a populated data dir and checks the backend contract shared by every
// package in this repo: JSON object on every response, 200 on good input, 4xx + JSON on bad
// input, never a 5xx; bearer auth when PMIC_API_TOKEN is set; hub ingest on its own port.
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

const PORT = 19000 + Math.floor(Math.random() * 500);
const INGEST_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "api-test-token";
let child;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-api-"));
  const catalog = catalogLib.load();
  const db = dbLib.open({ dataDir: dir });
  const now = new Date("2026-10-04T06:00:00Z");
  await collectOnce(db, catalog, { now, dataDir: dir, env: { BEA_API_KEY: "k", PMIC_SEC_USER_AGENT: "t t@example.com", PMIC_NVD_GAP_MS: "0" }, fetchImpl: makeFetch(catalog, { now, blsMirrorsFred: true }) });
  db.close();
  child = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(PORT), PMIC_DATA_DIR: dir, PMIC_API_TOKEN: TOKEN, PMIC_INGEST_TOKEN: "ingest-token", PMIC_INGEST_PORT: String(INGEST_PORT) },
    });
    let seen = "";
    p.stdout.on("data", (d) => {
      seen += d;
      if (seen.includes('"listening":true') && seen.includes('"ingest":"listening"')) resolve(p);
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => child && child.kill());

async function call(method, route, body, { token = TOKEN, base = BASE } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  const json = JSON.parse(text);
  assert.ok(json && typeof json === "object" && !Array.isArray(json), `${route} must answer a JSON object`);
  assert.ok(res.status < 500, `${route} answered ${res.status}`);
  return { status: res.status, json };
}

test("probes", async () => {
  const v = await call("GET", "/v1/version", undefined, { token: null });
  assert.deepEqual(v.json, { service: "pmic", version: "0.1.0" });
  const h = await call("GET", "/v1/health", undefined, { token: null });
  assert.equal(h.json.status, "ok");
  assert.equal(h.json.role, "hub");
  const hz = await call("GET", "/healthz", undefined, { token: null });
  assert.equal(hz.status, 200);
  assert.equal(hz.json.status, "ok");
  assert.equal(h.json.ready, true);
  assert.ok(h.json.scored_series > 300);
});

test("every query route answers 200 with good input", async () => {
  const good = {
    "/v1/catalog": { category: "credit" },
    "/v1/signal": { series_id: "fred:T10Y2Y" },
    "/v1/signals": { industry: "pharma", horizon: "90d", sort: "deviation", limit: 3 },
    "/v1/series": { series_id: "fred:DGS10", from: "2026-09-01" },
    "/v1/explain": { series_id: "sec:JPM:net_income_q", horizon: "365d" },
    "/v1/events": { severity: "high", limit: 5 },
    "/v1/entities": { entity_type: "company" },
    "/v1/sources": {},
    "/v1/alerts": { open_only: false },
  };
  for (const [route, body] of Object.entries(good)) {
    const r = await call("POST", route, body);
    assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.json).slice(0, 200)}`);
    assert.equal(r.json.service, "pmic");
  }
  const s = await call("POST", "/v1/signal", { series_id: "fred:T10Y2Y" });
  assert.equal(s.json.status, "ok");
  assert.ok(s.json.provenance.raw_sha256);
  const src = await call("POST", "/v1/sources", {});
  assert.equal(src.json.count, catalogLib.load().sources.length);
});

test("bad input is 4xx + JSON, never 5xx", async () => {
  const bad = [
    ["/v1/signal", {}],
    ["/v1/signal", { series_id: "fred:NOPE" }],
    ["/v1/signal", { series_id: 42 }],
    ["/v1/signals", { horizon: "1y" }],
    ["/v1/signals", { sort: "random" }],
    ["/v1/signals", { limit: 0 }],
    ["/v1/series", { series_id: "fred:DGS10", from: "yesterday" }],
    ["/v1/events", { severity: "critical" }],
    ["/v1/catalog", "[1,2]"],
    ["/v1/catalog", "{not json"],
  ];
  for (const [route, body] of bad) {
    const r = await call("POST", route, body);
    assert.ok(r.status >= 400 && r.status < 500, `${route} ${JSON.stringify(body)} -> ${r.status}`);
    assert.ok(r.json.error && r.json.error.code);
  }
  const nf = await call("GET", "/v1/nothing");
  assert.equal(nf.status, 404);
});

test("bearer token is required on query routes when configured", async () => {
  assert.equal((await call("POST", "/v1/catalog", {}, { token: null })).status, 401);
  assert.equal((await call("POST", "/v1/catalog", {}, { token: "wrong" })).status, 401);
});

test("hub ingest listener: token required, applies a push", async () => {
  const ib = `http://127.0.0.1:${INGEST_PORT}`;
  assert.equal((await call("POST", "/ingest/sync", { observations: [], events: [] }, { base: ib, token: "wrong" })).status, 401);
  const ok = await call("POST", "/ingest/sync", { observations: [], events: [], collector_status: { note: "test" } }, { base: ib, token: "ingest-token" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.rescored, 0);
  const bad = await call("POST", "/ingest/sync", { observations: "x" }, { base: ib, token: "ingest-token" });
  assert.equal(bad.status, 400);
});
