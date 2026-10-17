// Materiality policy tcs6-materiality/1.0 (D18): contract-identity failures from a valid attestation.
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
  assert.equal(p.policy_id, "tcs6-materiality/1.0");
  assert.deepEqual([p.value_threshold_usd, p.treasury_share_threshold, p.critical_core_share_threshold, p.confidence_cap, p.obligations_penalty_points, p.price_attestation_threshold, p.price_materiality_threshold],
    [100000, 0.02, 0.25, 59, 10, 0.02, 0.05]);
  assert.deepEqual(Object.entries(p.classes).filter(([, c]) => c.active).map(([k]) => k), ["contract_identity_control"]);
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
  assert.match(r.attestation.statement, /Materiality under policy tcs6-materiality\/1\.0: test_contract source contract_identity_control \(\$0 of \$[\d,]+, 0\.00%\): non_material; no score effect \(disclosed\)\./);
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

test("classes not yet active are assessed but change nothing; invalid attestations are not assessed", () => {
  const r = report(withAttestation(plainBundle, [failed(A2, "realizability_control", "native at A2")]));
  const a = r.attestation.materiality.assessments[0];
  assert.equal(a.materiality, "critical");
  assert.equal(a.policy_active_for_kind, false);
  assert.equal(r.attestation.materiality.effect, "none");
  assert.equal(r.overall_score.score, plain.overall_score.score);
  const bad = report(withAttestation(plainBundle, [failed(A2)]), { status: "invalid", detail: "bad signature" });
  assert.equal(bad.overall_score.score, plain.overall_score.score);
  assert.equal(bad.attestation.verification_status, "invalid");
  assert.equal(bad.attestation.materiality, undefined);
});

test("an address that can't be matched (no contract) stays undetermined", () => {
  const c = { ...failed(A1), contract: null };
  const r = report(withAttestation(plainBundle, [c]));
  assert.equal(r.attestation.materiality.assessments[0].materiality, "undetermined");
  assert.equal(r.overall_score.score, plain.overall_score.score);
});
