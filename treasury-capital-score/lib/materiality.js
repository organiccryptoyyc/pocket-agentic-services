// Materiality policy tcs6-materiality/1.1 (owner decision D18; 1.1 adds classification_conflict, owner 2026-10-29;
// methodology/tcs6_materiality_policy_v1.json).
//
// The Pi signs which checks failed and never decides materiality ("undetermined" in the signed payload).
// This side applies the versioned policy to the failed checks of a *valid* attestation, using the report's
// own counted treasury value:
//
//   affected value  verified positions on the failed check's chain held at the failed contract or of that
//                   token (fair value). The chain matters: a Safe can sit at the same address on several chains.
//   critical        affected / counted treasury value >= critical_core_share_threshold
//   material        affected > value_threshold_usd OR affected / counted > treasury_share_threshold (strict)
//   non_material    otherwise: disclosed, no score effect
//   undetermined    the share can't be computed (no counted treasury value): never assumed immaterial
//
// Only classes marked active are applied (contract identity first); the others are listed as not active.
// Effects: material -> provisional, the affected positions leave verified value, confidence capped;
// critical -> insufficient_data with a null score. Nothing here changes a signed value.
//
// classification_conflict (1.1): a curated-restricted position whose signed exit check passes in full. Material ->
// conservative exclusion (it leaves verified and liquid value), provisional, confidence capped, review required, no
// penalty points; critical is treated as material (the conservative treatment keeps the score reproducible).
"use strict";

const POLICY = require("../methodology/tcs6_materiality_policy_v1.json");

const RANK = { none: 0, disclose: 1, provisional: 2, insufficient_data: 3 };

// The chain name in a check id: "<kind>|<prefix>:<chain>:<address>[:...]|<source>".
function chainOf(checkId) {
  const field = String(checkId || "").split("|")[1] || "";
  const parts = field.split(":");
  return parts.length >= 3 ? parts[1].toLowerCase() : null;
}

function affectedRows(base, contract, chain) {
  const c = String(contract || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(c) || !chain) return null;
  return base.verifiedRows.filter((r) => {
    const parts = String(r.h.asset_id || "").toLowerCase().split(":");
    const hChain = String(r.h.chain || parts[0] || "").toLowerCase();
    if (hChain !== chain) return false;
    return String(r.h.address || "").toLowerCase() === c || parts[1] === c || parts[2] === c;
  });
}

function materialityOf(value, treasury, policy) {
  if (value === null || !(treasury > 0)) return "undetermined";
  const share = value / treasury;
  return share >= policy.critical_core_share_threshold ? "critical"
    : value > policy.value_threshold_usd || share > policy.treasury_share_threshold ? "material" : "non_material";
}

const usdText = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

// Classification conflicts (1.1): a position the curated data restricts while a signed exit check
// (exit.available / exit.simulated, status passed) says the full position can be withdrawn now. Not a
// failed check: two different questions (withdrawable on chain? available treasury capital?), so both
// answers are kept and the conservative one is scored.
function conflicts(bundle, base, payload, policy) {
  const cls = policy.classes.classification_conflict;
  if (!cls || !cls.active || !Array.isArray(payload.checks)) return [];
  const restrictive = new Set(cls.restrictive_flags || []);
  const byAsset = new Map();
  for (const c of payload.checks) {
    const m = /^exit\.(available|simulated):(.+)$/.exec(c.field || "");
    if (!m || c.status !== "passed") continue;
    const id = m[2].toLowerCase();
    if (!byAsset.has(id)) byAsset.set(id, []);
    byAsset.get(id).push(c);
  }
  const out = [];
  for (const r of base.rows) {
    const id = String(r.h.asset_id || "").toLowerCase();
    const flags = (r.h.haircut_flags || []).filter((f) => restrictive.has(f));
    if (!flags.length || !byAsset.has(id)) continue;
    out.push({ row: r, flags, checks: byAsset.get(id) });
  }
  return out;
}

function conflictItem(cf, treasury, policy) {
  const { row, flags, checks } = cf;
  const value = row.fair;
  const materiality = materialityOf(value, treasury, policy);
  const conservative = materiality !== "non_material";
  const symbol = row.h.symbol || "position";
  const statement = `The ${symbol} position has an observed on-chain value of approximately ${usdText(value)}. The chain-level exit check `
    + `indicates that the recorded position is currently withdrawable. Curated protocol data classifies the position as restricted `
    + `(${flags.join(", ")})${row.h.note ? `: ${String(row.h.note).replace(/\.\s*$/, "")}` : ""}. These findings are ${conservative ? "materially " : ""}inconsistent for `
    + `treasury-eligibility purposes. ${conservative
      ? "The position is therefore excluded from verified and liquid treasury value pending classification resolution. The conservative score is retained, the report is marked provisional, and the conflict is preserved for review."
      : "The position is below the materiality thresholds: the conflict is disclosed and preserved for review, with no score effect."}`;
  return {
    failed_check_id: checks.map((c) => c.check_id).sort()[0],
    check_ids: checks.map((c) => c.check_id).sort(),
    kind: "classification_conflict",
    subject: `${symbol} at ${String(row.h.address || "").toLowerCase()}`,
    contract: (String(row.h.asset_id || "").split(":")[1] || "").toLowerCase() || null,
    failure_reason: "classification_conflict",
    position_value_usd: Math.round(value * 100) / 100,
    treasury_value_usd: Math.round(treasury * 100) / 100,
    treasury_share: !(treasury > 0) ? null : Math.round((value / treasury) * 1e6) / 1e6,
    materiality,
    policy_active_for_kind: true,
    score_effect: conservative ? `provisional; position excluded from verified and liquid value (conservative exclusion); confidence capped at ${policy.confidence_cap}; no penalty points`
      : "none (disclosed; review required)",
    asset_id: row.h.asset_id,
    gross_observed_value_usd: Math.round(value * 100) / 100,
    verified_treasury_value_usd: conservative ? 0 : Math.round(row.adjusted * 100) / 100,
    liquid_value_usd: conservative ? 0 : Math.round(row.adjusted * 100) / 100,
    onchain_withdrawal_check: "passed",
    curated_classification: flags,
    classification_status: "conflicted",
    score_treatment: conservative ? "conservative_exclusion" : "disclosed",
    review_required: true,
    confidence: conservative ? "capped" : "unchanged",
    resolution_event: row.h.note ? `the decision named in the curated note: ${String(row.h.note).replace(/\.\s*$/, "")}` : "a curator or governance decision on the position's classification",
    statement,
  };
}

// -> null when there is no valid attestation with review items or classification conflicts; otherwise the assessment.
function assess(bundle, base, verdict, policy = POLICY) {
  if (!verdict || verdict.status !== "valid") return null;
  const payload = bundle && bundle.attestation && bundle.attestation.payload;
  const ri = payload && payload.review_items;
  const found = payload ? conflicts(bundle, base, payload, policy) : [];
  if ((!ri || !Array.isArray(ri.failed_checks)) && !found.length) return null;
  const treasury = base.grossVerified;
  const items = [];
  const excluded = new Set();
  let effect = "none";
  for (const cf of found) {
    const item = conflictItem(cf, treasury, policy);
    if (item.score_treatment === "conservative_exclusion") {
      excluded.add(cf.row.h.asset_id);
      effect = RANK.provisional > RANK[effect] ? "provisional" : effect;
    } else if (RANK.disclose > RANK[effect]) effect = "disclose";
    items.push(item);
  }
  for (const fc of [...((ri && ri.failed_checks) || []), ...((ri && ri.conflicted_checks) || [])]) {
    const cls = policy.classes[fc.kind];
    const active = !!(cls && cls.active);
    const rows = affectedRows(base, fc.contract, chainOf(fc.check_id));
    const value = rows === null ? null : rows.reduce((s, r) => s + r.fair, 0);
    const materiality = materialityOf(value, treasury, policy);
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
