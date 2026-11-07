"use strict";
// Treasury Availability (1.6.0). Synthetic snapshots only. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "availability-test-"));
process.env.DOSSIER_TCS6_DATA_DIR = path.join(ROOT, "tcs6");
process.env.DOSSIER_DATA_DIR = path.join(ROOT, "own");
const store = require("../lib/store");
const Av = require("../lib/availability");

const AS_OF = "2026-10-25T12:00:00Z";
const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const SAFE1 = A(1), SAFE2 = A(2);
const [T_AWETH, T_AUSDC, T_AWST, T_ATOK, T_AFRAX] = [A("a"), A("b"), A("c"), A("d"), A("e")];
const price = (usd) => [{ source_ref: "CG", usd, observed_at: AS_OF }];
const hold = (o) => ({ bucket: "onchain", control: "verified", holdings_observed_at: AS_OF, haircut_flags: [], chain: "ethereum", ...o });
const LOAN = [{ obligation_id: "GHO-DEBT", what: "Safe GHO borrow", usd: 1000000 }];

function bundle(over = {}) {
  return {
    entity_id: "demo", collected_at: AS_OF,
    holdings: [
      hold({ asset_id: "eth:usdc", symbol: "USDC", address: SAFE1, asset_class: "fiat_stablecoin", quantity: 1000000, prices: price(1) }),
      hold({ asset_id: "eth:tok", symbol: "TOK", address: SAFE2, asset_class: "native_token", quantity: 500000, prices: price(2), haircut_flags: ["lockup"] }),
      hold({ asset_id: `ethereum:${T_ATOK}:${SAFE1}`, symbol: "ATOK", address: SAFE1, asset_class: "lp_position", quantity: 100000, prices: price(2), haircut_flags: ["lending_receipt"] }),
      hold({ asset_id: `ethereum:${T_AWETH}:${SAFE1}`, symbol: "AWETH", address: SAFE1, asset_class: "lp_position", quantity: 100, prices: price(3000), haircut_flags: ["lending_receipt"] }),
      hold({ asset_id: `ethereum:${T_AUSDC}:${SAFE2}`, symbol: "AUSDC", address: SAFE2, asset_class: "lp_position", quantity: 400000, prices: price(1), haircut_flags: ["lending_receipt"] }),
      hold({ asset_id: `ethereum:${T_AWST}:${SAFE2}`, symbol: "AWSTETH", address: SAFE2, asset_class: "lp_position", quantity: 50, prices: price(4000), haircut_flags: ["lending_receipt"] }),
      hold({ asset_id: `ethereum:${T_AFRAX}:${SAFE2}`, symbol: "AFRAX", address: SAFE2, asset_class: "lp_position", quantity: 150000, prices: price(1), haircut_flags: ["lending_receipt", "redemption_limits"] }),
      hold({ asset_id: "eth:lp", symbol: "TOK/WETH", address: SAFE1, asset_class: "lp_position", quantity: 1, prices: price(50000) }),
      hold({ asset_id: "eth:weth", symbol: "WETH", address: A(7), asset_class: "major_crypto", control: "unverified", quantity: 10, prices: price(3000) }),
    ],
    attestation: { payload: { checks: [
      { field: `exit.available:ethereum:${T_AWETH}:${SAFE1}`, label: "AWETH at treasury_safe", source: "sim:aave", status: "passed", observed_at: AS_OF, block_number: 9, our_value: { usd: 300000 }, measure: { exitable_ratio: 1 }, evidence_hash: "sha256:aa" },
      { field: `exit.simulated:ethereum:${T_AWETH}:${SAFE1}`, source: "sim:aave:eth_call", status: "failed", observed_at: AS_OF, block_number: 9,
        measure: { method: "withdraw(address,uint256,address)", revert_reason: "HealthFactorLowerThanLiquidationThreshold()", cause: "backs_a_loan", backs_loans: LOAN } },
      { field: `exit.available:ethereum:${T_AUSDC}:${SAFE2}`, label: "AUSDC at ops_safe", source: "sim:aave", status: "failed", observed_at: AS_OF, block_number: 9, our_value: { usd: 400000 }, measure: { exitable_ratio: 0.25 }, evidence_hash: "sha256:bb" },
      { field: `exit.available:ethereum:${T_AWST}:${SAFE2}`, label: "AWSTETH at ops_safe", source: "sim:aave", status: "unavailable", observed_at: AS_OF, our_value: { usd: 200000 }, measure: null },
    ] } },
    governance: { reconciliation: { reported_total_usd: 3000000, reported_as_of: "2026-10-20", observed_usd_same_scope: 2900000, scope_status: "comparable", source_refs: ["OWN"] } },
    gaps: [{ field: "holdings.prices", reason: "3 token position(s) had no price (XYZ, ABC, DEF)." }],
    ...over,
  };
}

function report(b) {
  return {
    report_id: "tcs6_demo-1", as_of: b.collected_at, entity: { entity_id: "demo", name: "Demo DAO" }, overall_score: { score: 55, status: "provisional" },
    attestation: { verification_status: "valid", verification_detail: "signature verified with key tcs6-attest-test", payload: { attestation_id: "att-1", evidence_manifest_hash: "sha256:00" } },
    disclaimer: "Research, not investment advice.",
  };
}

let seq = 0;
function fresh(over) {
  const id = `demo-${++seq}`;
  const b = bundle(over);
  for (const d of ["reports", "evidence"]) fs.mkdirSync(path.join(store.TCS6_DIR, d), { recursive: true });
  fs.writeFileSync(path.join(store.TCS6_DIR, "reports", `${id}.json`), JSON.stringify(report(b)));
  fs.writeFileSync(path.join(store.TCS6_DIR, "evidence", `${id}.json`), JSON.stringify(b));
  return id;
}

const byBucket = (r) => Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, v.usd]));

test("each position lands in exactly one bucket and the buckets add up to the observed total", () => {
  const r = Av.availability({ entity_id: fresh() });
  assert.deepStrictEqual(byBucket(r), {
    available_now: 1150000, // USDC 1,000,000 held directly + 25% of aUSDC 400,000 + TOK/WETH pool 50,000
    own_token: 1200000, // TOK 1,000,000 (locked, but own token comes first) + aTOK 200,000
    encumbered: 300000, // aWETH, collateral, counted in full
    restricted: 150000, // aFRAX, redemption limits
    illiquid_now: 300000, // 75% of aUSDC
    unresolved: 230000, // aWstETH check unavailable 200,000 + WETH with unverified control 30,000
  });
  const sum = Object.values(byBucket(r)).reduce((s, x) => s + x, 0);
  assert.strictEqual(r.summary.observed_usd, 3330000);
  assert.strictEqual(Math.round(sum), r.summary.observed_usd);
  assert.strictEqual(r.summary.available_share_pct, 34.53);
  assert.strictEqual(r.summary.available_in_own_token_pools_usd, 50000);
  assert.strictEqual(r.summary.available_confirmed_by_exit_check_usd, 100000);
  assert.match(r.summary.statement, /^Of \$3,330,000 verified on chain, \$1,150,000 \(34\.53%\) could be used now\.$/);
  assert.strictEqual(r.method, "tcs6-availability/1.0");
  assert.deepStrictEqual(r.cost, { calls: 1, price_per_call_usd: 0.005, total_usd: 0.005, basis: "agent.pocket.network flat price per call",
    deeper: "the full dossier (POST /v1/dossier/plan) shows every position, check and source, in up to 7 calls" });
});

test("own token is found in any wrapper; collateral names its loan; a failed check splits into available and illiquid", () => {
  const r = Av.availability({ entity_id: fresh() });
  assert.deepStrictEqual(r.buckets.own_token.positions.map((p) => p.symbol).sort(), ["ATOK", "TOK"]);
  const enc = r.buckets.encumbered.positions[0];
  assert.deepStrictEqual([enc.symbol, enc.backs_loans, enc.evidence_hash], ["AWETH", LOAN, "sha256:aa"]);
  const ausdc = (b) => r.buckets[b].positions.find((p) => p.symbol === "AUSDC");
  assert.deepStrictEqual([ausdc("available_now").value_usd, ausdc("available_now").confirmed_by_check], [100000, true]);
  assert.match(ausdc("illiquid_now").reason, /cash for only 25%/);
  assert.match(r.buckets.unresolved.positions.find((p) => p.symbol === "AWSTETH").reason, /could not be read/);
  assert.match(r.buckets.unresolved.positions.find((p) => p.symbol === "WETH").reason, /not verified/);
  assert.match(r.buckets.restricted.positions[0].reason, /redemption_limits/);
  const lp = r.buckets.available_now.positions.find((p) => p.symbol === "TOK/WETH");
  assert.deepStrictEqual([lp.own_token_pool, lp.note], [true, "its name suggests a pool or vault that includes the protocol's own token"]);
  assert.match(lp.reason, /^pool, vault or lending position not exit-checked/);
  assert.match(r.buckets.available_now.positions.find((p) => p.symbol === "USDC").reason, /^held directly; not exit-checked$/);
});

test("reported total: cited and recent is shown; older than 90 days or absent is null with the reason", () => {
  assert.deepStrictEqual([Av.availability({ entity_id: fresh() }).reported.usd, Av.availability({ entity_id: fresh() }).reported.age_days], [3000000, 5]);
  const stale = Av.availability({ entity_id: fresh({ governance: { reconciliation: { reported_total_usd: 9000000, reported_as_of: "2026-02-28", source_refs: ["OWN"] } } }) });
  assert.strictEqual(stale.reported.usd, null);
  assert.strictEqual(stale.reported.stale_usd, 9000000);
  assert.match(stale.reported.reason, /239 days old, over the 90-day limit/);
  assert.strictEqual(stale.summary.reported_usd, null);
  const none = Av.availability({ entity_id: fresh({ governance: {} }) });
  assert.deepStrictEqual([none.reported.usd, none.reported.reason], [null, "the protocol publishes no treasury total we can compare"]);
  const eth = Av.availability({ entity_id: fresh({ governance: { reconciliation: { reported_quantity: 100, unit: "ETH", reported_as_of: "2026-10-20" } } }) });
  assert.match(eth.reported.reason, /in ETH, not USD/);
});

test("unpriced tokens are listed, never guessed; long bucket lists are capped with the rest summed", () => {
  const r = Av.availability({ entity_id: fresh() });
  assert.deepStrictEqual(r.not_valued, ["3 token position(s) had no price (XYZ, ABC, DEF)."]);
  const many = Array.from({ length: 30 }, (_, i) => hold({ asset_id: `eth:s${i}`, symbol: `S${i}`, address: SAFE1, asset_class: "fiat_stablecoin", quantity: 1000 + i, prices: price(1) }));
  const big = Av.availability({ entity_id: fresh({ holdings: many, attestation: { payload: { checks: [] } } }) });
  const b = big.buckets.available_now;
  assert.deepStrictEqual([b.positions_total, b.positions.length, b.other_positions.count], [30, 25, 5]);
  assert.strictEqual(b.other_positions.usd, 1000 + 1001 + 1002 + 1003 + 1004);
  assert.strictEqual(big.summary.available_share_pct, 100);
});

test("bad input is a 400 with a hint, never a 5xx", () => {
  const code = (body) => { try { Av.availability(body); } catch (e) { return [e.status, e.code]; } return null; };
  assert.deepStrictEqual(code({}), [400, "invalid_input"]);
  assert.deepStrictEqual(code({ entity_id: "Not Valid!" }), [400, "invalid_input"]);
  assert.deepStrictEqual(code({ entity_id: "nobody" }), [400, "unknown_entity"]);
});
