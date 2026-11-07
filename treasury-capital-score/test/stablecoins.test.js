// Stablecoin exposure tcs6-stablecoin-exposure/1.0 (owner 2026-10-31): evidence only, no score effect.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-stablecoins-test-"));

const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const SC = require("../lib/stablecoins");

const GDIR = path.join(__dirname, "fixtures", "golden");
const golden = JSON.parse(fs.readFileSync(path.join(GDIR, fs.readdirSync(GDIR).sort()[0]), "utf8"));
const VALID = { status: "valid", detail: "signature verified (test)" };
const plain = golden.input.bundle;
const T0 = plain.holdings[0];
const SAFE = "0x00000000000000000000000000000000000000a1";
const tok = (n) => `0x${String(n).padStart(40, "0")}`;

function h(token, symbol, usd, price = 1, extra = {}) {
  return { asset_id: `ethereum:${tok(token)}:${SAFE}`, symbol, chain: "ethereum", address: SAFE, asset_class: "fiat_stablecoin", control: "verified",
    quantity: usd / price, holdings_observed_at: T0.holdings_observed_at, prices: [{ source_ref: T0.prices[0].source_ref, usd: price, observed_at: T0.prices[0].observed_at }],
    haircut_flags: [], ...extra };
}
// the fixture's own stablecoins are left out so each test sees only the holdings it adds
const bundleWith = (holdings) => ({ ...plain, holdings: [...plain.holdings.filter((x) => x.asset_class !== "fiat_stablecoin"), ...holdings] });
const report = (bundle, verdict = VALID) => {
  const base = S.computeBase(bundle);
  return buildReport(golden.input.entity, bundle, base, [base.nrt], { attestation: verdict });
};

test("stablecoins tracked on Ethereum only say so", () => {
  for (const sym of ["USDS", "DAI", "GHO"]) assert.match(SC.POLICY.underlyings[sym].pmic_crypto_note, /Ethereum token contract only/);
  assert.equal(SC.POLICY.underlyings.USDC.pmic_crypto_note, undefined);
  const r = report(bundleWith([h(1, "GHO", 500000), h(2, "USDC", 500000)]));
  assert.deepEqual(validateReport(r).errors, []);
  const list = r.stablecoin_exposure.stablecoins;
  assert.match(list.find((u) => u.stablecoin === "GHO").pmic_crypto_note, /Ethereum token contract only/);
  assert.equal(list.find((u) => u.stablecoin === "USDC").pmic_crypto_note, undefined);
});

test("wrappers resolve to the stablecoin they hold", () => {
  const cases = { USDC: "USDC", aEthLidoGHO: "GHO", AUSDT: "USDT", aPlaUSDT0: "USDT", aArbUSDCn: "USDC", aGnoUSDCe: "USDC", aHorRwaRLUSD: "RLUSD",
    aEthsUSDe: "USDE", SDAI: "DAI", SUSDS: "USDS", sDOLA: "DOLA", cUSDCv3: "USDC", ciUSDCv3: "USDC", yvUSD: "USDC", "yvcrvUSD-2": "CRVUSD",
    KPK_USDC_V2: "USDC", ATUSD: "TUSD", AGUSD: "GUSD", aUSDP: "USDP", aAmmUSDC: "USDC", aBasUSDbC: "USDC", aArbLUSD: "LUSD", aArbFRAX: "FRAX" };
  for (const [sym, want] of Object.entries(cases)) assert.equal((SC.resolve(sym) || {}).underlying, want, sym);
  assert.equal(SC.resolve("USDC").wrapped, false);
  assert.equal(SC.resolve("aEthLidoGHO").wrapped, true);
  assert.equal(SC.resolve("alUSD"), null, "an ambiguous symbol is not guessed");
  assert.deepEqual(SC.resolve("ALUSD", undefined, "ethereum:0xBC6DA0FE9AD5F3B0D58160288917AA56653660E9"), { underlying: "ALUSD", wrapped: false });
  assert.deepEqual(SC.resolve("ALUSD", undefined, "ethereum:0x3fe6a295459fae07df8a0cecc36f37160fe86aa9"), { underlying: "LUSD", wrapped: true });
  assert.equal(SC.resolve("FOOUSD"), null, "an unknown token is not guessed");
  assert.equal(SC.resolve("WETH"), null);
});

test("groups by underlying, flags freezable issuers, checks the peg on plain holdings only, and reports pmic-crypto coverage", () => {
  const b = bundleWith([h(1, "USDS", 6000000), h(2, "SUSDS", 1000000, 1.12), h(3, "aEthUSDC", 2000000), h(4, "USDT", 1000000, 0.99), h(5, "alUSD", 50000)]);
  const s = report(b).stablecoin_exposure;
  assert.equal(s.policy_id, "tcs6-stablecoin-exposure/1.0");
  assert.deepEqual(s.stablecoins.map((u) => [u.stablecoin, Math.round(u.value_usd)]), [["USDS", 7000000], ["USDC", 2000000], ["USDT", 1000000]]);
  const usds = s.stablecoins[0];
  assert.deepEqual([Math.round(usds.plain_usd), Math.round(usds.wrapped_usd), usds.freezable], [6000000, 1000000, false]);
  assert.equal(s.stablecoins.find((u) => u.stablecoin === "USDC").freezable, true);
  assert.equal(Math.round(s.freezable_usd), 3000000);
  assert.deepEqual(s.off_peg.map((o) => [o.symbol, o.deviation_pct]), [["USDT", -1]], "sUSDS at $1.12 is a yield wrapper, not a depeg");
  assert.deepEqual(s.unmapped.map((u) => u.symbol), ["alUSD"]);
  assert.equal(s.pmic_crypto_coverage, Math.round((10000000 / 10050000) * 1e4) / 1e4, "USDS, USDC and USDT are tracked; alUSD is not");
  assert.match(s.statement, /the largest is USDS \(Sky\)/);
  assert.match(s.statement, /Evidence only: no effect on the score/);
  assert.ok(validateReport(report(b)).ok, validateReport(report(b)).errors.join("\n"));
});

test("evidence only: the score and every dimension are unchanged", () => {
  const b = bundleWith([h(1, "USDC", 5000000)]);
  const withIt = report(b);
  const without = report(b, { status: "missing", detail: "-" });
  assert.ok(withIt.stablecoin_exposure);
  assert.equal(without.stablecoin_exposure, undefined);
  assert.deepEqual(withIt.overall_score, without.overall_score);
  assert.deepEqual(withIt.dimensions.map((d) => d.score), without.dimensions.map((d) => d.score));
});

test("golden fixtures (unsigned) carry no stablecoin section", () => {
  assert.equal(report(plain, { status: "missing", detail: "-" }).stablecoin_exposure, undefined);
});
