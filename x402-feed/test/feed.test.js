"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
process.env.FEED_TOKEN = "a".repeat(64);
process.env.FEED_NETWORK = "beta";
const { ROUTES, parseTarget, backendHost, tokenOk } = require("../server.js");

test("only allowlisted service routes are forwarded", () => {
  assert.deepEqual(parseTarget("/v1/treasury-capital-score/tcs6/score"), { service: "treasury-capital-score", path: "tcs6/score" });
  assert.deepEqual(parseTarget("/v1/pmic-macro-signals/inflation/adjust"), { service: "pmic-macro-signals", path: "inflation/adjust" });
  for (const p of ["/v1/pocket-confidential-queue/submit", "/v1/pmic-hub/anything", "/v1/brand-protection/brand/photo",
    "/v1/treasury-capital-score/../ingest", "/v1/treasury-capital-score/tcs6/score/../x", "/v1/agent-trust/health", "/x"]) {
    assert.equal(parseTarget(p), null, p);
  }
  assert.ok(!("pocket-confidential" in ROUTES) && !("pmic-hub" in ROUTES));
});

test("Beta reads Beta backends", () => {
  assert.equal(backendHost("agent-trust"), "agent-trust-beta-backend");
});

test("bearer token is required and compared exactly", () => {
  assert.equal(tokenOk(`Bearer ${"a".repeat(64)}`), true);
  assert.equal(tokenOk(`Bearer ${"a".repeat(63)}b`), false);
  assert.equal(tokenOk("a".repeat(64)), false);
  assert.equal(tokenOk(undefined), false);
});
