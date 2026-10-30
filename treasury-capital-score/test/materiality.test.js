// Materiality policy tcs6-materiality/1.2 (D18; 1.1 classification conflicts; 1.2 divergent scoring, owner 2026-10-30) on a valid attestation.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-materiality-test-"));

const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const M = require("../lib/materiality");

const GDIR = path.join(__dirname, "fixtures", "golden");
const golden = JSON.parse(fs.readFileSync(path.join(GDIR, fs.readdirSync(GDIR).sort()[0]), "utf8"));
const A1 = "0x0000000000000000000000000000000000000001"; // USDC + WETH
const A2 = "0x0000000000000000000000000000000000000002"; // native
const A4 = "0x0000000000000000000000000000000000000004";
const VALID = { status: "valid", detail: "signature verified (test)" };

function failed(contract, kind = "contract_identity_control", subject = "test_contract source") {
  return { check_id: `${kind}|control.source_verified:ethereum:${contract}|sourcify`, kind, subject, chain_id: 1, contract,
    source: "sourcify", result: "failed", failure_reason: "verification_absent", failure_detail: "-", materiality: "undetermined", review_required: true };
}
// The shared vector's envelope (schema-valid) with its review items replaced; verdicts are passed in directly.
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attestation_vector.json"), "utf8"));
function withAttestation(bundle, checks) {
  const env = JSON.parse(JSON.stringify(VEC.envelope));
  env.payload.review_items = { conflicted_check_ids: [], conflicted_checks: [], failed_check_ids: checks.map((c) => c.check_id), failed_checks: checks, unavailable_check_ids: [], unavailable_checks: [] };
  return { ...bundle, attestation: env };
}
function report(bundle, verdict = VALID) {
  const base = S.computeBase(bundle);
  return buildReport(golden.input.entity, bundle, base, [base.nrt], { attestation: verdict });
}
const plainBundle = golden.input.bundle;
const plain = report(plainBundle, { status: "missing", detail: "-" });

test("policy file carries the approved numbers", () => {
  const p = M.POLICY;
  assert.equal(p.policy_id, "tcs6-materiality/1.2");
  assert.deepEqual([p.value_threshold_usd, p.treasury_share_threshold, p.critical_core_share_threshold, p.confidence_cap, p.obligations_penalty_points, p.price_attestation_threshold, p.price_materiality_threshold],
    [100000, 0.02, 0.25, 59, 10, 0.02, 0.05]);
  assert.deepEqual(Object.entries(p.classes).filter(([, c]) => c.active).map(([k]) => k).sort(),
    ["classification_conflict", "contract_identity_control", "disclosure_reconciliation", "naming_control", "price_comparison", "realizability_control", "retrieval_control"]);
  assert.deepEqual([p.large_divergence.value_usd, p.large_divergence.treasury_share, p.large_divergence.position_share], [1000000, 0.1, 0.25]);
});

test("non-material: a failed contract with no counted value is disclosed, score unchanged", () => {
  const r = report(withAttestation(plainBundle, [failed("0x0000000000000000000000000000000000000003")]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.materiality, "non_material");
  assert.equal(a.position_value_usd, 0);
  assert.equal(r.attestation.materiality.effect, "disclose");
  assert.equal(r.overall_score.score, plain.overall_score.score);
  assert.equal(r.overall_score.status, plain.overall_score.status);
  assert.deepEqual(r.confidence, plain.confidence);
  assert.match(r.attestation.statement, /Materiality under policy tcs6-materiality\/1\.2: test_contract source contract_identity_control \(\$0 of \$[\d,]+, 0\.00%\): non_material; no score effect \(disclosed\)\./);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("critical: a failed contract holding >= 25% of counted value withholds the score", () => {
  const r = report(withAttestation(plainBundle, [failed(A2)]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.materiality, "critical");
  assert.ok(a.treasury_share >= 0.25);
  assert.equal(r.overall_score.score, null);
  assert.equal(r.overall_score.status, "insufficient_data");
  assert.equal(r.analysis_status, "insufficient_data");
  assert.ok(r.risks.some((x) => x.id === "material_contract_identity_control" && x.severity === "critical"));
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("material: > $100k and < 25% -> provisional, position out of verified value, confidence capped at 59", () => {
  const extra = { ...plainBundle.holdings[0], asset_id: "eth:usdc-a4", exposure_id: "usdc-a4", address: A4, prices: plainBundle.holdings[0].prices.map((x) => ({ ...x, usd: 1 })), quantity: 1000000 };
  const bundle = { ...plainBundle, holdings: [...plainBundle.holdings, extra] };
  const before = report(bundle, { status: "missing", detail: "-" });
  const r = report(withAttestation(bundle, [failed(A4)]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.materiality, "material");
  assert.equal(a.position_value_usd, 1000000);
  assert.equal(r.overall_score.status, "provisional");
  assert.equal(r.overall_score.decision_band, null);
  assert.ok(r.confidence.score <= 59);
  assert.ok(r.headline.gross_adjusted_treasury_usd < before.headline.gross_adjusted_treasury_usd, "excluded from verified value");
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("thresholds are strict: exactly $100,000 at <= 2% is not material", () => {
  const extra = { ...plainBundle.holdings[0], asset_id: "eth:usdc-a4", exposure_id: "usdc-a4", address: A4, prices: plainBundle.holdings[0].prices.map((x) => ({ ...x, usd: 1 })), quantity: 100000 };
  const bundle = { ...plainBundle, holdings: [...plainBundle.holdings, extra] };
  const r = report(withAttestation(bundle, [failed(A4)]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.position_value_usd, 100000);
  assert.ok(a.treasury_share <= 0.02);
  assert.equal(a.materiality, "non_material");
});

test("realizability is scored from the signed exit checks, not the review list; invalid attestations are not assessed", () => {
  const r = report(withAttestation(plainBundle, [failed(A2, "realizability_control", "native at A2")]));
  assert.equal(r.attestation.materiality, undefined, "a review item without a signed exit check measures nothing");
  assert.equal(r.overall_score.score, plain.overall_score.score);
  const bad = report(withAttestation(plainBundle, [failed(A2)]), { status: "invalid", detail: "bad signature" });
  assert.equal(bad.overall_score.score, plain.overall_score.score);
  assert.equal(bad.attestation.verification_status, "invalid");
  assert.equal(bad.attestation.materiality, undefined);
});

test("the chain must match: a failure on another chain at the same address is not this position (Morpho, Beta 2026-10-17)", () => {
  const onBase = { ...failed(A2), check_id: `contract_identity_control|control.source_verified:base:${A2}|sourcify` };
  const r = report(withAttestation(plainBundle, [onBase]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.position_value_usd, 0);
  assert.equal(a.materiality, "non_material");
  assert.equal(r.overall_score.score, plain.overall_score.score);
});

test("an address that can't be matched (no contract) stays undetermined", () => {
  const c = { ...failed(A1), contract: null };
  const r = report(withAttestation(plainBundle, [c]));
  assert.equal(r.attestation.materiality.assessments[0].materiality, "undetermined");
  assert.equal(r.overall_score.score, plain.overall_score.score);
});

// ---- 1.1: classification conflicts (owner 2026-10-29, the yETH-Recovery case) ----------------------------
const VAULT = "0x00000000000000000000000000000000000000aa";
const HOLDER = "0x00000000000000000000000000000000000000bb";
function restricted(qty, flags = ["redemption_limits", "pending_classification"]) {
  return { asset_id: `ethereum:${VAULT}:${HOLDER}`, symbol: "yRECOVERY", chain: "ethereum", address: HOLDER, asset_class: "liquid_alt",
    control: "verified", quantity: qty, holdings_observed_at: plainBundle.holdings[0].holdings_observed_at,
    prices: [{ source_ref: plainBundle.holdings[0].prices[0].source_ref, usd: 1, observed_at: plainBundle.holdings[0].prices[0].observed_at }],
    haircut_flags: flags, note: "Recovery vault shares; pending the governance decision YIP-90." };
}
function withExitCheck(bundle, status = "passed", prefix = "exit.available") {
  const env = JSON.parse(JSON.stringify(VEC.envelope));
  const field = `${prefix}:ethereum:${VAULT}:${HOLDER}`;
  const tmpl = env.payload.checks.find((c) => c.kind === "realizability_control");
  env.payload.checks = [...env.payload.checks, { ...tmpl, check_id: `realizability_control|${field}|sim:erc4626`, field, status,
    measure: { exitable_ratio: 1 }, other_value: { exitable_ratio: 1 } }];
  env.payload.review_items = { conflicted_check_ids: [], conflicted_checks: [], failed_check_ids: [], failed_checks: [], unavailable_check_ids: [], unavailable_checks: [] };
  return { ...bundle, attestation: env };
}
const withPosition = (qty, flags) => ({ ...plainBundle, holdings: [...plainBundle.holdings, restricted(qty, flags)] });

test("classification conflict, material: conservative exclusion, provisional, confidence capped, no penalty points", () => {
  const before = report(withPosition(3800000), { status: "missing", detail: "-" });
  const r = report(withExitCheck(withPosition(3800000)));
  const m = r.attestation.materiality;
  const a = m.assessments.find((x) => x.kind === "classification_conflict");
  assert.equal(m.effect, "provisional");
  assert.equal(m.review_required, true);
  assert.deepEqual([a.materiality, a.gross_observed_value_usd, a.verified_treasury_value_usd, a.liquid_value_usd], ["material", 3800000, 0, 0]);
  assert.deepEqual([a.onchain_withdrawal_check, a.classification_status, a.score_treatment, a.review_required, a.confidence],
    ["passed", "conflicted", "conservative_exclusion", true, "capped"]);
  assert.deepEqual(a.curated_classification, ["redemption_limits", "pending_classification"]);
  assert.match(a.statement, /observed on-chain value of approximately \$3,800,000\. The chain-level exit check indicates that the recorded position is currently withdrawable\./);
  assert.match(a.statement, /excluded from verified and liquid treasury value pending classification resolution\. The conservative score is retained, the report is marked provisional/);
  assert.match(a.resolution_event, /YIP-90/);
  assert.equal(r.overall_score.status, "provisional");
  assert.ok(r.confidence.score <= 59);
  assert.equal(r.overall_score.score, before.overall_score.score, "the position was already restricted: the score is retained");
  assert.ok(!(r.risks || []).some((x) => /^penalty_/.test(x.id) && !(before.risks || []).some((y) => y.id === x.id)), "no new penalty");
  assert.ok(r.risks.some((x) => x.id === "classification_conflict" && /YIP-90/.test(x.monitoring_action)));
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("classification conflict, non-material: disclosed with review required, no score or confidence effect", () => {
  const before = report(withPosition(50000), { status: "missing", detail: "-" });
  const r = report(withExitCheck(withPosition(50000)));
  const a = r.attestation.materiality.assessments.find((x) => x.kind === "classification_conflict");
  assert.deepEqual([a.materiality, a.score_treatment, a.review_required], ["non_material", "disclosed", true]);
  assert.equal(r.attestation.materiality.effect, "disclose");
  assert.equal(r.overall_score.score, before.overall_score.score);
  assert.deepEqual(r.confidence, before.confidence);
});

test("no conflict when the exit check did not pass, the position is not restricted (a legal earmark is not a trigger), or the attestation is not valid", () => {
  for (const [b, v] of [[withExitCheck(withPosition(3800000), "failed"), VALID], [withExitCheck(withPosition(3800000, ["thin_depth"])), VALID], [withExitCheck(withPosition(3800000, ["legal_restriction"])), VALID],
    [withExitCheck(withPosition(3800000)), { status: "invalid", detail: "-" }]]) {
    const m = report(b, v).attestation && report(b, v).attestation.materiality;
    assert.ok(!m || !m.assessments.some((x) => x.kind === "classification_conflict"));
  }
  const sim = report(withExitCheck(withPosition(3800000), "passed", "exit.simulated")).attestation.materiality;
  assert.ok(sim.assessments.some((x) => x.kind === "classification_conflict"), "a passed withdrawal simulation (v2a) counts too");
});

// ---- 1.2: divergent scoring (owner 2026-10-30) -------------------------------------------------------------
const POOL_TOKEN = "0x00000000000000000000000000000000000000cc";
const SAFE = "0x00000000000000000000000000000000000000dd";
function lent(qty, sym = "aUSDC", token = POOL_TOKEN, holder = SAFE) {
  return { asset_id: `ethereum:${token}:${holder}`, symbol: sym, chain: "ethereum", address: holder, asset_class: "fiat_stablecoin",
    control: "verified", quantity: qty, holdings_observed_at: plainBundle.holdings[0].holdings_observed_at,
    prices: [{ source_ref: plainBundle.holdings[0].prices[0].source_ref, usd: 1, observed_at: plainBundle.holdings[0].prices[0].observed_at }], haircut_flags: [] };
}
// Signed exit checks for a position: `available` (exitable ratio) and/or `simulated` (measure as given).
function exits(bundle, list, extra = []) {
  const env = JSON.parse(JSON.stringify(VEC.envelope));
  const tmpl = env.payload.checks.find((c) => c.kind === "realizability_control");
  const mk = (prefix, token, holder, measure) => {
    const field = `${prefix}:ethereum:${token}:${holder}`;
    return { ...tmpl, check_id: `realizability_control|${field}|sim:aave`, field, status: "failed", measure, other_value: measure,
      evidence_hash: `sha256:${prefix.length}${token.slice(-2)}` };
  };
  env.payload.checks = [...env.payload.checks.filter((c) => c.kind !== "realizability_control" && c.kind !== "price_comparison"),
    ...list.map((x) => mk(x.prefix || "exit.available", x.token || POOL_TOKEN, x.holder || SAFE, x.measure)), ...extra];
  env.payload.review_items = { conflicted_check_ids: [], conflicted_checks: [], failed_check_ids: [], failed_checks: [], unavailable_check_ids: [], unavailable_checks: [] };
  return { ...bundle, attestation: env };
}
const lentBundle = (qty, more = []) => ({ ...plainBundle, holdings: [...plainBundle.holdings, lent(qty), ...more] });
const hqla = (r) => r.dimensions.find((d) => d.id === "D2").primary_metrics.find((m) => m.name === "tier_0_to_1_hqla_usd").value;
const divergence = (r, kind = "realizability_control") => r.attestation.materiality.assessments.find((a) => a.kind === kind);

test("partial withdrawal, material: liquid capital counts the measured share, the rest is reported, provisional and capped", () => {
  const before = report(lentBundle(2000000), { status: "missing", detail: "-" });
  const r = report(exits(lentBundle(2000000), [{ measure: { exitable_ratio: 0.296 } }]));
  const a = divergence(r);
  assert.deepEqual([a.treatment, a.materiality, a.failure_reason, a.withdrawable_fraction], ["evidence_based_discount", "material", "insufficient_liquidity", 0.296]);
  assert.deepEqual([a.gross_observed_value_usd, a.available_value_usd, a.unavailable_value_usd, a.unavailable_as], [2000000, 592000, 1408000, "illiquid"]);
  assert.equal(a.large_divergence, true, "$1.408M unavailable > $1M");
  assert.equal(r.attestation.materiality.review_required, true);
  assert.equal(r.headline.gross_adjusted_treasury_usd, before.headline.gross_adjusted_treasury_usd, "gross value unchanged");
  const drop = hqla(before) - hqla(r);
  const kept = 1 - S.haircutPct(lent(1)) / 100; // the D2 metric is post-haircut
  assert.ok(Math.abs(drop - 1408000 * kept) < 1, `D2 drops by the unavailable part after the haircut (${drop})`);
  assert.equal(r.overall_score.status, "provisional");
  assert.ok(r.confidence.score <= 59);
  assert.deepEqual(a.evidence_hashes, ["sha256:14cc"]);
  assert.match(a.statement, /holds 29\.6% of the position in withdrawable cash\. Liquid capital counts \$592,000 of it; \$1,408,000 is reported as illiquid, not deleted\./);
  assert.ok(r.risks.some((x) => x.id === "material_realizability_control" && x.severity === "critical"));
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("partial withdrawal: materiality on the gross position, large divergence on the unavailable part", () => {
  const r = report(exits(lentBundle(204000), [{ measure: { exitable_ratio: 0.74 } }]));
  const a = divergence(r);
  assert.deepEqual([a.materiality, a.treatment, a.large_divergence], ["material", "evidence_based_discount", false], "$204k gross is material; $53k unavailable is not large");
  assert.equal(r.overall_score.status, "provisional");
  assert.equal(r.attestation.materiality.review_required, undefined);
});

test("non-material divergence: flag only, no discount, no status or confidence effect", () => {
  const before = report(lentBundle(90000), { status: "missing", detail: "-" });
  const r = report(exits(lentBundle(90000), [{ measure: { exitable_ratio: 0.1 } }]));
  const a = divergence(r);
  assert.deepEqual([a.treatment, a.materiality, a.score_effect], ["flag_only", "non_material", "none (flag only)"]);
  assert.equal(r.attestation.materiality.effect, "disclose");
  assert.equal(hqla(r), hqla(before));
  assert.deepEqual([r.overall_score.score, r.overall_score.status], [before.overall_score.score, before.overall_score.status]);
  assert.deepEqual(r.confidence, before.confidence);
});

test("redemptions disabled: nothing counts as liquid now; the gross value stays", () => {
  const r = report(exits(lentBundle(500000), [{ prefix: "exit.simulated", measure: { cause: "redemptions_disabled", recoverable_ratio: null } }]));
  const a = divergence(r);
  assert.deepEqual([a.withdrawable_fraction, a.available_value_usd, a.unavailable_value_usd, a.unavailable_as], [0, 0, 500000, "restricted"]);
});

test("collateral backing a loan: the measured need is encumbered, the debt is not subtracted twice", () => {
  const health = { debt_usd: 4478943, liquidation_threshold: 0.83, encumbered_usd: 5396317, block_number: 26296602 };
  const bundle = lentBundle(23000000);
  const before = report(bundle, { status: "missing", detail: "-" });
  const r = report(exits(bundle, [{ prefix: "exit.simulated", measure: { cause: "backs_a_loan", recoverable_ratio: null, loan_health: health } }]));
  const a = divergence(r);
  assert.equal(a.unavailable_as, "encumbered");
  assert.equal(a.unavailable_value_usd, 5396317);
  assert.equal(a.available_value_usd, 23000000 - 5396317);
  assert.deepEqual(a.loan_health, health);
  assert.match(a.statement, /\$5,396,317 of it keeps the loan at a health factor of 1 \(debt \$4,478,943 \/ liquidation threshold 83%, read on chain at block 26296602\)/);
  assert.equal(r.headline.obligations_usd, before.headline.obligations_usd, "the loan stays one obligation");
  assert.equal(r.headline.gross_adjusted_treasury_usd, before.headline.gross_adjusted_treasury_usd);
  const unmeasured = divergence(report(exits(bundle, [{ prefix: "exit.simulated", measure: { cause: "backs_a_loan", recoverable_ratio: null } }])));
  assert.deepEqual([unmeasured.withdrawable_fraction, unmeasured.unavailable_value_usd], [0, 23000000]);
  assert.match(unmeasured.statement, /collateral need was not measured, so the whole position is treated as encumbered/);
});

test("collateral: one loan's need is spread over the borrower's reverting positions, largest first", () => {
  const T2 = "0x00000000000000000000000000000000000000ce";
  const health = { debt_usd: 1000000, liquidation_threshold: 0.8, encumbered_usd: 1250000, block_number: 1 };
  const bundle = { ...plainBundle, holdings: [...plainBundle.holdings, lent(1000000), lent(500000, "aDAI", T2)] };
  const sim = { prefix: "exit.simulated", measure: { cause: "backs_a_loan", recoverable_ratio: null, loan_health: health } };
  const r = report(exits(bundle, [sim, { ...sim, token: T2 }]));
  const [big, small] = ["aUSDC", "aDAI"].map((s) => r.attestation.materiality.assessments.find((x) => x.subject.startsWith(s)));
  assert.deepEqual([big.unavailable_value_usd, small.unavailable_value_usd], [1000000, 250000]);
});

test("an unexplained revert: no measurable basis, so no discount; capped, and the whole position counts as unverified", () => {
  const before = report(lentBundle(2000000), { status: "missing", detail: "-" });
  const r = report(exits(lentBundle(2000000), [{ prefix: "exit.simulated", measure: { cause: "unexplained", recoverable_ratio: null } }]));
  const a = divergence(r);
  assert.deepEqual([a.treatment, a.withdrawable_fraction, a.available_value_usd, a.unavailable_value_usd, a.large_divergence], ["confidence_cap", null, null, 2000000, true]);
  assert.equal(hqla(r), hqla(before));
  assert.equal(r.overall_score.status, "provisional");
});

test("a measured divergence on a >= 25% position stays provisional with review, never withheld (owner 2026-10-30)", () => {
  const r = report(exits(lentBundle(60000000), [{ measure: { exitable_ratio: 0.5 } }]));
  const a = divergence(r);
  assert.equal(a.materiality, "critical");
  assert.equal(r.overall_score.status, "provisional");
  assert.notEqual(r.overall_score.score, null);
  assert.equal(a.review_required, true);
});

test("reconciliation gap: the observed value is kept; material -> provisional and capped; large -> review", () => {
  const recon = (observed, reported) => ({ ...VEC.envelope.payload.checks[0], check_id: "disclosure_reconciliation|treasury.reconciled_usd|report", kind: "disclosure_reconciliation",
    field: "treasury.reconciled_usd", label: "reported vs observed treasury total", status: "conflicted", our_value: observed, other_value: { as_of: "2026-09-30", usd: reported }, evidence_hash: "sha256:rec" });
  const r = report(exits(plainBundle, [], [recon(21874407.1, 26940000)]));
  const a = divergence(r, "disclosure_reconciliation");
  assert.deepEqual([a.gap_usd, a.materiality, a.treatment, a.large_divergence], [5065592.9, "material", "confidence_cap", true]);
  assert.match(a.statement, /reported \$26,940,000 as of 2026-09-30; we observe \$21,874,407 for the same scope, a gap of \$5,065,593\. The observed value is kept\./);
  assert.equal(r.overall_score.status, "provisional");
  assert.ok(r.confidence.score <= 59);
  const small = divergence(report(exits(plainBundle, [], [recon(1000000, 1050000)])), "disclosure_reconciliation");
  assert.deepEqual([small.materiality, small.treatment], ["non_material", "flag_only"]);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("price spread: <= 5% flag only; > 5% on a material position provisional and capped; the lower reading is used and both are kept", () => {
  const priced = (hi) => ({ ...lent(2000000, "aUSDT"), prices: [{ ...lent(1).prices[0], usd: 1 }, { ...lent(1).prices[0], source_ref: "CMC", usd: hi }] });
  const flag = divergence(report(exits({ ...plainBundle, holdings: [...plainBundle.holdings, priced(1.03)] }, [])), "price_comparison");
  assert.deepEqual([flag.treatment, flag.failure_reason, flag.price_spread_pct], ["flag_only", "price_spread_2_to_5pct", 3]);
  const r = report(exits({ ...plainBundle, holdings: [...plainBundle.holdings, priced(1.08)] }, []));
  const a = divergence(r, "price_comparison");
  assert.deepEqual([a.treatment, a.failure_reason, a.position_value_usd, a.price_readings.length], ["confidence_cap", "price_spread_above_5pct", 2000000, 2]);
  assert.equal(r.overall_score.status, "provisional");
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});
