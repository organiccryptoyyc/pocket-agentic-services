// Starts the real server against the canned Polymarket stub and checks the
// Pocket backend contract: 200 + JSON on good input, 400 + JSON on bad
// input (never 422 or 5xx), and the card's three healthchecks.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function start(env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["-r", "./test/stub-fetch.js", "server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(PORT), ...env },
    });
    p.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(p); });
    p.on("error", reject);
    p.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
}

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  assert.ok(text.startsWith("{"), `${method} ${route}: body is not a JSON object: ${text.slice(0, 80)}`);
  return { status: res.status, json: JSON.parse(text) };
}

before(async () => { child = await start(); });
after(() => { if (child) child.kill(); });

test("card healthchecks pass", async () => {
  const v = await call("GET", "/v1/version");
  assert.equal(v.status, 200);
  assert.equal(v.json.service, "prediction-market-intel");
  const h = await call("GET", "/v1/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.status, "ok");
  const t = await call("POST", "/v1/top-markets", '{"limit":1}');
  assert.equal(t.status, 200);
  assert.equal(t.json.count, 1);
});

test("every route answers 200 on good input", async () => {
  for (const [route, body] of [
    ["/v1/market-momentum", '{"limit":3,"window":"1w","direction":"any"}'],
    ["/v1/rotation-diff", '{"lookback_hours":24}'],
    ["/v1/market-quality", '{"limit":3,"window":"1mo"}'],
  ]) {
    const r = await call("POST", route, body);
    assert.equal(r.status, 200, route);
  }
});

test("bad input answers 400 + JSON, never 422", async () => {
  for (const [route, body] of [
    ["/v1/top-markets", '{"limit":0}'],
    ["/v1/top-markets", '{"limit":1.5}'],
    ["/v1/top-markets", '{"window":"1yr"}'],
    ["/v1/market-momentum", '{"direction":"sideways"}'],
    ["/v1/rotation-diff", '{"lookback_hours":-1}'],
    ["/v1/top-markets", "notjson"],
  ]) {
    const r = await call("POST", route, body);
    assert.equal(r.status, 400, `${route} ${body}`);
    assert.ok(r.json.error && r.json.error.code, `${route} ${body}: no error.code`);
  }
});

test("total upstream failure answers 400 + JSON, never 5xx", async () => {
  const port = PORT + 1;
  const p = spawn(process.execPath, ["-r", "./test/stub-fetch.js", "server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), SIMULATED_UPSTREAM_FAILURE: "1" },
  });
  try {
    await new Promise((resolve) => p.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(); }));
    const res = await fetch(`http://127.0.0.1:${port}/v1/top-markets`, { method: "POST", body: '{"limit":1}' });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(text).error.code, "upstream_unavailable");
  } finally {
    p.kill();
  }
});
