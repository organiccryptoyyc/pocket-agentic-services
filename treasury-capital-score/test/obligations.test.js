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
  const r = run({ obligation_visibility: block({ scope_reconciled: false, unvalued_bounds_usd: { scope_reconciled: 50000 }, unvalued_bounds_refs: { scope_reconciled: ["SRC-1"] } }) });
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
  assert.equal(run({ obligation_visibility: block({ payables_covered: false, unvalued_bounds_usd: { payables_covered: 700000 }, unvalued_bounds_refs: { payables_covered: ["SRC-1"] } }) }).obligations_policy.materiality, "material");
  const r = run({ obligation_visibility: block({ material_conflicts: ["renewal streams queued after a failed vote"] }) });
  assert.equal(r.obligations_policy.materiality, "material");
  assert.equal(r.overall_score.score, 74);
  const mixed = run({ obligation_visibility: block({ payables_covered: false, material_conflicts: [{ description: "disputed streams", usd: 1.4e6 }] }) });
  assert.equal(mixed.obligations_policy.materiality, "material", "a documented material item outranks an undetermined one");
});

test("a critical gap (>= 25% of counted treasury) withholds the score", () => {
  const r = run({ obligation_visibility: block({ debt_covered: false, unvalued_bounds_usd: { debt_covered: 20e6 }, unvalued_bounds_refs: { debt_covered: ["SRC-1"] } }) });
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

test("listed items show each obligation; a usd 0 item counts nothing", () => {
  const before = run({ obligation_visibility: block({}) });
  const items = [...G.input.bundle.obligations.items,
    { id: "NETTED", what: "Debt already netted in a position's value", type: "debt", usd: 0, amount: 180000, unit: "alUSD", source_refs: ["X"] }];
  const r = run({ items, obligation_visibility: block({}) });
  const row = r.obligations_policy.listed_items.find((i) => i.id === "NETTED");
  assert.deepEqual([row.usd, row.amount, row.unit], [0, 180000, "alUSD"]);
  assert.equal(r.obligations_policy.listed_items.length, items.length);
  assert.equal(r.headline.obligations_usd, before.headline.obligations_usd);
  assert.equal(r.overall_score.score, before.overall_score.score);
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

// Build C bounding (owner 2026-11-14, engine 1.11.0)
const search = (extra = {}) => ({ searched_through: "2026-09-25", sources: [{ kind: "court_records" }, { kind: "governance_forum" }, { kind: "news" }], findings: [], source_refs: ["SRC-LEGAL"], ...extra });
const reason = (r, item) => r.obligations_policy.materiality_reasons.find((x) => x.item === item);

test("bounding: a curated bound without a citation is not used", () => {
  const r = run({ obligation_visibility: block({ payables_covered: false, unvalued_bounds_usd: { payables_covered: 5000 } }) });
  assert.equal(reason(r, "payables_covered").materiality, "undetermined");
  assert.match(reason(r, "payables_covered").bound_basis, /without a citation/);
  assert.equal(r.overall_score.score, 74);
});

test("bounding: a current, complete legal claims search with no findings bounds claims at $0", () => {
  const r = run({ obligation_visibility: block({ legal_or_contingent_claims_covered: false, legal_claims_search: search() }) });
  const x = reason(r, "legal_or_contingent_claims_covered");
  assert.equal(x.upper_bound_usd, 0);
  assert.equal(x.materiality, "non_material");
  assert.deepEqual(x.bound_refs, ["SRC-LEGAL"]);
  assert.equal(r.overall_score.score, 84);
});

test("bounding: a stale or incomplete search, or a finding without an amount, leaves claims undetermined", () => {
  const stale = run({ obligation_visibility: block({ legal_or_contingent_claims_covered: false, legal_claims_search: search({ searched_through: "2026-05-01" }) }) });
  assert.equal(reason(stale, "legal_or_contingent_claims_covered").materiality, "undetermined");
  const noNews = run({ obligation_visibility: block({ legal_or_contingent_claims_covered: false, legal_claims_search: search({ sources: [{ kind: "court_records" }, { kind: "governance_forum" }] }) }) });
  assert.equal(reason(noNews, "legal_or_contingent_claims_covered").materiality, "undetermined");
  const open = run({ obligation_visibility: block({ legal_or_contingent_claims_covered: false, legal_claims_search: search({ findings: [{ description: "class action, damages not stated", usd: null }] }) }) });
  assert.equal(reason(open, "legal_or_contingent_claims_covered").materiality, "undetermined");
  const priced = run({ obligation_visibility: block({ legal_or_contingent_claims_covered: false, legal_claims_search: search({ findings: [{ description: "settled claim", usd: 250000 }] }) }) });
  assert.equal(reason(priced, "legal_or_contingent_claims_covered").upper_bound_usd, 250000);
  assert.equal(reason(priced, "legal_or_contingent_claims_covered").materiality, "material");
});

test("bounding: scope is bounded by the reconciliation gap when the collector reconciled", () => {
  const withRecon = (gov) => {
    const bundle = JSON.parse(JSON.stringify(G.input.bundle));
    Object.assign(bundle.obligations, { policy_id: O.POLICY_ID, obligation_visibility: block({ scope_reconciled: false }) });
    bundle.governance = { ...(bundle.governance || {}), ...gov };
    const base = S.computeBase(bundle);
    return buildReport(G.input.entity, bundle, base, [base.nrt]);
  };
  const small = withRecon({ reconciliation_pct: 99.9, reconciliation: { reported_total_usd: 1000000, observed_usd_same_scope: 1040000, reported_as_of: "2026-09-30", source_refs: ["SRC-R"] } });
  assert.equal(reason(small, "scope_reconciled").upper_bound_usd, 40000);
  assert.equal(reason(small, "scope_reconciled").materiality, "non_material");
  const huge = withRecon({ reconciliation_pct: 20, reconciliation: { reported_total_usd: 100e6, observed_usd_same_scope: 20e6, reported_as_of: "2026-09-30", source_refs: ["SRC-R"] } });
  assert.equal(reason(huge, "scope_reconciled").materiality, "material", "a reconciliation gap never withholds the score on its own");
  assert.notEqual(huge.overall_score.score, null);
  const none = withRecon({ reconciliation_pct: null, reconciliation: { reported_total_usd: 1000000, observed_usd_same_scope: 1040000 } });
  assert.equal(reason(none, "scope_reconciled").materiality, "undetermined", "not reconciled this run: no bound");
});

test("bounding: liabilities listed is the sum of its parts, bounded only when every part is", () => {
  const cited = { payables_covered: ["SRC-B"] };
  const partsOpen = run({ obligation_visibility: block({ liabilities_listed: false, payables_covered: false, unvalued_bounds_usd: { payables_covered: 60000 }, unvalued_bounds_refs: cited, legal_or_contingent_claims_covered: false }) });
  assert.equal(reason(partsOpen, "liabilities_listed").materiality, "undetermined");
  const summed = run({ obligation_visibility: block({ liabilities_listed: false, payables_covered: false, unvalued_bounds_usd: { payables_covered: 60000 }, unvalued_bounds_refs: cited, legal_or_contingent_claims_covered: false, legal_claims_search: search({ findings: [{ description: "small claim", usd: 50000 }] }) }) });
  assert.equal(reason(summed, "liabilities_listed").upper_bound_usd, 110000);
  assert.equal(reason(summed, "liabilities_listed").materiality, "material", "parts under $100k each can still be material together");
});
