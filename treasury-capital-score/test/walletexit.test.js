// Wallet exit tcs6-wallet-exit/1.0 (owner 2026-10-30): one-hour extractable value from signed control and borrow paths.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-walletexit-test-"));

const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const WX = require("../lib/walletexit");

const GDIR = path.join(__dirname, "fixtures", "golden");
const golden = JSON.parse(fs.readFileSync(path.join(GDIR, fs.readdirSync(GDIR).sort()[0]), "utf8"));
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attestation_vector.json"), "utf8"));
const VALID = { status: "valid", detail: "signature verified (test)" };
const plain = golden.input.bundle;
const T0 = plain.holdings[0];

const SAFE = "0x00000000000000000000000000000000000000a1";
const TIMELOCK = "0x00000000000000000000000000000000000000a2";
const UNKNOWN = "0x00000000000000000000000000000000000000a3";
const tok = (n) => `0x${String(n).padStart(40, "0")}`;
function h(holder, token, symbol, usd, extra = {}) {
  return { asset_id: `ethereum:${tok(token)}:${holder}`, symbol, chain: "ethereum", address: holder, asset_class: "major_crypto", control: "verified",
    quantity: usd, holdings_observed_at: T0.holdings_observed_at, prices: [{ source_ref: T0.prices[0].source_ref, usd: 1, observed_at: T0.prices[0].observed_at }],
    haircut_flags: [], ...extra };
}
const control = (wallet, protectedValue, extra = {}) => ({ field: `control.path:ethereum:${wallet}`, status: protectedValue === null ? "unavailable" : "passed",
  measure: protectedValue === null ? { reason: "unresolved" } : { type: protectedValue ? "timelock" : "safe", protected: protectedValue, ...extra } });
const borrowRow = (wallet, assets, headroom = 0, cashUsd = 4000000) => ({ field: `exit.borrow:ethereum:${wallet}`, status: "passed",
  measure: { markets: { aave: { weth_cash_usd: cashUsd } }, aave_headroom_usd: headroom, assets } });
function bundleWith(holdings, checks) {
  const env = JSON.parse(JSON.stringify(VEC.envelope));
  env.payload.checks = [...env.payload.checks.filter((c) => !/^(exit|control)\./.test(c.field || "")), ...checks.map((c, i) => ({ ...env.payload.checks[0], check_id: `x${i}|${c.field}|t`, ...c }))];
  env.payload.review_items = { conflicted_check_ids: [], conflicted_checks: [], failed_check_ids: [], failed_checks: [], unavailable_check_ids: [], unavailable_checks: [] };
  return { ...plain, holdings: [...plain.holdings, ...holdings], attestation: env };
}
function report(bundle, verdict = VALID) {
  const base = S.computeBase(bundle);
  return buildReport(golden.input.entity, bundle, base, [base.nrt], { attestation: verdict });
}
const d6 = (r) => r.dimensions.find((d) => d.id === "D6");

test("policy file carries the approved numbers", () => {
  const p = WX.POLICY;
  assert.equal(p.policy_id, "tcs6-wallet-exit/1.0");
  assert.equal(p.delay_standard_hours, 48);
  assert.match(p.delay_standard_source, /MINIMUM_DELAY = 2 days/);
  assert.deepEqual(p.bands.map((b) => [b.max_share, b.d6_cap]), [[0.1, null], [0.25, 75], [0.5, 50], [null, 25]]);
  assert.deepEqual([WX.capFor(0.1), WX.capFor(0.1001), WX.capFor(0.25), WX.capFor(0.5), WX.capFor(0.51)], [null, 75, 75, 50, 25]);
  assert.ok(p.incidents.every((i) => i.name && /^[A-Z][a-z]+ \d{4}$/.test(i.month)), "incidents named with month and year");
});

test("freezable: issuer stablecoins and their lending receipts", () => {
  assert.deepEqual(["USDC", "aEthUSDC", "aPlaUSDT0", "RLUSD", "USD1", "WETH", "AAVE", "GHO", "sUSDe"].map((s) => WX.isFreezable({ symbol: s })),
    [true, true, true, true, true, false, false, false, false]);
});

test("no signed control paths (older bundles, golden fixtures): no wallet exit, D6 unchanged", () => {
  const r = report(bundleWith([], []));
  const g = report(plain, { status: "missing", detail: "-" });
  assert.equal(r.wallet_exit, undefined);
  assert.equal(d6(r).score, d6(g).score);
});

test("an exposed Safe: liquid tokens leave directly; freezable stablecoins only through borrowing, capped by WETH cash", () => {
  const b = bundleWith([h(SAFE, 1, "WETH", 20000000), h(SAFE, 2, "USDC", 10000000, { asset_class: "fiat_stablecoin" })],
    [control(SAFE, false, { threshold: 3, signers: 5 }), borrowRow(SAFE, { [tok(2)]: { aave_ltv: 0.75 } }, 0, 4000000)]);
  const r = report(b);
  const w = r.wallet_exit;
  assert.equal(w.direct_usd, 20000000);
  assert.equal(w.freezable_usd, 10000000);
  assert.equal(w.borrow_usd, 4000000, "$7.5M borrowable against USDC, capped by the $4M of WETH the market holds");
  assert.equal(w.one_hour_exit_usd, 24000000);
  assert.equal(w.wallets.find((x) => x.address === SAFE).safe_threshold, "3-of-5");
  assert.ok(w.one_hour_exit_share > 0.1 && w.one_hour_exit_share <= 0.25);
  assert.equal(w.d6_cap, 75);
  assert.match(w.statement, /could leave within one hour: \$20,000,000 directly and \$4,000,000 by borrowing unfreezable WETH/);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("a wallet behind a >= 48 h timelock is protected; an unresolved control path counts as exposed and is flagged", () => {
  const b = bundleWith([h(TIMELOCK, 1, "UNI", 60000000), h(UNKNOWN, 3, "WETH", 5000000)], [control(TIMELOCK, true, { delay_hours: 48 }), control(UNKNOWN, null)]);
  const w = report(b).wallet_exit;
  assert.equal(w.protected_usd, 60000000);
  assert.equal(w.direct_usd, 5000000);
  assert.equal(w.unknown_control_wallets, 1);
  assert.match(w.statement, /1 wallet\(s\) have a control path that could not be resolved and are counted as exposed/);
});

test("a cited curated control path overrides an unresolved on-chain read", () => {
  const b = bundleWith([h(UNKNOWN, 3, "WETH", 5000000)], [{ ...control(UNKNOWN, null), status: "unavailable",
    measure: { reason: "x", curated: { protected: true, source_ref: "governance docs", delay_hours: 72 } } }]);
  const w = report(b).wallet_exit;
  const e = w.wallets.find((x) => x.address === UNKNOWN);
  assert.deepEqual([e.protected, e.protected_by, e.source_ref], [true, "curated", "governance docs"]);
  assert.equal(w.direct_usd, 0);
});

test("lent positions: the withdrawable share leaves directly, the rest is borrowed against up to the Aave headroom; locked never leaves", () => {
  const exitRow = { field: `exit.available:ethereum:${tok(4)}:${SAFE}`, status: "failed", measure: { exitable_ratio: 0.3 } };
  const b = bundleWith([h(SAFE, 4, "aEthWETH", 10000000), h(SAFE, 5, "veTOKEN", 3000000, { haircut_flags: ["lockup"] })],
    [control(SAFE, false), exitRow, borrowRow(SAFE, { [tok(4)]: { aave_ltv: 0.8 } }, 2000000)]);
  const w = report(b).wallet_exit;
  const e = w.wallets.find((x) => x.address === SAFE);
  assert.equal(e.direct_usd, 3000000);
  assert.equal(e.borrow_usd, 2000000, "$5.6M of collateral room, limited to the account's $2M headroom");
  assert.equal(e.locked_usd, 3000000);
});

test("the band caps D6 and the report says why", () => {
  const b = bundleWith([h(SAFE, 1, "WETH", 200000000)], [control(SAFE, false)]);
  const r = report(b);
  assert.equal(r.wallet_exit.d6_cap, 25);
  assert.ok(d6(r).score <= 25);
  const step = d6(r).primary_metrics.find((m) => m.name === "d6_rubric_step").value;
  const before = d6(report(bundleWith([h(SAFE, 1, "WETH", 200000000)], []))).score;
  if (before > 25) assert.match(step, /capped at 25 by wallet exit/);
  assert.match(d6(r).rationale, /Wallet exit: .* could leave within one hour/);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("only a valid attestation is used", () => {
  const b = bundleWith([h(SAFE, 1, "WETH", 200000000)], [control(SAFE, false)]);
  assert.equal(report(b, { status: "invalid", detail: "bad" }).wallet_exit, undefined);
});
