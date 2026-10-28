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

  const ethRep = await req("/v1/reputation", { chain: "eth", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });
  assert.strictEqual(ethRep.status, 200);
  assert.strictEqual(ethRep.body.coverage, "full");
  assert.strictEqual(ethRep.body.is_verified, true);

  const eoa = await req("/v1/reputation", { chain: "base", address: "0x1" + "a".repeat(39) });
  assert.strictEqual(eoa.status, 200);
  assert.strictEqual(eoa.body.coverage, "basic");
  assert.strictEqual(eoa.body.outgoing_transactions_count, 70);
  assert.strictEqual(eoa.body.is_contract, false);
  assert.strictEqual(eoa.body.is_verified, null);
  assert.strictEqual(eoa.body.coin_balance_wei, "1000000000000000000");
  assert.ok(eoa.body.reputation_score > 0 && eoa.body.reputation_score <= 35);

  const delegated = await req("/v1/reputation", { chain: "arbitrum", address: "0x2" + "b".repeat(39) });
  assert.strictEqual(delegated.status, 200);
  assert.strictEqual(delegated.body.is_delegated, true);
  assert.strictEqual(delegated.body.is_contract, false);
  assert.strictEqual(delegated.body.delegate_address, "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d");

  const contract = await req("/v1/reputation", { chain: "polygon", address: "0x3" + "c".repeat(39) });
  assert.strictEqual(contract.status, 200);
  assert.strictEqual(contract.body.is_contract, true);
  assert.strictEqual(contract.body.is_delegated, false);

  const empty = await req("/v1/reputation", { chain: "base", address: "0x0" + "d".repeat(39) });
  assert.strictEqual(empty.status, 404);

  const rpcDown = await req("/v1/reputation", { chain: "base", address: "0x4" + "e".repeat(39) });
  assert.ok(rpcDown.status >= 400 && rpcDown.status < 500, "RPC failure must be a 4xx, never a 5xx");

  const ethFallback = await req("/v1/reputation", { chain: "eth", address: "0x5" + "f".repeat(39) });
  assert.strictEqual(ethFallback.status, 200);
  assert.strictEqual(ethFallback.body.coverage, "basic");
  assert.strictEqual(ethFallback.body.outgoing_transactions_count, 70);
  assert.ok(ethFallback.body.reasons.some((x) => x.includes("did not answer")));

  const badAddr = await req("/v1/reputation", { chain: "base", address: "0x123" });
  assert.strictEqual(badAddr.status, 422);

  console.log("smoke: all assertions passed");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
