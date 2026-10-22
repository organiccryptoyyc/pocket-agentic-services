// tcs6-obligations/1.0 (owner D21/D21a, 2026-10-21) on golden fixture 09 (obligations partial, pre-policy 74).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-obligations-test-"));
const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const O = require("../lib/obligations");

const G = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "golden", "09-obligations-partial.json"), "utf8"));
const ALL_TRUE = { liabilities_listed: true, debt_covered: true, payables_covered: true, streams_and_grants_covered: true, legal_or_contingent_claims_covered: true, scope_reconciled: true };

function run(obligationsPatch, { optIn = true } = {}) {
  const bundle = JSON.parse(JSON.stringify(G.input.bundle));
  Object.assign(bundle.obligations, obligationsPatch);
  if (optIn) bundle.obligations.policy_id = O.POLICY_ID;
  const base = S.computeBase(bundle);
  const r = buildReport(G.input.entity, bundle, base, [base.nrt]);
  const errs = validateReport(r).errors;
  assert.deepEqual(errs, [], `schema: ${errs.slice(0, 3).join("; ")}`);
  return r;
}
const block = (extra) => ({ status: "partial", report_date: "2026-09-15", publication_date: "2026-09-20", ...ALL_TRUE, ...extra });

test("not opted in: the pre-policy rule and the frozen output are unchanged", () => {
  const r = run({}, { optIn: false });
  assert.equal(r.overall_score.score, G.expected_report.overall_score.score);
  assert.equal(r.obligations_policy, undefined);
});

test("a gap bounded below both thresholds is non-material: no penalty, effect +10 recorded against the pre-policy score", () => {
  const r = run({ obligation_visibility: block({ scope_reconciled: false, unvalued_bounds_usd: { scope_reconciled: 50000 } }) });
  const p = r.obligations_policy;
  assert.equal(p.policy_id, "tcs6-obligations/1.0");
  assert.equal(p.obligations_status, "partial");
  assert.equal(p.materiality, "non_material");
  assert.equal(p.pre_policy_score, 74);
  assert.equal(r.overall_score.score, 84);
  assert.equal(p.score_effect_points, 10);
  assert.equal(r.overall_score.status, "provisional");
  assert.equal(r.data_coverage.obligation_visibility_status, "partial");
  assert.ok(!r.risks.some((x) => x.id.startsWith("penalty_obligation")));
});

test("an unbounded gap is undetermined (never immaterial): the 10 points stay, effect 0", () => {
  const r = run({ obligation_visibility: block({ payables_covered: false }) });
  assert.equal(r.obligations_policy.materiality, "undetermined");
  assert.equal(r.overall_score.score, 74);
  assert.equal(r.obligations_policy.score_effect_points, 0);
  assert.ok(r.risks.some((x) => x.id === "penalty_obligation_visibility_material"));
  assert.match(r.hard_gates.find((g) => g.id === "obligation_visibility").effect, /payables not covered \(undetermined\)/);
});

test("a gap above $100k, or an unresolved conflict, is material", () => {
  assert.equal(run({ obligation_visibility: block({ payables_covered: false, unvalued_bounds_usd: { payables_covered: 700000 } }) }).obligations_policy.materiality, "material");
  const r = run({ obligation_visibility: block({ material_conflicts: ["renewal streams queued after a failed vote"] }) });
  assert.equal(r.obligations_policy.materiality, "material");
  assert.equal(r.overall_score.score, 74);
});

test("a critical gap (>= 25% of counted treasury) withholds the score", () => {
  const r = run({ obligation_visibility: block({ debt_covered: false, unvalued_bounds_usd: { debt_covered: 20e6 } }) });
  assert.equal(r.obligations_policy.materiality, "critical");
  assert.equal(r.overall_score.score, null);
  assert.equal(r.analysis_status, "insufficient_data");
});

test("adequate: every check true in current evidence, no penalty", () => {
  const r = run({ obligation_visibility: { status: "adequate", report_date: "2026-09-15", ...ALL_TRUE } });
  assert.equal(r.obligations_policy.obligations_status, "adequate");
  assert.equal(r.hard_gates.find((g) => g.id === "obligation_visibility").status, "pass");
  assert.equal(r.obligations_policy.penalty_policy, "no penalty");
});

test("D21a: an old period end counts when published within 90 days and governance was checked after it", () => {
  const old = { report_date: "2026-06-30", publication_date: "2026-08-28", payables_covered: false };
  const ok = run({ obligation_visibility: block({ ...old, governance_checked_through: "2026-09-30" }) });
  assert.equal(ok.obligations_policy.evidence_age_basis, "publication_and_governance_check");
  assert.equal(ok.obligations_policy.evidence_age_days.period_end, 93);
  assert.equal(ok.obligations_policy.obligations_status, "partial");
  const stale = run({ obligation_visibility: block(old) });
  assert.equal(stale.obligations_policy.obligations_status, "unknown");
  assert.equal(stale.overall_score.score, null);
  const checkedBefore = run({ obligation_visibility: block({ ...old, governance_checked_through: "2026-08-01" }) });
  assert.equal(checkedBefore.obligations_policy.obligations_status, "unknown", "a check older than the publication proves nothing newer");
});

test("disclosed commitments are reported and never deducted", () => {
  const disclosed = [
    { id: "DU", what: "DeFi United contribution from recovered funds", class: "contingent", amount: 1860, unit: "ETH", source_refs: ["COMP-DEFI-UNITED-2026"] },
    { what: "Security provider renewal streams queued after a failed vote", class: "disputed", usd: 1398978.64 },
    { what: "not a policy class", class: "maybe" },
  ];
  const r = run({ disclosed, obligation_visibility: block({}) });
  assert.equal(r.obligations_policy.disclosed_commitments.length, 2);
  assert.equal(r.obligations_policy.disclosed_commitments[1].class, "disputed");
  assert.equal(r.headline.obligations_usd, G.expected_report.headline.obligations_usd, "disclosed items never change counted obligations");
});
