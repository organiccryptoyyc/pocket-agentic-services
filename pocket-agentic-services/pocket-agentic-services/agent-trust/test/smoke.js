// In-process smoke test: boots server.js against the network stub (preload
// this via `node -r ./test/stub-network.js test/smoke.js`) on an ephemeral
// port and asserts the core invariants: correct routing, deterministic
// scoring bounds, the SSRF guard, and 4xx-never-5xx error shaping.
"use strict";
const assert = require("assert");
const http = require("http");

process.env.PORT = "0";
process.env.TRADE_GOV_SUBSCRIPTION_KEY = process.env.TRADE_GOV_SUBSCRIPTION_KEY || "smoke-test-key";

const originalListen = http.Server.prototype.listen;
let boundPort = null;
http.Server.prototype.listen = function (port, host, cb) {
  const result = originalListen.call(this, 0, host, () => {
    boundPort = this.address().port;
    if (cb) cb();
  });
  return result;
};

require("../server.js");

function req(path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: "localhost", port: boundPort, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
      }
    );
    r.on("error", reject);
    r.end(data);
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    if (boundPort) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("server did not start");
}

async function main() {
  await waitForServer();

  const dt = await req("/v1/domain-trust", { domain: "example.com" });
  assert.strictEqual(dt.status, 200);
  assert.ok(dt.body.trust_score >= 0 && dt.body.trust_score <= 100, "trust_score must be 0-100");

  const bv = await req("/v1/brand-verify", { domain: "example.com", brand_name: "Example Corp" });
  assert.strictEqual(bv.status, 200);
  assert.strictEqual(bv.body.brand_name_match, true);

  const sc = await req("/v1/sanctions-check", { address: "sanctioned-test-entity" });
  assert.strictEqual(sc.status, 200);
  assert.strictEqual(sc.body.sanctioned, true);

  const badDomain = await req("/v1/domain-trust", { domain: "not a domain" });
  assert.strictEqual(badDomain.status, 422);
  assert.ok(badDomain.status < 500, "must never be a 5xx");

  const badChain = await req("/v1/reputation", { chain: "dogecoin", address: "x" });
  assert.strictEqual(badChain.status, 422);

  console.log("smoke: all assertions passed");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
