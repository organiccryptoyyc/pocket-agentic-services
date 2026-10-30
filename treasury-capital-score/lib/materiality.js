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
//
// 1.2 divergent scoring (owner 2026-10-30): a signed check that disagrees with the headline value changes the
// score, citing the check. Three measures: materiality (flag vs cap) on the gross affected position; score
// credit from the verified available value; the large-divergence status on the unavailable or unverified part.
//   realizability_control      failed exit checks: liquid capital (D2) counts position x measured withdrawable
//                              fraction (the `available` map); the rest is reported, never deleted
//   price_comparison           > 5% on a material position: provisional, capped; <= 5%: flag only
//   disclosure_reconciliation  the reported-vs-observed gap is the affected value
//   naming / retrieval         flag only when ownership is established / the failure is transport only
// A large divergence (policy.large_divergence) sets review_required; it is provisional, so it never reads `ready`.
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

// --- 1.2 divergent scoring ---------------------------------------------------------------------------------

const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const share = (v, treasury) => (v === null || !(treasury > 0) ? null : Math.round((v / treasury) * 1e6) / 1e6);
const pctText = (r) => `${Number((r * 100).toPrecision(3))}%`;

// Large divergence: the unavailable or unverified part (`part`) above the value or treasury-share line, or a
// position that is itself >= position_share of counted treasury value.
function isLarge(part, gross, treasury, policy) {
  const ld = policy.large_divergence;
  if (!ld) return false;
  return part > ld.value_usd || (treasury > 0 && (part / treasury > ld.treasury_share || gross / treasury >= ld.position_share));
}

// Signed exit checks by position ("chain:token:holder", lowercase): the latest of each prefix.
function exitChecks(payload) {
  const by = new Map();
  for (const c of payload.checks || []) {
    const m = /^exit\.(available|simulated):(.+)$/.exec(c.field || "");
    if (!m) continue;
    const id = m[2].toLowerCase();
    if (!by.has(id)) by.set(id, {});
    by.get(id)[m[1]] = c;
  }
  return by;
}

const RESTRICTED_AS = { backs_a_loan: "encumbered", redemptions_disabled: "restricted", insufficient_liquidity: "illiquid" };

// Failed exit checks -> realizability items. Each gets a withdrawable fraction when the chain measured one.
function realizability(base, payload) {
  const rows = new Map(base.verifiedRows.map((r) => [String(r.h.asset_id || "").toLowerCase(), r]));
  const out = [];
  const loans = new Map(); // chain:holder -> { health, items }: one loan per borrower account
  for (const [id, ck] of exitChecks(payload)) {
    const av = ck.available && ck.available.status === "failed" ? ck.available : null;
    const sim = ck.simulated && ck.simulated.status === "failed" ? ck.simulated : null;
    const row = rows.get(id);
    if ((!av && !sim) || !row) continue;
    const sm = (sim && sim.measure) || {};
    const ratio = av && av.measure && Number.isFinite(av.measure.exitable_ratio) ? av.measure.exitable_ratio : null;
    const it = { row, checks: [av, sim].filter(Boolean), cause: sm.cause || (ratio !== null ? "insufficient_liquidity" : "unexplained"), fraction: null, basis: null };
    if (it.cause === "redemptions_disabled") {
      it.fraction = 0;
      it.basis = "the vault has redemptions switched off, so nothing can be withdrawn now";
    } else if (it.cause === "backs_a_loan") {
      const [chain, , holder] = id.split(":");
      const k = `${chain}:${holder}`;
      if (!loans.has(k)) loans.set(k, { health: null, items: [] });
      const g = loans.get(k);
      g.health = g.health || sm.loan_health || null;
      g.items.push(it);
    } else if (ratio !== null) {
      it.cause = "insufficient_liquidity";
      it.fraction = ratio;
      it.basis = `the pool or vault holds ${pctText(ratio)} of the position in withdrawable cash`;
    } else {
      it.basis = "the full withdrawal reverted for a reason the chain does not quantify, so there is no measurable basis for a discount";
    }
    out.push(it);
  }
  // Collateral: the loan's measured need (debt / liquidation threshold) is assigned to the positions whose full
  // withdrawal reverts, largest first. Not measured: the whole position counts as encumbered.
  for (const g of loans.values()) {
    const need = g.health && Number.isFinite(g.health.encumbered_usd) ? g.health.encumbered_usd : null;
    let left = need;
    for (const it of g.items.sort((a, b) => b.row.fair - a.row.fair)) {
      if (left === null) {
        it.fraction = 0;
        it.basis = "the position backs a loan whose collateral need was not measured, so the whole position is treated as encumbered";
        continue;
      }
      const enc = Math.min(it.row.fair, left);
      left -= enc;
      it.fraction = it.row.fair > 0 ? 1 - enc / it.row.fair : 0;
      it.loan_health = g.health;
      it.basis = `the position backs a loan: ${usdText(enc)} of it keeps the loan at a health factor of 1 `
        + `(debt ${usdText(g.health.debt_usd)} / liquidation threshold ${pctText(g.health.liquidation_threshold)}, read on chain at block ${g.health.block_number})`;
    }
  }
  return out;
}

function realizabilityItem(it, treasury, policy) {
  const { row } = it;
  const gross = row.fair;
  const materiality = materialityOf(gross, treasury, policy);
  const flag = materiality === "non_material";
  const measured = it.fraction !== null;
  const available = measured ? gross * it.fraction : null;
  const part = measured ? gross - available : gross;
  const large = !flag && isLarge(part, gross, treasury, policy);
  const treatment = flag ? "flag_only" : measured ? "evidence_based_discount" : "confidence_cap";
  const symbol = row.h.symbol || "position";
  const label = RESTRICTED_AS[it.cause] || "unverified";
  const checks = it.checks.map((c) => c.check_id).sort();
  const statement = `The ${symbol} position (${usdText(gross)}) cannot be fully withdrawn now: ${it.basis}. `
    + (flag ? "It is below the materiality thresholds: disclosed, no score effect."
      : measured ? `Liquid capital counts ${usdText(available)} of it; ${usdText(part)} is reported as ${label}, not deleted. The report is provisional and confidence is capped at ${policy.confidence_cap}.`
      : `No discount is applied; the report is provisional and confidence is capped at ${policy.confidence_cap}.`)
    + (large ? " The divergence is large, so the report needs review and cannot read ready." : "");
  return {
    item: {
      failed_check_id: checks[0], check_ids: checks, kind: "realizability_control",
      subject: `${symbol} at ${String(row.h.address || "").toLowerCase()}`,
      contract: (String(row.h.asset_id || "").split(":")[1] || "").toLowerCase() || null,
      failure_reason: it.cause,
      position_value_usd: round2(gross), treasury_value_usd: round2(treasury), treasury_share: share(gross, treasury),
      materiality, policy_active_for_kind: true,
      score_effect: flag ? "none (flag only)" : measured ? `provisional; liquid capital counts the available ${usdText(available)}; confidence capped at ${policy.confidence_cap}; no penalty points`
        : `provisional; confidence capped at ${policy.confidence_cap}; no discount (no measurable basis)`,
      asset_id: row.h.asset_id, treatment,
      withdrawable_fraction: measured ? Math.round(it.fraction * 1e6) / 1e6 : null,
      gross_observed_value_usd: round2(gross),
      available_value_usd: round2(available),
      unavailable_value_usd: round2(part), unavailable_as: label,
      ...(it.loan_health ? { loan_health: it.loan_health } : {}),
      evidence_hashes: it.checks.map((c) => c.evidence_hash).filter(Boolean),
      large_divergence: large, review_required: large, confidence: flag ? "unchanged" : "capped",
      statement,
    },
    effect: flag ? "disclose" : "provisional",
    fraction: !flag && measured ? it.fraction : null,
  };
}

// Reported vs observed treasury total: the gap is the affected value; the observed value is never rewritten.
function reconciliationItem(c, treasury, policy) {
  const observed = Number(c.our_value);
  const reported = c.other_value && Number(c.other_value.usd);
  const gap = Number.isFinite(observed) && Number.isFinite(reported) ? Math.abs(observed - reported) : null;
  const materiality = materialityOf(gap, treasury, policy);
  const flag = materiality === "non_material";
  const large = gap === null || (!flag && isLarge(gap, 0, treasury, policy));
  const asOf = (c.other_value && c.other_value.as_of) || null;
  return {
    item: {
      failed_check_id: c.check_id, check_ids: [c.check_id], kind: "disclosure_reconciliation", subject: c.label || "reported vs observed treasury total",
      contract: null, failure_reason: "reported_vs_observed_gap",
      position_value_usd: round2(gap), treasury_value_usd: round2(treasury), treasury_share: share(gap, treasury),
      materiality, policy_active_for_kind: true,
      score_effect: flag ? "none (flag only)" : `provisional; confidence capped at ${policy.confidence_cap}; observed value kept (never rewritten to match the report)`,
      treatment: flag ? "flag_only" : "confidence_cap",
      observed_value_usd: round2(observed), reported_value_usd: round2(reported), reported_as_of: asOf, gap_usd: round2(gap),
      evidence_hashes: [c.evidence_hash].filter(Boolean),
      large_divergence: large, review_required: large, confidence: flag ? "unchanged" : "capped",
      statement: `The protocol reported ${usdText(reported)}${asOf ? ` as of ${asOf}` : ""}; we observe ${usdText(observed)} for the same scope, a gap of ${gap === null ? "an amount that cannot be calculated" : usdText(gap)}. `
        + `The observed value is kept. ${flag ? "The gap is below the materiality thresholds: disclosed, no score effect." : `The report is provisional and confidence is capped at ${policy.confidence_cap}.`}`
        + (large ? " The gap is large, so the report needs review and cannot read ready." : ""),
    },
    effect: flag ? "disclose" : "provisional",
  };
}

// Price disagreement, from a signed price_comparison check or from the engine's own readings of one holding.
function priceItem(subject, checkId, rows, spreadPct, readings, hashes, treasury, policy) {
  const gross = rows.reduce((s, r) => s + r.fair, 0);
  const over = spreadPct > policy.price_materiality_threshold * 100;
  const materiality = materialityOf(gross, treasury, policy);
  const flag = !over || materiality === "non_material";
  const large = !flag && isLarge(gross, gross, treasury, policy);
  return {
    item: {
      failed_check_id: checkId, check_ids: [checkId], kind: "price_comparison", subject,
      contract: rows.length ? (String(rows[0].h.asset_id || "").split(":")[1] || "").toLowerCase() || null : null,
      failure_reason: over ? "price_spread_above_5pct" : "price_spread_2_to_5pct",
      position_value_usd: round2(gross), treasury_value_usd: round2(treasury), treasury_share: share(gross, treasury),
      materiality, policy_active_for_kind: true,
      score_effect: flag ? "none (flag only; the lower reading is used and the position gets no consistency points)"
        : `provisional; confidence capped at ${policy.confidence_cap}; valued at the lower reading, both readings kept`,
      treatment: flag ? "flag_only" : "confidence_cap",
      price_spread_pct: Math.round(spreadPct * 1e4) / 1e4, price_readings: readings,
      evidence_hashes: hashes, large_divergence: large, review_required: large, confidence: flag ? "unchanged" : "capped",
    },
    effect: flag ? "disclose" : "provisional",
  };
}

// -> null when there is no valid attestation with review items, classification conflicts or divergences;
// otherwise the assessment.
function assess(bundle, base, verdict, policy = POLICY) {
  if (!verdict || verdict.status !== "valid") return null;
  const payload = bundle && bundle.attestation && bundle.attestation.payload;
  const ri = payload && payload.review_items;
  const found = payload ? conflicts(bundle, base, payload, policy) : [];
  const treasury = base.grossVerified;
  const active = (k) => !!(policy.classes[k] && policy.classes[k].active);
  const divergent = [];
  if (payload && active("realizability_control")) for (const it of realizability(base, payload)) divergent.push(realizabilityItem(it, treasury, policy));
  if (payload && active("disclosure_reconciliation")) {
    for (const c of payload.checks || []) {
      if (c.kind === "disclosure_reconciliation" && (c.status === "conflicted" || c.status === "failed")) divergent.push(reconciliationItem(c, treasury, policy));
    }
  }
  const priced = new Set();
  if (payload && active("price_comparison")) {
    for (const c of payload.checks || []) {
      if (c.kind !== "price_comparison" || !(c.status === "conflicted" || c.status === "failed") || !Number.isFinite(c.delta_pct)) continue;
      const contract = (String(c.field || "").split(":")[2] || "").toLowerCase();
      const rows = base.verifiedRows.filter((r) => String(r.h.asset_id || "").toLowerCase().split(":")[1] === contract);
      if (!rows.length) continue;
      rows.forEach((r) => priced.add(r.h.asset_id));
      divergent.push(priceItem(c.label || c.field, c.check_id, rows, c.delta_pct,
        [{ source: "ours", value: c.our_value }, { source: c.source, value: c.other_value }], [c.evidence_hash].filter(Boolean), treasury, policy));
    }
  }
  if (active("price_comparison")) {
    for (const r of base.verifiedRows) {
      if (r.price_check !== "conflict" || priced.has(r.h.asset_id)) continue;
      divergent.push(priceItem(`${r.h.symbol || "position"} at ${String(r.h.address || "").toLowerCase()}`, `price_comparison|holding:${r.h.asset_id}|engine`, [r], r.price_spread_pct,
        (r.h.prices || []).map((p) => ({ source: p.source_ref, usd: p.usd, observed_at: p.observed_at })), [], treasury, policy));
    }
  }
  if ((!ri || !Array.isArray(ri.failed_checks)) && !found.length && !divergent.length) return null;
  const items = [];
  const excluded = new Set();
  const available = new Map();
  let effect = "none";
  for (const d of divergent) {
    items.push(d.item);
    if (RANK[d.effect] > RANK[effect]) effect = d.effect;
    if (Number.isFinite(d.fraction)) available.set(d.item.asset_id, d.fraction);
  }
  for (const cf of found) {
    const item = conflictItem(cf, treasury, policy);
    if (item.score_treatment === "conservative_exclusion") {
      excluded.add(cf.row.h.asset_id);
      effect = RANK.provisional > RANK[effect] ? "provisional" : effect;
    } else if (RANK.disclose > RANK[effect]) effect = "disclose";
    items.push(item);
  }
  for (const fc of [...((ri && ri.failed_checks) || []), ...((ri && ri.conflicted_checks) || [])]) {
    if (HANDLED_ABOVE.has(fc.kind) && active(fc.kind)) continue;
    const cls = policy.classes[fc.kind];
    const isActive = !!(cls && cls.active);
    const rows = affectedRows(base, fc.contract, chainOf(fc.check_id));
    const value = rows === null ? null : rows.reduce((s, r) => s + r.fair, 0);
    const materiality = materialityOf(value, treasury, policy);
    // naming: the wallet's control is verified (registry, Safe, governance record), so ownership is established
    // independently of the name: flag only. Naming and retrieval never take a position out of verified value.
    const flagOnly = fc.kind === "naming_control" && rows !== null;
    const excludes = fc.kind === "contract_identity_control";
    const itemEffect = !isActive ? "none" : flagOnly ? "disclose" : materiality === "critical" && fc.kind !== "naming_control" ? "insufficient_data"
      : materiality === "material" || materiality === "undetermined" && fc.kind === "naming_control" ? "provisional" : "disclose";
    if (isActive && excludes && materiality === "material") for (const r of rows) excluded.add(r.h.asset_id);
    if (RANK[itemEffect] > RANK[effect]) effect = itemEffect;
    const large = itemEffect === "provisional" && (value === null || isLarge(value, value, treasury, policy));
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
      policy_active_for_kind: isActive,
      score_effect: itemEffect === "insufficient_data" ? "insufficient_data; score null"
        : itemEffect === "provisional" ? `provisional; ${excludes ? "position excluded from verified value; " : ""}confidence capped at ${policy.confidence_cap}`
        : itemEffect === "disclose" ? (flagOnly ? "none (flag only: ownership established independently of the name)" : "none (disclosed)") : "none (class not active under this policy)",
      ...(isActive ? { treatment: itemEffect === "insufficient_data" ? "withheld" : itemEffect === "provisional" ? (excludes ? "conservative_exclusion" : "confidence_cap") : "flag_only",
        large_divergence: large || itemEffect === "insufficient_data", review_required: large || itemEffect === "insufficient_data" } : {}),
    });
  }
  if (!items.length) return null;
  return { policy_id: policy.policy_id, effect, items, excluded, available, review_required: items.some((i) => i.review_required === true) };
}

const HANDLED_ABOVE = new Set(["realizability_control", "disclosure_reconciliation", "price_comparison"]);

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
