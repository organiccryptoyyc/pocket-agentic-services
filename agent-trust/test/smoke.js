// In-process smoke test: boots server.js against the network stub (preload
// this via `node -r ./test/stub-network.js test/smoke.js`) on an ephemeral
// port and asserts the core invariants: correct routing, deterministic
// scoring bounds, the SSRF guard, and 4xx-never-5xx error shaping.
"use strict";
const assert = require("assert");
const http = require("http");

process.env.PORT = "0";
process.env.TRADE_GOV_SUBSCRIPTION_KEY = process.env.TRADE_GOV_SUBSCRIPTION_KEY || "smoke-test-key";
process.env.BP_LOOKUP_URL = "http://bp-lookup.test:8091";
process.env.PREFLIGHT_BUDGET_MS = "3000";

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

  // 1.5.0: a domain that does not resolve is an answer, not an outage.
  const gone = await req("/v1/domain-trust", { domain: "doesnotexist-agent-trust-test.example" });
  assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
  assert.strictEqual(gone.body.resolves, false);
  assert.strictEqual(gone.body.registration.registered, false);
  assert.strictEqual(gone.body.trust_score, 0);
  assert.match(gone.body.reasons[0], /no address records/);
  assert.ok(Array.isArray(gone.body.checked) && gone.body.checked.length === 3, "says what it checked");
  assert.strictEqual(dt.body.resolves, true);
  const goneSeller = await req("/v1/seller-trust", { url: "https://doesnotexist-agent-trust-test.example/v1/x" });
  assert.strictEqual(goneSeller.status, 422);
  assert.strictEqual(goneSeller.body.error.code, "domain_not_resolvable");
  assert.match(goneSeller.body.error.message, /not an outage/);

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
  assert.ok(eoa.body.reputation_score > 0 && eoa.body.reputation_score <= 60);
  assert.strictEqual(eoa.body.score_max_possible, 60);
  assert.strictEqual(eoa.body.ens_name, "alice.eth", "forward-confirmed ENS name");
  assert.ok(eoa.body.reasons.some((x) => x.includes("alice.eth") && x.includes("+10")));

  const delegated = await req("/v1/reputation", { chain: "arbitrum", address: "0x2" + "b".repeat(39) });
  assert.strictEqual(delegated.status, 200);
  assert.strictEqual(delegated.body.is_delegated, true);
  assert.strictEqual(delegated.body.is_contract, false);
  assert.strictEqual(delegated.body.delegate_address, "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d");

  const contract = await req("/v1/reputation", { chain: "polygon", address: "0x3" + "c".repeat(39) });
  assert.strictEqual(contract.status, 200);
  assert.strictEqual(contract.body.is_contract, true);
  assert.strictEqual(contract.body.is_delegated, false);
  assert.strictEqual(contract.body.is_verified, true, "Sourcify exact_match");
  assert.ok(contract.body.reasons.some((x) => x.includes("Sourcify") && x.includes("+15")));
  assert.strictEqual(contract.body.ens_name, null);

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

  // 1.4.0: /v1/preflight, every check on one counterparty, one verdict.
  const sdn = require("../lib/sdn");
  await sdn.ensure(2000);
  assert.strictEqual(sdn.lookup("0x252a8bd2319d8a555b872990601221b3a2053bce").matches[0].name, "Test Wallet Holder", "EVM addresses match case-insensitively");
  assert.strictEqual(sdn.lookup("bc1qtestlistedaddress0000000000000000000").matches[0].currency, "XBT");
  assert.strictEqual(sdn.lookup("0x252a8bd2319d8a555b872990601221b3a2053bcf").matches.length, 0);

  const pfClean = await req("/v1/preflight", { url: "https://example.com/pay", name: "Example Corp" });
  assert.strictEqual(pfClean.status, 200);
  assert.strictEqual(pfClean.body.verdict, "pass", JSON.stringify(pfClean.body.reasons));
  const byId = (r) => Object.fromEntries(r.body.checks.map((x) => [x.id, x]));
  let c = byId(pfClean);
  assert.deepStrictEqual(Object.keys(c).sort(), ["brand_impersonation", "dns_posture", "domain_registration", "sanctions_name", "seller_trust", "tls_certificate"]);
  assert.strictEqual(c.brand_impersonation.result, "not_available", "a domain outside the watch list is not covered, so it is left out");
  assert.strictEqual(c.domain_registration.result, "pass");
  assert.strictEqual(c.tls_certificate.method, "definitive");
  assert.ok(c.tls_certificate.evidence_hash.length === 64 && c.tls_certificate.changed_at);
  assert.ok(pfClean.body.evidence_hash.length === 64);

  const pfFake = await req("/v1/preflight", { domain: "uniswap-claim.org" });
  assert.strictEqual(pfFake.body.verdict, "warn", "a heuristic fail is a warn, never a definitive fail");
  c = byId(pfFake);
  assert.strictEqual(c.brand_impersonation.result, "fail");
  assert.strictEqual(c.brand_impersonation.data.brand_id, "uniswap.org");
  assert.ok(pfFake.body.reasons[0].startsWith("brand_impersonation: fail"));
  assert.strictEqual(byId(await req("/v1/preflight", { domain: "uniswap.org" })).brand_impersonation.result, "pass");
  assert.strictEqual(byId(await req("/v1/preflight", { domain: "uniswap-help.org" })).brand_impersonation.result, "warn");
  const pfBpDown = await req("/v1/preflight", { domain: "bp-down.example" });
  assert.strictEqual(byId(pfBpDown).brand_impersonation.result, "unknown");
  assert.strictEqual(pfBpDown.body.verdict, "unknown", "unknown never counts as a pass");

  const pfListed = await req("/v1/preflight", { address: "0x252a8bd2319d8a555b872990601221b3a2053bce", chain: "base" });
  assert.strictEqual(pfListed.status, 200);
  assert.strictEqual(pfListed.body.verdict, "fail");
  c = byId(pfListed);
  assert.strictEqual(c.sanctions_address.result, "fail");
  assert.strictEqual(c.sanctions_address.method, "definitive");
  assert.strictEqual(c.sanctions_address.data.publish_date, "2026-11-13");
  const pfWallet = await req("/v1/preflight", { address: "0x1" + "a".repeat(39), chain: "base" });
  c = byId(pfWallet);
  assert.strictEqual(c.sanctions_address.result, "pass");
  assert.ok(c.sanctions_address.summary.includes("no wallet clustering"));
  assert.strictEqual(c.address_reputation.result, "pass");
  assert.strictEqual(pfWallet.body.subject.chain, "base");
  const pfBtc = await req("/v1/preflight", { address: "bc1qtestlistedaddress0000000000000000000" });
  assert.strictEqual(byId(pfBtc).sanctions_address.result, "fail");
  assert.strictEqual(byId(pfBtc).address_reputation.result, "not_available");
  const pfNoActivity = await req("/v1/preflight", { address: "0x0" + "d".repeat(39), chain: "base" });
  assert.strictEqual(byId(pfNoActivity).address_reputation.result, "warn");

  const pfName = await req("/v1/preflight", { name: "Sanctioned-Test-Entity" });
  assert.strictEqual(pfName.body.verdict, "fail");
  assert.strictEqual(byId(pfName).sanctions_name.result, "fail");
  const pfNear = await req("/v1/preflight", { name: "sanctioned-test-entity holdings" });
  assert.strictEqual(byId(pfNear).sanctions_name.result, "warn", "a similar name is a warn for review, not a fail");

  // A subdomain: RDAP describes the registered name above it (rdap.org answers 400 for app.example.com).
  const pfSub = await req("/v1/preflight", { url: "https://app.example.com/swap" });
  assert.strictEqual(pfSub.status, 200);
  assert.strictEqual(byId(pfSub).domain_registration.result, "pass");
  assert.strictEqual(byId(pfSub).domain_registration.data.registered_name, "example.com");
  assert.strictEqual(byId(pfSub).seller_trust.result, "pass", "seller trust works on a subdomain too");

  // since: a repeat call returns only checks that changed after the given time.
  const pfAgain = await req("/v1/preflight", { url: "https://example.com/pay", name: "Example Corp", since: new Date(Date.now() + 1000).toISOString() });
  assert.strictEqual(pfAgain.body.verdict, "pass");
  assert.strictEqual(pfAgain.body.checks_returned, 0);
  assert.strictEqual(pfAgain.body.checks_total, 6);
  const pfAll = await req("/v1/preflight", { url: "https://example.com/pay", name: "Example Corp", since: "2000-01-01T00:00:00Z" });
  assert.strictEqual(pfAll.body.checks_returned, 6);

  for (const [bad, why] of [[{}, "no subject"], [{ domain: "not a domain" }, "bad domain"], [{ url: "ftp://example.com" }, "not http"],
    [{ url: "https://example.com", domain: "other.com" }, "two subjects"], [{ address: "0x123" }, "short address"],
    [{ address: "0x1" + "a".repeat(39), chain: "dogecoin" }, "bad chain"], [{ address: "bc1qtestlistedaddress0000000000000000000", chain: "eth" }, "chain on a non-EVM address"],
    [{ domain: "example.com", since: "yesterday" }, "bad since"]]) {
    const r = await req("/v1/preflight", bad);
    assert.strictEqual(r.status, 422, why);
  }

  // Unit: the verdict rule.
  const { verdictOf } = require("../lib/preflight");
  const k = (result, method = "definitive") => ({ result, method });
  assert.strictEqual(verdictOf([k("pass"), k("not_available")]), "pass");
  assert.strictEqual(verdictOf([k("pass"), k("fail", "heuristic")]), "warn");
  assert.strictEqual(verdictOf([k("warn"), k("fail")]), "fail");
  assert.strictEqual(verdictOf([k("pass"), k("unknown")]), "unknown");
  assert.strictEqual(verdictOf([k("not_available")]), "unknown");

  // 1.2.0: the shared `verified` block (pocket-agentic-envelope/1) on every 200, valid against the repo schema.
  const path = require("path");
  const fs = require("fs");
  const envDir = path.join(__dirname, "..", "..", "docs", "envelope");
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "..", "lib", "verified-core.js"), "utf8"),
    fs.readFileSync(path.join(envDir, "verified-core.js"), "utf8"), "lib/verified-core.js must be an unchanged copy of docs/envelope/verified-core.js");
  const { validate } = await import(require("url").pathToFileURL(path.join(envDir, "validate.mjs")).href);
  const schema = JSON.parse(fs.readFileSync(path.join(envDir, "pocket-agentic-envelope-v1.schema.json"), "utf8"));
  const st = await req("/v1/seller-trust", { url: "https://example.com/pay" });
  assert.strictEqual(st.status, 200);
  for (const [r, route] of [[dt, "/v1/domain-trust"], [bv, "/v1/brand-verify"], [st, "/v1/seller-trust"], [sc, "/v1/sanctions-check"], [ethRep, "/v1/reputation"], [eoa, "/v1/reputation"], [ethFallback, "/v1/reputation"], [contract, "/v1/reputation"], [pfClean, "/v1/preflight"], [pfListed, "/v1/preflight"], [pfName, "/v1/preflight"], [pfBpDown, "/v1/preflight"]]) {
    const v = r.body.verified;
    assert.ok(v, `${route}: verified missing`);
    assert.deepStrictEqual(validate(schema, v), [], `${route}: verified fails the schema`);
    assert.strictEqual(v.route, route);
    assert.strictEqual(v.service_version, "1.4.0");
    assert.ok(v.evidence.length >= 1, `${route}: evidence listed`);
  }
  assert.strictEqual(dt.body.verified.subject.id, "domain:dns:example.com");
  assert.strictEqual(dt.body.verified.assessment.score, dt.body.trust_score);
  assert.strictEqual(st.body.verified.assessment.label, st.body.recommendation);
  assert.strictEqual(sc.body.verified.assessment.status, "not_scored");
  assert.strictEqual(ethRep.body.verified.subject.id, "wallet:caip10:eip155:1:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  assert.strictEqual(ethRep.body.verified.evidence[0].publisher, "Blockscout");
  assert.strictEqual(eoa.body.verified.subject.id, "wallet:caip10:eip155:8453:0x1" + "a".repeat(39));
  assert.strictEqual(eoa.body.verified.assessment.coverage_pct, 60);
  assert.ok(eoa.body.verified.evidence.some((e) => e.source_ref === "ens:alice.eth"));
  assert.ok(contract.body.verified.evidence.some((e) => e.publisher === "Sourcify"));
  assert.strictEqual(eoa.body.verified.gaps[0].field, "explorer_signals");
  assert.strictEqual(ethFallback.body.verified.evidence[0].publisher, "Pocket Network public RPC");
  assert.strictEqual(badDomain.body.verified, undefined, "errors carry no verified block");
  assert.strictEqual(pfClean.body.verified.subject.id, "domain:dns:example.com");
  assert.strictEqual(pfClean.body.verified.assessment.label, "pass");
  assert.strictEqual(pfListed.body.verified.subject.id, "wallet:caip10:eip155:8453:0x252a8bd2319d8a555b872990601221b3a2053bce");
  assert.ok(pfListed.body.verified.evidence.some((e) => e.source_ref === "ofac-sdn"));
  assert.ok(pfListed.body.verified.gaps.some((g) => g.field === "sanctions_address_scope"));
  assert.strictEqual(pfBpDown.body.verified.assessment.status, "insufficient_data");

  // 1.3.0: Keccak-256 and ENS namehash against published vectors.
  const { keccak256, namehash } = require("../lib/keccak");
  assert.strictEqual(keccak256("").toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.strictEqual(namehash("foo.eth").toString("hex"), "de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f");
  assert.strictEqual(keccak256("addr(bytes32)").toString("hex").slice(0, 8), "3b3b57de");

  console.log("smoke: all assertions passed");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
