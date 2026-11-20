// Hourly route counts in the service packs (packs/lib/usage.js): aggregate only, nothing about the caller.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const U = require("../packs/lib/usage");
const { createServer } = require("../packs/lib/http");

const routes = new Map([["POST /v1/brief", async (b, req) => { req.usageTag = `vertical=${b.vertical}`; return { ok: true }; }], ["POST /v1/catalog", async () => ({ ok: true })]]);
const PROBES = ["/", "/v1/version", "/v1/health", "/healthz"];

test("keyFor: known route with tag, probes, and unknown paths never echoed", () => {
  assert.equal(U.keyFor("POST", "/v1/brief", { routes, probePaths: PROBES, tag: "vertical=crypto-prices" }), "POST /v1/brief vertical=crypto-prices");
  assert.equal(U.keyFor("POST", "/v1/catalog", { routes, probePaths: PROBES }), "POST /v1/catalog");
  assert.equal(U.keyFor("GET", "/v1/health", { routes, probePaths: PROBES }), "probe");
  assert.equal(U.keyFor("GET", "/healthz", { routes, probePaths: PROBES }), "probe");
  assert.equal(U.keyFor("POST", "/v1/<script>alert(1)</script>", { routes, probePaths: PROBES }), "unmatched");
  assert.equal(U.keyFor("GET", undefined, { routes, probePaths: PROBES }), "unmatched");
});

test("one log line per finished hour, with counts, status classes and average time", () => {
  let t = Date.parse("2026-11-20T01:10:00Z");
  const lines = [];
  const u = U.createUsage({ service: "pmic-crypto-signals", version: "0.5.1", log: (l) => lines.push(JSON.parse(l)), now: () => t });
  u.record("POST /v1/brief vertical=crypto-prices", 200, 40);
  u.record("POST /v1/brief vertical=crypto-prices", 200, 60);
  u.record("POST /v1/brief vertical=crypto-prices", 400, 5);
  u.record("probe", 200, 1);
  assert.equal(lines.length, 0, "nothing is written until the hour ends");
  t = Date.parse("2026-11-20T02:00:30Z");
  u.tick();
  assert.equal(lines.length, 1);
  const g = lines[0].usage;
  assert.equal(g.service, "pmic-crypto-signals");
  assert.equal(g.hour, "2026-11-20T01:00Z");
  assert.equal(g.total, 4);
  assert.deepEqual(g.counts["POST /v1/brief vertical=crypto-prices"], { ok: 2, client_error: 1, avg_ms: 35 });
  u.tick();
  assert.equal(lines.length, 1, "an empty hour writes nothing and an hour is written once");
  u.record("POST /v1/catalog", 200, 3);
  u.flush();
  assert.equal(lines.length, 2, "flush writes the unfinished hour (redeploy)");
  assert.equal(lines[1].usage.hour, "2026-11-20T02:00Z");
});

test("keys per hour are capped; extra keys fold into 'other'", () => {
  const u = U.createUsage({ log: () => {}, now: () => 0 });
  for (let i = 0; i < U.MAX_KEYS_PER_HOUR + 25; i++) u.record(`k${i}`, 200, 0);
  const h = Object.values(u.snapshot())[0];
  assert.equal(Object.keys(h).length, U.MAX_KEYS_PER_HOUR + 1);
  assert.equal(h.other.ok, 25);
});

test("the server hook counts each response once and keeps nothing about the caller", async () => {
  const lines = [];
  const u = U.createUsage({ service: "t", version: "0", log: (l) => lines.push(l), now: () => 0 });
  const srv = createServer({ service: "t", version: "0", versionPath: "/v1/version", healthPath: "/v1/health", routes,
    onDone: (req, status, ms) => u.record(U.keyFor(req.method, req.usagePath, { routes, probePaths: PROBES, tag: req.usageTag }), status, ms) });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", authorization: "Bearer secret-caller-token", "x-forwarded-for": "203.0.113.9" } }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  await call("POST", "/v1/brief", { vertical: "crypto-prices", note: "caller text" });
  await call("POST", "/v1/brief", { vertical: "network-fees" });
  await call("GET", "/v1/health");
  await call("POST", "/v1/nope");
  await call("POST", "/v1/brief", "not json at all");
  await new Promise((r) => setTimeout(r, 20));
  srv.close();
  u.flush();
  const g = JSON.parse(lines[0]).usage;
  assert.equal(g.total, 5);
  assert.equal(g.counts["POST /v1/brief vertical=crypto-prices"].ok, 1);
  assert.equal(g.counts["POST /v1/brief vertical=network-fees"].ok, 1);
  assert.equal(g.counts.probe.ok, 1);
  assert.equal(g.counts.unmatched.client_error, 1);
  assert.equal(g.counts["POST /v1/brief"].client_error, 1, "a bad body is counted on the route, untagged");
  for (const s of ["secret-caller-token", "203.0.113.9", "caller text", "Bearer"]) assert.ok(!lines[0].includes(s), `log must not contain ${s}`);
});
