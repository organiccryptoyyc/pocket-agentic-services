// The service pack template against a real hub: scope is enforced, answers carry the pack's
// service id, and the pack keeps serving cached answers when the hub goes away.
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

const HUB_PORT = 19600 + Math.floor(Math.random() * 300);
const PACK_PORT = HUB_PORT + 300;
let hub;
let pack;

function start(script, cwd, env, marker) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
    let seen = "";
    p.stdout.on("data", (d) => { seen += d; if (seen.includes(marker)) resolve(p); });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("exit", (c) => reject(new Error(`${script} exited ${c}`)));
  });
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-pack-"));
  const catalog = catalogLib.load();
  const db = dbLib.open({ dataDir: dir });
  const now = new Date("2026-10-04T06:00:00Z");
  await collectOnce(db, catalog, { now, dataDir: dir, env: { PMIC_SEC_USER_AGENT: "t t@example.com" }, fetchImpl: makeFetch(catalog, { now }), sources: ["openfda", "sec", "fred"] });
  db.close();
  hub = await start("server.js", path.join(__dirname, ".."), { PORT: String(HUB_PORT), PMIC_DATA_DIR: dir, PMIC_API_TOKEN: "hub-token", PMIC_INGEST_TOKEN: "" }, '"listening":true');
  pack = await start("server.js", path.join(__dirname, "..", "pack-template"), { PORT: String(PACK_PORT), PMIC_HUB_URL: `http://127.0.0.1:${HUB_PORT}`, PMIC_API_TOKEN: "hub-token" }, '"listening":true');
});

after(() => { for (const p of [hub, pack]) if (p) p.kill(); });

async function call(route, body) {
  const res = await fetch(`http://127.0.0.1:${PACK_PORT}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  assert.ok(res.status < 500);
  return { status: res.status, json };
}

test("pack answers inside its scope only", async () => {
  const r = await call("/v1/signals", { category: "macro", limit: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.service, "pharma-safety-signals");
  assert.ok(r.json.count > 0 && r.json.signals.every((s) => s.metric.category === "health"), "scope overrides the caller's category");
  assert.equal((await call("/v1/signal", { series_id: "openfda:drug_recalls_weekly" })).status, 200);
  const out = await call("/v1/signal", { series_id: "fred:UNRATE" });
  assert.equal(out.status, 400);
  assert.equal(out.json.error.code, "unknown_series");
  const ev = await call("/v1/events", { limit: 50 });
  assert.ok(ev.json.events.every((e) => ["drug_recall", "drug_approval", "filing_8k", "filing_10q", "filing_10k", "insider_form4", "ownership_13g", "ownership_13d"].includes(e.event_type)));
  assert.equal((await call("/v1/explain", { series_id: "openfda:PFE:drug_recalls_weekly" })).status, 200);
  assert.equal((await call("/v1/signals", { horizon: "2y" })).status, 400);
});

test("pack serves cached answers when the hub is down, and a JSON 4xx when it has none", async () => {
  await call("/v1/catalog", {});
  hub.kill();
  await new Promise((r) => setTimeout(r, 200));
  const again = await call("/v1/catalog", {});
  assert.equal(again.status, 200);
  const miss = await call("/v1/catalog", { q: "never-asked-before" });
  assert.equal(miss.status, 400);
  assert.ok(miss.json.error);
});
