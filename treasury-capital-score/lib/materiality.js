// Materiality policy tcs6-materiality/1.0 (owner decision D18, methodology/tcs6_materiality_policy_v1.json).
//
// The Pi signs which checks failed and never decides materiality ("undetermined" in the signed payload).
// This side applies the versioned policy to the failed checks of a *valid* attestation, using the report's
// own counted treasury value:
//
//   affected value  verified positions held at the failed contract or of that token (fair value)
//   critical        affected / counted treasury value >= critical_core_share_threshold
//   material        affected > value_threshold_usd OR affected / counted > treasury_share_threshold (strict)
//   non_material    otherwise: disclosed, no score effect
//   undetermined    the share can't be computed (no counted treasury value): never assumed immaterial
//
// Only classes marked active are applied (contract identity first); the others are listed as not active.
// Effects: material -> provisional, the affected positions leave verified value, confidence capped;
// critical -> insufficient_data with a null score. Nothing here changes a signed value.
"use strict";

const POLICY = require("../methodology/tcs6_materiality_policy_v1.json");

const RANK = { none: 0, disclose: 1, provisional: 2, insufficient_data: 3 };

function affectedRows(base, contract) {
  const c = String(contract || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(c)) return null;
  return base.verifiedRows.filter((r) => {
    const parts = String(r.h.asset_id || "").toLowerCase().split(":");
    return String(r.h.address || "").toLowerCase() === c || parts[1] === c || parts[2] === c;
  });
}

// -> null when there is no valid attestation with review items; otherwise the assessment.
function assess(bundle, base, verdict, policy = POLICY) {
  if (!verdict || verdict.status !== "valid") return null;
  const payload = bundle && bundle.attestation && bundle.attestation.payload;
  const ri = payload && payload.review_items;
  if (!ri || !Array.isArray(ri.failed_checks)) return null;
  const treasury = base.grossVerified;
  const items = [];
  const excluded = new Set();
  let effect = "none";
  for (const fc of [...ri.failed_checks, ...(ri.conflicted_checks || [])]) {
    const cls = policy.classes[fc.kind];
    const active = !!(cls && cls.active);
    const rows = affectedRows(base, fc.contract);
    const value = rows === null ? null : rows.reduce((s, r) => s + r.fair, 0);
    let materiality = "undetermined";
    if (value !== null && treasury > 0) {
      const share = value / treasury;
      materiality = share >= policy.critical_core_share_threshold ? "critical"
        : value > policy.value_threshold_usd || share > policy.treasury_share_threshold ? "material" : "non_material";
    }
    const itemEffect = !active ? "none" : materiality === "critical" ? "insufficient_data" : materiality === "material" ? "provisional" : "disclose";
    if (active && materiality === "material") for (const r of rows) excluded.add(r.h.asset_id);
    if (RANK[itemEffect] > RANK[effect]) effect = itemEffect;
    items.push({
      failed_check_id: fc.check_id,
      kind: fc.kind,
      subject: fc.subject,
      contract: fc.contract ?? null,
      failure_reason: fc.failure_reason,
      position_value_usd: value === null ? null : Math.round(value * 100) / 100,
      treasury_value_usd: Math.round(treasury * 100) / 100,
      treasury_share: value === null || !(treasury > 0) ? null : Math.round((value / treasury) * 1e6) / 1e6,
      materiality,
      policy_active_for_kind: active,
      score_effect: itemEffect === "insufficient_data" ? "insufficient_data; score null"
        : itemEffect === "provisional" ? `provisional; position excluded from verified value; confidence capped at ${policy.confidence_cap}`
        : itemEffect === "disclose" ? "none (disclosed)" : "none (class not active under this policy)",
    });
  }
  return { policy_id: policy.policy_id, effect, items, excluded };
}

// Holdings of the bundle with the excluded positions taken out of verified value (control relabelled).
function withExclusions(bundle, excluded) {
  if (!excluded || !excluded.size) return bundle;
  return { ...bundle, holdings: (bundle.holdings || []).map((h) => (excluded.has(h.asset_id) ? { ...h, control: "excluded_by_materiality" } : h)) };
}

// Apply the effect to the overall score and confidence (after scoring).
function applyEffect(overallScore, confidence, m, confidenceLabel, policy = POLICY) {
  if (!m || m.effect === "none" || m.effect === "disclose") return { overallScore, confidence };
  if (m.effect === "insufficient_data") {
    return { overallScore: { ...overallScore, score: null, decision_band: null, status: "insufficient_data" }, confidence };
  }
  const os = overallScore.status === "eligible" ? { ...overallScore, decision_band: null, status: "provisional" } : overallScore;
  const capped = Math.min(confidence.score, policy.confidence_cap);
  return { overallScore: os, confidence: { ...confidence, score: capped, label: confidenceLabel(capped) } };
}

// The report's public block (inside `attestation`, outside the signed payload).
function block(m) {
  return { policy_id: m.policy_id, effect: m.effect, assessments: m.items };
}

function sentence(m) {
  if (!m) return "";
  const parts = m.items.map((i) => {
    const v = i.position_value_usd === null ? "value not calculable" : `$${Math.round(i.position_value_usd).toLocaleString("en-US")} of $${Math.round(i.treasury_value_usd).toLocaleString("en-US")}, ${(i.treasury_share * 100).toFixed(2)}%`;
    return `${i.subject} ${i.kind} (${v}): ${i.materiality}${i.policy_active_for_kind ? "" : ", class not active"}`;
  });
  const effect = { none: "no score effect", disclose: "no score effect (disclosed)", provisional: "the report is provisional, the affected positions are excluded from verified value and confidence is capped", insufficient_data: "the score is withheld (insufficient_data)" }[m.effect];
  return `Materiality under policy ${m.policy_id}: ${parts.length ? parts.join("; ") : "no failed checks"}; ${effect}.`;
}

module.exports = { assess, withExclusions, applyEffect, block, sentence, POLICY };
