// Assembles a tcs6_paid_response_schema_v1.json report from the scoring
// core's output. Numbers come only from lib/scoring.js; this file adds the
// fixed contract text (perimeter, disclaimer), the source manifest after the
// rights filter, and deterministic rationale/risk/gap text.
//
// The rationale strings below are templates. The planned narrative pass
// (handoff step 5) may later rewrite `rationale`, `risks[].description` and
// `data_gaps[]` text only — never a score, weight, or metric value.
"use strict";

const crypto = require("crypto");
const S = require("./scoring");
const { sanitize } = require("./http");

const SCHEMA_VERSION = "tcs-6-paid-response/1.0";
const RELEASE_CONDITION = "verified_payment_webhook_and_ready_validated_report";
const DISCLAIMER =
  "This report is derived from public evidence and stated assumptions as of the reported timestamp. It is not legal, tax, accounting, or personalized investment advice, and it does not authorize or execute any transaction.";
const DELIVERABLE_RIGHTS = new Set(["permitted_for_derived_output", "licensed_for_display"]);

const PERIMETER = {
  included_classes: [
    "On-chain assets controlled by a verified treasury address, Safe, timelock, or governance-controlled contract",
    "Publicly disclosed off-chain cash, money-market funds, T-bills, and custody balances",
    "Protocol-owned liquidity and LP positions net of embedded borrowing and realization costs",
    "Staked or locked assets after unbonding, exit-liquidity, and market-impact haircuts",
  ],
  excluded_classes: [
    "TVL, deposits, collateral, bridge balances, or insurance funds beneficially owned by users",
    "Circulating market capitalization, FDV, token price, and unissued token supply",
    "Unvested grants, unsigned commitments, and expected future token emissions",
    "Unverified wallet balances and assets whose beneficial owner cannot be established",
  ],
  beneficial_ownership_rule:
    "Only assets whose control by the entity is evidenced count toward treasury capital; one economic exposure is counted once across addresses, wrappers, and bridges.",
};

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function fmtUsd(x) {
  if (x === null || x === undefined) return "unknown";
  const a = Math.abs(x);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : `${Math.round(a).toLocaleString("en-US")}`;
  return `${x < 0 ? "-" : ""}$${s}`;
}

function metricValue(d, name) {
  const m = d.primary_metrics.find((x) => x.name === name);
  return m ? m.value : null;
}

function rationale(d) {
  const v = (n) => metricValue(d, n);
  if (d.score === null && d.id !== "D1") return "Not scored: required inputs are not yet evidenced; see data_gaps.";
  switch (d.id) {
    case "D1":
      return d.score === null
        ? `Net Realizable Treasury is ${fmtUsd(v("net_realizable_treasury_usd"))}. Percentile not computed: the cohort has ${d._peers} eligible peers and the method requires ${S.MIN_PEERS}; dimension excluded from coverage.`
        : `Net Realizable Treasury ${fmtUsd(v("net_realizable_treasury_usd"))} sits at the ${Math.round(d._pct)}th same-cohort percentile.`;
    case "D2":
      return v("liquidity_runway_months") === null
        ? "No credible 12-month cash-use figure is evidenced, which the method scores at the 0 anchor."
        : `Tier 0-1 liquid assets of ${fmtUsd(v("tier_0_to_1_hqla_usd"))} cover ${v("liquidity_runway_months")} months of documented cash needs.`;
    case "D3":
      return typeof v("claim_coverage_ratio") === "number"
        ? `NRT covers recorded obligations of ${fmtUsd(v("obligations_due_or_enforceable_usd"))} ${v("claim_coverage_ratio")}x.`
        : "No material known obligations are documented; scored on legal and contingency evidence rather than an unbounded ratio.";
    case "D4":
      return `Under the ${S.STRESS_SET.label} (${S.STRESS_SET.id}), ${v("nrt_survival_pct")}% of NRT survives. Largest single exposure is ${v("top_1_asset_weight_pct")}% of verified value; native token is ${v("native_token_weight_pct")}%.${d._concentrationFailure ? " A single non-cash exposure above 50% caps this dimension at 75." : ""}${d._correlatedFailure ? ` Correlated exposures in group '${d._correlatedGroup}' total ${S.round(d._correlatedWeight, 1)}%, capping this dimension at ${S.CORRELATED_CAP}.` : ""}`;
    case "D5":
      return `Trailing 12-month self-funding ratio is ${v("self_funding_ratio")}% (recurring treasury inflows ${fmtUsd(v("trailing_12m_recurring_treasury_inflows_usd"))} vs controllable uses ${fmtUsd(v("trailing_12m_controllable_cash_uses_usd"))}).`;
    case "D6":
      return `Verified control covers ${v("verified_control_value_pct")}% of reported value; reconciliation ${v("address_or_custody_reconciliation_pct") === null ? "not evidenced" : v("address_or_custody_reconciliation_pct") + "%"}, latest disclosure ${v("disclosure_age_days") === null ? "date not evidenced" : v("disclosure_age_days") + " days old"}; controls: ${v("treasury_policy_and_multisig_controls")}.`;
    default:
      return "";
  }
}

function derivedRisks(dims, cov) {
  const out = [];
  const d4 = dims.find((d) => d.id === "D4");
  if (d4 && d4._nativeWeight > 50) out.push({ id: "native_token_concentration", category: "market", severity: d4._nativeWeight > 75 ? "high" : "medium", description: `Native token is ${S.round(d4._nativeWeight, 1)}% of verified treasury value; realizable value under stress is far below spot.`, monitoring_action: "Track native-token share and exit depth each refresh." });
  if (d4 && d4._correlatedFailure) out.push({ id: "correlated_concentration", category: "market", severity: "high", description: `Correlated exposures in group '${d4._correlatedGroup}' are ${S.round(d4._correlatedWeight, 1)}% of verified value and would fall together under stress.`, monitoring_action: "Track the group's combined weight each refresh." });
  if (d4 && d4._concentrationFailure) out.push({ id: "single_asset_concentration", category: "market", severity: "medium", description: `One non-cash exposure is ${S.round(d4._topWeight, 1)}% of verified value.`, monitoring_action: "Watch for diversification proposals or treasury policy limits." });
  if (cov.verified_control_value_pct !== null && cov.verified_control_value_pct < 80) out.push({ id: "control_evidence_gap", category: "data_quality", severity: cov.verified_control_value_pct < 60 ? "high" : "medium", description: `Only ${cov.verified_control_value_pct}% of reported value has verified control evidence.`, monitoring_action: "Extend the address map with control citations." });
  if (cov.obligation_visibility_status !== "adequate") out.push({ id: "obligation_visibility", category: "legal_claim", severity: "medium", description: `Obligation visibility is ${cov.obligation_visibility_status}; undisclosed liabilities may exist.`, monitoring_action: "Re-check governance forums and filings for debt, pledges, and commitments." });
  return out;
}

function derivedGaps(dims, overallScore) {
  const gaps = [];
  for (const d of dims) {
    for (const m of d.primary_metrics) {
      if (m.status === "insufficient_data") gaps.push({ field: `${d.id}.${m.name}`, reason: "Required evidence is not yet available for this metric.", impact: d.score === null ? `${d.id} excluded from coverage.` : `${d.id} scored conservatively.`, remediation: "Collector or registry curation to supply a cited source." });
    }
  }
  if (overallScore.coverage_pct >= 80 && overallScore.coverage_pct < 90) gaps.unshift({ field: "overall_score.coverage_pct", reason: `Only ${overallScore.coverage_pct}% of dimension weight is scored.`, impact: "Score is allowed but rests on incomplete dimensions.", remediation: "Close the dimension gaps listed below." });
  return gaps;
}

function cleanText(obj) {
  if (typeof obj === "string") return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(cleanText);
  if (obj && typeof obj === "object") return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === "url" ? v : cleanText(v)]));
  return obj;
}

// Removes internal-only/unreviewed sources and every reference to them.
function rightsFilter(bundleSources) {
  const delivered = [];
  const blocked = [];
  for (const s of bundleSources || []) (DELIVERABLE_RIGHTS.has(s.rights_status) ? delivered : blocked).push(s);
  const ok = new Set(delivered.map((s) => s.source_ref));
  return { delivered, blocked, keep: (refs) => (refs || []).filter((r) => ok.has(r)) };
}

function stripPrivate(d) {
  return Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("_")));
}

function entityBlock(entity) {
  return { entity_id: entity.entity_id, name: entity.name, entity_type: entity.entity_type, peer_cohort: entity.peer_cohort ?? null, registry_status: entity.registry_status };
}

function buildReport(entity, bundle, base, peerNrts) {
  const dims = [S.d1(base, peerNrts), S.d2(base, bundle), S.d3(base, bundle), S.d4(base), S.d5(bundle), S.d6(base, bundle)];
  const rights = rightsFilter(bundle.sources);
  const gateList = S.gates(entity, base, bundle, rights.blocked);
  const overallScore = S.overall(dims, gateList, bundle.penalties, !!(bundle.obligations && bundle.obligations.bounded));
  const cov = S.dataCoverage(base, bundle);

  for (const d of dims) {
    d.rationale = rationale(d);
    d.evidence_refs = rights.keep(d.evidence_refs);
    for (const m of d.primary_metrics) m.source_refs = rights.keep(m.source_refs);
  }
  for (const g of gateList) g.evidence_refs = rights.keep(g.evidence_refs);

  const curatedRisks = (bundle.risks || []).filter((r) => r && r.id && r.category && r.severity && r.description && r.monitoring_action)
    .map(({ id, category, severity, description, monitoring_action }) => ({ id, category, severity, description, monitoring_action }));
  const curatedGaps = (bundle.gaps || []).filter((g) => g && g.field && g.reason)
    .map(({ field, reason, impact, remediation }) => ({ field, reason, impact: impact || "", remediation: remediation || "" }));
  const penaltyRisks = (bundle.penalties || []).map((p) => ({ id: `penalty_${p.id}`, category: "other", severity: "medium", description: `Documented penalty of ${p.points} points: ${p.reason}`, monitoring_action: "Re-evaluate at next refresh." }));

  const statusMap = { eligible: "ready", provisional: "provisional", insufficient_data: "insufficient_data", ineligible: "insufficient_data" };
  const d1 = dims[0];
  return cleanText({
    schema_version: SCHEMA_VERSION,
    report_id: newId("tcs6"),
    analysis_status: statusMap[overallScore.status],
    as_of: bundle.collected_at,
    currency: "USD",
    entity: entityBlock(entity),
    payment_entitlement: { release_condition: RELEASE_CONDITION, entitlement_id: "assigned_at_delivery", payment_verified_at: bundle.collected_at, delivery_expires_at: null },
    capital_perimeter: { ...PERIMETER, known_perimeter_gaps: [entity.treasury_perimeter, ...(bundle.perimeter_gaps || [])].filter(Boolean) },
    headline: {
      gross_adjusted_treasury_usd: S.round(base.verifiedRows.length ? base.grossAdjusted : null),
      obligations_usd: S.round(base.obligations),
      net_realizable_treasury_usd: S.round(base.nrt),
      capital_scale_percentile: d1._pct === null ? null : S.round(d1._pct, 1),
      capital_scale_peer_count: d1._peers,
    },
    hard_gates: gateList,
    dimensions: dims.map(stripPrivate),
    overall_score: overallScore,
    confidence: S.confidence(base, overallScore.coverage_pct, rights.delivered, gateList.find((g) => g.id === "control_coverage").status === "pass"),
    data_coverage: cov,
    source_manifest: rights.delivered.map(({ source_ref, title, publisher, url, retrieved_at, observation_time, source_tier, rights_status }) => ({ source_ref, title, publisher, url, retrieved_at, observation_time: observation_time ?? null, source_tier, rights_status })),
    risks: [...curatedRisks, ...derivedRisks(dims, cov), ...penaltyRisks],
    data_gaps: [...derivedGaps(dims, overallScore), ...curatedGaps],
    disclaimer: DISCLAIMER,
  });
}

// Schema-valid "nothing scored yet" answer for a known registry entity.
function insufficientReport(entity, reason, nowIso) {
  const dims = S.DIMENSIONS.map((d) => ({ id: d.id, name: d.name, weight_pct: d.weight_pct, score: null, status: "insufficient_data", rationale: "Not scored: no validated report exists for this entity yet.", confidence: 0, primary_metrics: [], evidence_refs: [] }));
  const gate = (id, status, effect) => ({ id, status, evidence_refs: [], effect });
  return cleanText({
    schema_version: SCHEMA_VERSION,
    report_id: newId("tcs6"),
    analysis_status: "insufficient_data",
    as_of: nowIso,
    currency: "USD",
    entity: entityBlock(entity),
    payment_entitlement: { release_condition: RELEASE_CONDITION, entitlement_id: "assigned_at_delivery", payment_verified_at: nowIso, delivery_expires_at: null },
    capital_perimeter: { ...PERIMETER, known_perimeter_gaps: [entity.treasury_perimeter].filter(Boolean) },
    headline: { gross_adjusted_treasury_usd: null, obligations_usd: null, net_realizable_treasury_usd: null, capital_scale_percentile: null, capital_scale_peer_count: null },
    hard_gates: [
      gate("entity_identity", entity.scoreable ? "pass" : "fail", entity.scoreable ? "Registry record is admitted for scoring." : `Registry eligibility is '${entity.eligibility}'; not yet admitted for scoring.`),
      gate("control_coverage", "unknown_gate", "No evidence evaluated."),
      gate("valuation_freshness", "unknown_gate", "No evidence evaluated."),
      gate("obligation_visibility", "unknown_gate", "No evidence evaluated."),
      gate("source_rights", "pass", "No sources delivered."),
    ],
    dimensions: dims,
    overall_score: { score: null, coverage_pct: 0, decision_band: null, status: "insufficient_data", method_version: S.METHOD_VERSION },
    confidence: { score: 0, label: "low", source_quality: 0, data_coverage: 0, cross_source_consistency: 0, recency_fit: 0 },
    data_coverage: { verified_control_value_pct: null, offchain_disclosed_value_pct: null, fresh_price_value_pct: null, obligation_visibility_status: "unknown" },
    source_manifest: [],
    risks: [],
    data_gaps: [{ field: "report", reason, impact: "No dimension, gate, or headline value can be stated.", remediation: entity.scoreable ? "Wait for the next scheduled pipeline run." : "Complete registry vetting for this entity." }],
    disclaimer: DISCLAIMER,
  });
}

// Per-relay stamping (architecture doc section 2): the relay itself is the
// payment, so entitlement = this delivery, verified "now", no download window.
function stampEntitlement(report, nowIso) {
  return { ...report, payment_entitlement: { release_condition: RELEASE_CONDITION, entitlement_id: newId("ent"), payment_verified_at: nowIso, delivery_expires_at: null } };
}

module.exports = { buildReport, insufficientReport, stampEntitlement, SCHEMA_VERSION };
