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
const SEVERITY = { none: 0, non_material: 1, undetermined: 2, material: 2.5, critical: 3 }; // a documented material item outranks an undetermined one (same effect)
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

// Upper bounds for unvalued checklist items (owner 2026-11-14, Build C bounding):
//  - a curated bound (unvalued_bounds_usd) counts only with its citation (unvalued_bounds_refs[item]);
//    payables are bounded by one payment cycle of a cited, approved budget;
//  - legal or contingent claims: a dated search (legal_claims_search) of court records, governance
//    forums and news, run within the evidence-age limit; nothing found = $0, each finding counts at
//    its stated amount, a finding without an amount leaves the item undetermined;
//  - scope: the reconciliation gap (reported vs observed, same scope) when the collector reconciled
//    this run; otherwise undetermined;
//  - liabilities listed is the umbrella: bounded only when debt, payables, streams and claims are
//    each covered or bounded, at the sum of their bounds (assessed together, never item by item).
const LEGAL_SOURCE_KINDS = ["court_records", "governance_forum", "news"];

function legalBound(block, asOfMs) {
  const s = block.legal_claims_search;
  if (!s || typeof s !== "object") return null;
  const age = days(asOfMs, s.searched_through);
  const kinds = new Set((Array.isArray(s.sources) ? s.sources : []).map((x) => x && x.kind));
  const refs = Array.isArray(s.source_refs) ? s.source_refs.filter((r) => typeof r === "string") : [];
  if (age === null || age < 0 || age > POLICY.evidence_age.max_age_days || !LEGAL_SOURCE_KINDS.every((k) => kinds.has(k)) || !refs.length) {
    return { usd: NaN, basis: `legal claims search not usable (searched through ${s.searched_through || "n/a"}; needs ${LEGAL_SOURCE_KINDS.join(", ")} within ${POLICY.evidence_age.max_age_days} days, cited)`, refs };
  }
  const findings = Array.isArray(s.findings) ? s.findings.filter((f) => f && typeof f === "object") : [];
  const unvalued = findings.filter((f) => !Number.isFinite(f.usd));
  if (unvalued.length) return { usd: NaN, basis: `legal claims search through ${s.searched_through}: ${unvalued.length} finding(s) without a stated amount`, refs };
  const usd = findings.reduce((t, f) => t + f.usd, 0);
  return { usd, basis: findings.length ? `legal claims search through ${s.searched_through}: ${findings.length} finding(s) at their stated amounts` : `legal claims search through ${s.searched_through}: no claims found`, refs };
}

function scopeBound(bundle) {
  const g = bundle.governance || {};
  const rec = g.reconciliation;
  if (!rec || !Number.isFinite(g.reconciliation_pct)) return null;
  const refs = Array.isArray(rec.source_refs) ? rec.source_refs.filter((r) => typeof r === "string") : [];
  if (rec.mode === "quantity") {
    const gapQty = Math.abs(Number(rec.reported_quantity) - Number(rec.observed_quantity_same_scope));
    const h = (bundle.holdings || []).find((x) => x && (x.symbol || "").toUpperCase() === String(rec.unit || "").toUpperCase() && Array.isArray(x.prices) && x.prices.length && Number.isFinite(x.prices[0].usd));
    if (!Number.isFinite(gapQty) || !h) return { usd: NaN, basis: `reconciliation gap of ${Number.isFinite(gapQty) ? gapQty.toFixed(2) : "n/a"} ${rec.unit} could not be priced`, refs };
    return { usd: gapQty * h.prices[0].usd, basis: `reconciliation gap ${gapQty.toFixed(2)} ${rec.unit} (reported ${rec.reported_as_of}) at the bundle price`, refs };
  }
  const gap = Math.abs(Number(rec.reported_total_usd) - Number(rec.observed_usd_same_scope));
  return Number.isFinite(gap) ? { usd: gap, basis: `reconciliation gap: reported ${rec.reported_as_of} vs observed, same scope`, refs } : null;
}

function gapBounds(bundle, block, asOfMs) {
  const curated = block.unvalued_bounds_usd && typeof block.unvalued_bounds_usd === "object" ? block.unvalued_bounds_usd : {};
  const citeMap = block.unvalued_bounds_refs && typeof block.unvalued_bounds_refs === "object" ? block.unvalued_bounds_refs : {};
  const out = {};
  for (const [k] of CHECKS) {
    const usd = Number(curated[k]);
    const refs = Array.isArray(citeMap[k]) ? citeMap[k].filter((r) => typeof r === "string") : [];
    if (Number.isFinite(usd) && usd >= 0 && refs.length) out[k] = { usd, basis: "curated upper bound", refs };
    else if (Number.isFinite(usd)) out[k] = { usd: NaN, basis: "curated bound without a citation (not used)", refs: [] };
  }
  const legal = legalBound(block, asOfMs);
  if (legal && !(out.legal_or_contingent_claims_covered && Number.isFinite(out.legal_or_contingent_claims_covered.usd))) out.legal_or_contingent_claims_covered = legal;
  const scope = scopeBound(bundle);
  if (scope && !(out.scope_reconciled && Number.isFinite(out.scope_reconciled.usd))) out.scope_reconciled = scope;
  if (!(out.liabilities_listed && Number.isFinite(out.liabilities_listed.usd))) {
    const parts = ["debt_covered", "payables_covered", "streams_and_grants_covered", "legal_or_contingent_claims_covered"];
    const vals = parts.map((k) => (block[k] === true ? 0 : out[k] ? out[k].usd : NaN));
    out.liabilities_listed = vals.every(Number.isFinite)
      ? { usd: vals.reduce((t, v) => t + v, 0), basis: "sum of the debt, payables, streams and claims bounds (each covered or bounded)", refs: [] }
      : { usd: NaN, basis: "not every liability category is covered or bounded", refs: [] };
  }
  return out;
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
  const bounds = gapBounds(bundle, block, asOfMs);
  const reasons = missing.map(([k, label]) => {
    const b = bounds[k] || { usd: NaN, basis: null };
    let m = gapMateriality(b.usd, treasuryUsd);
    // A reconciliation gap is not an unlisted liability, and tcs6-materiality already caps confidence for
    // it: as a scope bound it can be material, never critical (it never withholds the score on its own).
    if (k === "scope_reconciled" && m === "critical" && b.basis && b.basis.startsWith("reconciliation gap")) m = "material";
    return { item: k, description: label, upper_bound_usd: Number.isFinite(b.usd) ? b.usd : null, bound_basis: b.basis, bound_refs: b.refs || [], materiality: m };
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

// The obligations the score counts, itemized so a buyer sees each one. An item with usd 0 is recorded but counts
// nothing (for example a debt already netted in a position's value). Display only: the total comes from scoring.
function listed(bundle) {
  const items = (bundle.obligations || {}).items;
  if (!Array.isArray(items)) return [];
  return items.filter((i) => i && typeof i === "object").map((i) => ({
    id: typeof i.id === "string" ? i.id : null,
    type: typeof i.type === "string" ? i.type : null,
    what: typeof i.what === "string" ? i.what.slice(0, 400) : null,
    usd: Number.isFinite(i.usd) ? i.usd : null,
    amount: Number.isFinite(i.amount) ? i.amount : null,
    unit: typeof i.unit === "string" ? i.unit.slice(0, 20) : null,
    source_refs: Array.isArray(i.source_refs) ? i.source_refs.filter((r) => typeof r === "string") : [],
  }));
}

// The report block: pre-policy and policy scores side by side (owner: the effect must be auditable).
function block(g, pre, post, discl, items = []) {
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
    listed_items: items,
  };
}

module.exports = { POLICY, POLICY_ID, applies, grade, gapMateriality, disclosed, listed, block };
