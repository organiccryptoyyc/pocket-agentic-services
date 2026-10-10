// node --test test/   (zero dependencies; Node >= 18)
//
// All fixtures are synthetic entities ("example-dao", "peer-NN") in a
// throwaway registry and data dir, so no test can ever write a score for a
// real protocol into the production cache.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-"));
process.env.TCS6_DATA_DIR = path.join(tmp, "var");
process.env.TCS6_REGISTRY = path.join(tmp, "registry.json");

const S = require("../lib/scoring");
const { buildReport, insufficientReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const store = require("../lib/store");

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "evidence-example.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const entity = (id, extra = {}) => ({ entity_id: id, name: id, entity_type: "defi_protocol", peer_cohort: "DeFi protocol", registry_status: "partially_verified", eligibility: "confirmed", scoreable: true, treasury_perimeter: "synthetic", ...extra });
const report = (bundle, peers = [], ent = entity(bundle.entity_id)) => {
  const base = S.computeBase(bundle);
  return buildReport(ent, bundle, base, peers.length ? peers : [base.nrt]);
};

test("anchor interpolation follows blueprint anchors", () => {
  assert.strictEqual(S.anchorScore(2.9, [[3, 25], [6, 50], [12, 75], [24, 100]]), 0);
  assert.strictEqual(S.anchorScore(3, [[3, 25], [6, 50], [12, 75], [24, 100]]), 25);
  assert.strictEqual(S.anchorScore(9, [[3, 25], [6, 50], [12, 75], [24, 100]]), 62.5);
  assert.strictEqual(S.anchorScore(30, [[3, 25], [6, 50], [12, 75], [24, 100]]), 100);
});

test("haircuts stay inside blueprint ranges", () => {
  for (const [cls, [lo, hi]] of Object.entries(S.HAIRCUT_RANGES)) {
    for (const flags of [[], ["a"], ["a", "b", "c"]]) {
      const h = S.haircutPct({ asset_class: cls, haircut_flags: flags, realization_path_evidenced: true });
      assert.ok(h >= lo && h <= hi, `${cls} ${h}`);
    }
  }
  assert.strictEqual(S.haircutPct({ asset_class: "native_token", haircut_flags: ["no_orderly_exit"] }), 100);
  assert.strictEqual(S.haircutPct({ asset_class: "locked_unverifiable" }), 100);
});

test("example bundle produces a schema-valid report; D1 null below 20 peers", () => {
  const r = report(clone(EXAMPLE));
  const v = validateReport(r);
  assert.ok(v.ok, v.errors.join("\n"));
  const d1 = r.dimensions.find((d) => d.id === "D1");
  assert.strictEqual(d1.score, null);
  assert.strictEqual(r.headline.capital_scale_percentile, null);
  assert.strictEqual(r.overall_score.coverage_pct, 80);
  assert.strictEqual(r.overall_score.status, "eligible");
  assert.strictEqual(r.analysis_status, "ready");
  assert.ok(Number.isInteger(r.overall_score.score));
  assert.ok(r.data_gaps.some((g) => g.field === "overall_score.coverage_pct"), "80-90% coverage gap must be prominent");
});

test("collector warnings become data gaps; the score is unchanged and nothing is dropped", () => {
  const plain = report(clone(EXAMPLE));
  const b = clone(EXAMPLE);
  b.collector_warnings = [
    { code: "value_swing", summary: "Gross verified value moved +52% since the last accepted evidence (2026-10-09).", automatic_override: false, drivers: [] },
    "bad code!", { summary: "no code" },
  ];
  const r = report(b);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
  const w = r.data_gaps.filter((g) => g.field.startsWith("collector_warnings."));
  assert.deepStrictEqual(w.map((g) => g.field), ["collector_warnings.value_swing"]);
  assert.match(w[0].reason, /\+52%/);
  assert.match(w[0].impact, /nothing was rejected or substituted/);
  assert.strictEqual(r.overall_score.score, plain.overall_score.score);
  assert.deepStrictEqual(r.headline, plain.headline);
});

test("NRT arithmetic: verified only, haircut, minus probability-weighted obligations", () => {
  const b = S.computeBase(clone(EXAMPLE));
  // USDC 40M consistent @ ~0.9999, haircut mid 6% ; WETH 15M haircut 5+15*0.75=16.25% ;
  // native 50M haircut 80% ; T-bills 10M haircut 2.5% ; unverified excluded.
  const usdc = 40e6 * ((1.0 + 0.9998) / 2) * 0.94;
  const expectedAdj = usdc + 15e6 * (1 - 0.1625) + 50e6 * 0.2 + 10e6 * 0.975;
  assert.ok(Math.abs(b.grossAdjusted - expectedAdj) < 1);
  assert.strictEqual(b.obligations, 2e6 + 5e6 * 0.2);
  assert.ok(Math.abs(b.nrt - (expectedAdj - 3e6)) < 1);
});

test("D1 computes with >= 20 cohort peers", () => {
  const peers = Array.from({ length: 24 }, (_, i) => (i + 1) * 5e6);
  const r = report(clone(EXAMPLE), peers);
  const d1 = r.dimensions.find((d) => d.id === "D1");
  assert.ok(d1.score !== null && d1.score > 0);
  assert.strictEqual(r.overall_score.coverage_pct, 100);
  assert.strictEqual(r.headline.capital_scale_peer_count, 24);
  assert.ok(validateReport(r).ok);
});

test("unknown obligations withhold the overall score", () => {
  const b = clone(EXAMPLE);
  b.obligations = { visibility: "unknown" };
  const r = report(b);
  assert.strictEqual(r.overall_score.score, null);
  assert.strictEqual(r.analysis_status, "insufficient_data");
  assert.ok(validateReport(r).ok);
});

test("control coverage under 60% caps at provisional with no band", () => {
  const b = clone(EXAMPLE);
  b.holdings.forEach((h) => { if (h.asset_class === "native_token") h.control = "unverified"; });
  b.holdings.push({ ...b.holdings[2], asset_id: "x", control: "unverified", quantity: 300000000 });
  const r = report(b);
  assert.strictEqual(r.hard_gates.find((g) => g.id === "control_coverage").status, "unknown_gate");
  assert.strictEqual(r.overall_score.status, "provisional");
  assert.strictEqual(r.overall_score.decision_band, null);
  assert.ok(validateReport(r).ok);
});

test("internal_only sources never reach the delivered report", () => {
  const r = report(clone(EXAMPLE));
  assert.ok(!r.source_manifest.some((s) => s.source_ref === "S5"));
  assert.ok(!JSON.stringify(r.dimensions).includes('"S5"'));
});

test("gateway error substrings are scrubbed from free text", () => {
  const b = clone(EXAMPLE);
  b.gaps = [{ field: "x", reason: "Upstream request timeout", impact: "bad gateway", remediation: "retry" }];
  const r = report(b);
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
  assert.ok(!/timeout|bad gateway/i.test(JSON.stringify(r).replace(/"url":"[^"]*"/g, "")));
});

test("insufficient-data report is schema-valid", () => {
  const r = insufficientReport(entity("x", { scoreable: false, eligibility: "needs_first_time_vetting" }), "not vetted", new Date().toISOString());
  assert.ok(validateReport(r).ok, validateReport(r).errors.join("\n"));
});

test("pipeline + HTTP routes end to end", async () => {
  fs.writeFileSync(process.env.TCS6_REGISTRY, JSON.stringify({ entities: [entity("example-dao"), entity("unvetted", { scoreable: false, registry_status: "unverified", eligibility: "needs_first_time_vetting" })] }));
  store.ensureDirs();
  const bundle = clone(EXAMPLE);
  bundle.collected_at = new Date().toISOString();
  store.writeJsonAtomic(store.paths.evidence("example-dao"), bundle);
  const { runOnce } = require("../pipeline/run");
  const res = runOnce();
  assert.deepStrictEqual(res.failed, []);
  assert.strictEqual(res.scored.length, 1);

  const { handleScore, handleEntities } = require("../server");
  const scored = await handleScore({ entity_id: "example-dao" });
  assert.ok(validateReport(scored).ok);
  assert.match(scored.payment_entitlement.entitlement_id, /^ent_/);
  const unvetted = await handleScore({ entity_id: "unvetted" });
  assert.match(unvetted.payment_entitlement.entitlement_id, /^ent_/);
  assert.strictEqual(unvetted.analysis_status, "insufficient_data");
  await assert.rejects(handleScore({ entity_id: "nope" }), (e) => e.status === 400);
  await assert.rejects(handleScore({}), (e) => e.status === 400);
  const list = await handleEntities({});
  assert.strictEqual(list.count, 2);
  assert.strictEqual(list.method_version, "tcs-6/1.0");
});

test("HQLA excludes liquidity-impaired assets", () => {
  const b = clone(EXAMPLE);
  const before = report(b).dimensions.find((d) => d.id === "D2").primary_metrics[0].value;
  b.holdings[0].haircut_flags = ["redemption_limits"]; // USDC
  const after = report(b).dimensions.find((d) => d.id === "D2").primary_metrics[0].value;
  assert.ok(after < before - 30e6, `${before} -> ${after}`);
});

test("correlated exposures above 50% cap D4 at 60", () => {
  const b = clone(EXAMPLE);
  b.holdings[1].correlation_group = "eth";
  b.holdings.push({ ...clone(b.holdings[1]), asset_id: "eth:steth", asset_class: "liquid_alt", quantity: 40000, correlation_group: "eth" });
  const d4 = report(b).dimensions.find((d) => d.id === "D4");
  assert.ok(d4.score <= S.CORRELATED_CAP, String(d4.score));
  assert.ok(d4.primary_metrics.some((m) => m.name === "largest_correlated_group_weight_pct" && m.value > 50));
  assert.match(d4.rationale, /severe stress scenario \(not a forecast\)/);
});

test("low control coverage: score allowed, provisional, confidence capped", () => {
  const b = clone(EXAMPLE);
  b.holdings.push({ ...clone(b.holdings[2]), asset_id: "y", control: "unverified", quantity: 400000000 });
  const r = report(b);
  assert.ok(r.overall_score.score !== null);
  assert.strictEqual(r.overall_score.status, "provisional");
  assert.ok(r.confidence.score <= S.LOW_CONTROL_CONFIDENCE_CAP);
  assert.strictEqual(r.confidence.label, "low");
});

test("D6 publishes its rubric inputs and the step that fired", () => {
  const d6 = report(clone(EXAMPLE)).dimensions.find((d) => d.id === "D6");
  const names = d6.primary_metrics.map((m) => m.name);
  for (const n of ["control_known", "independent_attestation", "documented_treasury_policy", "timelock_present", "multisig_threshold", "d6_rubric_step"]) assert.ok(names.includes(n), n);
  assert.match(d6.primary_metrics.find((m) => m.name === "d6_rubric_step").value, /^75: /);
});

test("obligations checklist: the lower of the graded and claimed status wins (O2)", () => {
  const block = { status: "adequate", report_date: "2026-09-01", liabilities_listed: true, debt_covered: true, payables_covered: true,
    streams_and_grants_covered: true, legal_or_contingent_claims_covered: true, scope_reconciled: true, material_conflicts: [] };
  const asOf = Date.parse("2026-10-01T12:00:00Z");
  const vis = (extra, obl = {}) => S.obligationVisibility({ obligations: { visibility: "partial", bounded: true, ...obl, obligation_visibility: { ...block, ...extra } } }, asOf);
  assert.strictEqual(vis({}).status, "adequate");
  assert.strictEqual(vis({ status: "partial" }).status, "partial");                       // curator may grade down, never up
  assert.strictEqual(vis({ material_conflicts: ["forum says 2M debt"] }).status, "partial");
  assert.match(vis({ material_conflicts: ["forum says 2M debt"] }).missing.join(), /forum says 2M debt/);
  assert.strictEqual(vis({ report_date: "2026-07-03" }).status, "adequate");             // 90 days at as_of: still inside
  assert.strictEqual(vis({ report_date: "2026-07-01" }).status, "unknown");
  assert.strictEqual(vis({ report_date: undefined }).status, "unknown");
  assert.strictEqual(vis({ debt_covered: undefined }).status, "partial");                // a missing flag is not a pass
  assert.deepStrictEqual(S.obligationVisibility({ obligations: { visibility: "partial", bounded: true } }, asOf).status, "partial");
});

test("partial obligations deduct the 10-point penalty and show it as a risk", () => {
  const b = clone(EXAMPLE);
  const full = report(clone(EXAMPLE)).overall_score.score;
  b.obligations.visibility = "partial";
  const r = report(b);
  assert.strictEqual(r.overall_score.score, full - S.PARTIAL_OBLIGATIONS_PENALTY);
  assert.strictEqual(r.overall_score.status, "provisional");
  assert.ok(r.risks.some((x) => x.id === "penalty_obligation_visibility_partial"));
});
