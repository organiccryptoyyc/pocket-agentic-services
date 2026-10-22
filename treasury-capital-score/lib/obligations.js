// Obligations policy tcs6-obligations/1.0 (owner decisions D21 and D21a, 2026-10-21).
// Applies only to bundles that opt in with obligations.policy_id; every other bundle keeps the
// pre-policy rule (lib/scoring.js obligationVisibility + the flat PARTIAL_OBLIGATIONS_PENALTY).
//  - evidence age: a report counts while its period end is within 90 days, or while it was published
//    within 90 days and governance was checked for anything newer (governance_checked_through);
//  - each missing checklist item and each material conflict is assessed for materiality: a curated
//    upper bound under both thresholds is non-material; no bound is undetermined (never immaterial);
//  - partial + material/undetermined: the 10 points once; partial + non-material: no penalty;
//    partial + critical, or unknown: score withheld;
//  - disclosed commitments (voluntary, conditional, contingent, disputed, unconfirmed, own-token
//    issuance) are reported and never deducted.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "methodology", "tcs6_obligations_policy_v1.json"), "utf8"));
const POLICY_ID = POLICY.policy_id;
const DAY = 86400000;
const RANK = { unknown: 0, partial: 1, adequate: 2 };
const SEVERITY = { none: 0, non_material: 1, undetermined: 2, material: 2, critical: 3 };
const CHECKS = [
  ["liabilities_listed", "liabilities not listed"],
  ["debt_covered", "debt not covered"],
  ["payables_covered", "payables not covered"],
  ["streams_and_grants_covered", "streams and grants not covered"],
  ["legal_or_contingent_claims_covered", "legal or contingent claims not covered"],
  ["scope_reconciled", "scope not reconciled to the treasury perimeter"],
];

function applies(bundle) {
  return !!(bundle && bundle.obligations && bundle.obligations.policy_id === POLICY_ID);
}

const days = (asOfMs, ymd) => {
  const t = Date.parse(`${ymd || ""}`);
  return Number.isFinite(t) && Number.isFinite(asOfMs) ? Math.floor((asOfMs - t) / DAY) : null;
};

// Materiality of one unvalued gap: a curated upper bound, or undetermined.
function gapMateriality(boundUsd, treasuryUsd, p = POLICY.materiality) {
  if (!Number.isFinite(boundUsd)) return "undetermined";
  const share = treasuryUsd > 0 ? boundUsd / treasuryUsd : null;
  if (share !== null && share >= p.critical_share_threshold) return "critical";
  if (boundUsd > p.value_threshold_usd || (share !== null && share > p.treasury_share_threshold)) return "material";
  return "non_material";
}

function grade(bundle, asOfMs, treasuryUsd) {
  const obl = bundle.obligations || {};
  const block = obl.obligation_visibility && typeof obl.obligation_visibility === "object" ? obl.obligation_visibility : {};
  const max = POLICY.evidence_age.max_age_days;
  const periodAge = days(asOfMs, block.report_date);
  const pubAge = days(asOfMs, block.publication_date);
  const checkedAge = days(asOfMs, block.governance_checked_through);
  const checkedAfterPub = block.governance_checked_through && block.publication_date && block.governance_checked_through >= block.publication_date;
  let ageBasis = null;
  if (periodAge !== null && periodAge <= max) ageBasis = "period_end";
  else if (pubAge !== null && pubAge <= max && checkedAge !== null && checkedAge >= 0 && checkedAge <= max && checkedAfterPub) ageBasis = "publication_and_governance_check";

  const missing = CHECKS.filter(([k]) => block[k] !== true);
  const bounds = block.unvalued_bounds_usd && typeof block.unvalued_bounds_usd === "object" ? block.unvalued_bounds_usd : {};
  const reasons = missing.map(([k, label]) => {
    const bound = Number(bounds[k]);
    const m = gapMateriality(Number.isFinite(bound) ? bound : NaN, treasuryUsd);
    return { item: k, description: label, upper_bound_usd: Number.isFinite(bound) ? bound : null, materiality: m };
  });
  for (const c of Array.isArray(block.material_conflicts) ? block.material_conflicts : []) {
    const text = typeof c === "string" ? c : c && c.description;
    if (!text) continue;
    const usd = c && typeof c === "object" ? Number(c.usd) : NaN;
    const m = Number.isFinite(usd) ? gapMateriality(usd, treasuryUsd) : "material";
    reasons.push({ item: "material_conflict", description: `unresolved material conflict: ${text}`, upper_bound_usd: Number.isFinite(usd) ? usd : null, materiality: m === "non_material" ? "material" : m });
  }

  let status;
  if (!ageBasis) status = "unknown";
  else status = missing.length || reasons.some((r) => r.item === "material_conflict") ? "partial" : "adequate";
  const claimed = RANK[block.status] !== undefined ? block.status : status;
  status = [status, claimed].sort((a, b) => RANK[a] - RANK[b])[0];
  const materiality = reasons.length ? reasons.reduce((w, r) => (SEVERITY[r.materiality] > SEVERITY[w] ? r.materiality : w), "non_material") : "none";
  const undatedReason = ageBasis ? null : (periodAge === null && pubAge === null ? "no dated obligations report"
    : `obligations evidence is too old (period end ${periodAge ?? "n/a"} days, publication ${pubAge ?? "n/a"} days; limit ${max}, or a governance check after publication)`);
  return {
    status, ageBasis, periodAge, pubAge,
    governanceCheckedThrough: block.governance_checked_through || null,
    reasons, materiality, undatedReason,
    bounded: status === "unknown" ? false : materiality !== "critical",
    penalty: status === "partial" && (materiality === "material" || materiality === "undetermined")
      ? [{ id: "obligation_visibility_material", points: POLICY.obligations_penalty_points,
           reason: `Obligations are only partly visible and the gap is ${materiality} under ${POLICY_ID} (${reasons.filter((r) => r.materiality !== "non_material").map((r) => r.description).join("; ")}).` }]
      : [],
  };
}

function disclosed(bundle) {
  const list = (bundle.obligations && Array.isArray(bundle.obligations.disclosed)) ? bundle.obligations.disclosed : [];
  return list.filter((d) => d && typeof d.what === "string" && POLICY.disclosed_classes.includes(d.class)).map((d) => ({
    id: String(d.id || "").slice(0, 60) || null,
    what: d.what.slice(0, 300),
    class: d.class,
    amount: Number.isFinite(d.amount) ? d.amount : null,
    unit: typeof d.unit === "string" ? d.unit.slice(0, 20) : null,
    usd: Number.isFinite(d.usd) ? d.usd : null,
    note: typeof d.note === "string" ? d.note.slice(0, 400) : null,
    source_refs: Array.isArray(d.source_refs) ? d.source_refs.filter((r) => typeof r === "string") : [],
  }));
}

// The report block: pre-policy and policy scores side by side (owner: the effect must be auditable).
function block(g, pre, post, discl) {
  return {
    policy_id: POLICY_ID,
    obligations_status: g.status,
    evidence_age_basis: g.ageBasis,
    evidence_age_days: { period_end: g.periodAge, publication: g.pubAge },
    governance_checked_through: g.governanceCheckedThrough,
    materiality: g.materiality,
    materiality_reasons: g.reasons,
    penalty_policy: g.penalty.length ? `${POLICY.obligations_penalty_points} points once (gap ${g.materiality})`
      : g.status === "partial" && g.materiality === "critical" ? "score withheld (critical gap)"
      : g.status === "unknown" ? "score withheld (obligations unknown)" : "no penalty",
    pre_policy_score: pre.score,
    pre_policy_status: pre.status,
    score: post.score,
    score_effect_points: Number.isFinite(pre.score) && Number.isFinite(post.score) ? post.score - pre.score : null,
    disclosed_commitments: discl,
  };
}

module.exports = { POLICY, POLICY_ID, applies, grade, gapMateriality, disclosed, block };
