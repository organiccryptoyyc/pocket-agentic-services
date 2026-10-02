// TCS-6 deterministic scoring core.
//
// Implements methodology/tcs6_scoring_blueprint_v1.json: haircut engine,
// Net Realizable Treasury, D1-D6, hard gates, coverage policy, confidence.
// Pure functions over an evidence bundle (see EVIDENCE.md) — no network, no
// clock reads (as_of comes from the bundle), no LLM. Every numeric field in a
// report traces back to a function in this file.
//
// Where the blueprint gives a range or a qualitative anchor rather than a
// formula, the concrete choice made here is a named constant below and is
// listed in README.md "Methodology choices to confirm".
"use strict";

const METHOD_VERSION = "tcs-6/1.0";

const DIMENSIONS = [
  { id: "D1", name: "Net Realizable Capital Scale", weight_pct: 20 },
  { id: "D2", name: "Liquidity and Operating Runway", weight_pct: 20 },
  { id: "D3", name: "Obligation and Claim Coverage", weight_pct: 15 },
  { id: "D4", name: "Concentration and Stress Resilience", weight_pct: 15 },
  { id: "D5", name: "Capital Productivity and Replenishment", weight_pct: 15 },
  { id: "D6", name: "Control, Governance, and Transparency", weight_pct: 15 },
];

// Blueprint valuation_policy.default_realization_haircut_ranges, in percent.
const HAIRCUT_RANGES = {
  cash_equivalent: [0, 5],
  fiat_stablecoin: [2, 10],
  major_crypto: [5, 20],
  liquid_alt: [15, 40],
  lp_position: [30, 70],
  native_token: [60, 100],
  locked_unverifiable: [50, 100],
};
const ASSET_CLASSES = Object.keys(HAIRCUT_RANGES);

// Position inside a class range: start at the midpoint, each documented
// condition flag (e.g. "depeg_history", "thin_depth", "unlock_pending")
// moves a quarter of the range toward the top. A collector may instead
// supply an explicit haircut_severity in [0,1] with a source_ref.
const HAIRCUT_BASE_SEVERITY = 0.5;
const HAIRCUT_FLAG_STEP = 0.25;

// Tier 0-1 high-quality liquid assets for D2. An asset of these classes only
// counts while none of its documented flags impairs liquidity.
const HQLA_CLASSES = new Set(["cash_equivalent", "fiat_stablecoin", "major_crypto"]);
const HQLA_IMPAIRING_FLAGS = new Set(["redemption_limits", "legal_restriction", "lockup", "unlock_pending", "depeg_active", "thin_depth", "custody_concentration"]);
const isHqla = (h) => HQLA_CLASSES.has(h.asset_class) && !(h.haircut_flags || []).some((f) => HQLA_IMPAIRING_FLAGS.has(f));

// D4 standardized stress library, parameter set published in every report.
// A deliberately severe scenario, not a forecast of expected losses.
const STRESS_SET = {
  id: "tcs6-stress-v1",
  label: "severe stress scenario (not a forecast)",
  price_shock_pct: {
    cash_equivalent: 0,
    fiat_stablecoin: 10, // depeg / issuer scenario
    major_crypto: 50, // large-cap drawdown
    liquid_alt: 70, // long-tail drawdown
    lp_position: 60, // LP / lending / lockup realization shock
    native_token: 80, // severe native-token price and impact shock
    locked_unverifiable: 80,
  },
};
const CONCENTRATION_FAILURE_PCT = 50; // single non-cash asset above this caps D4 at 75
// Two or more non-cash exposures sharing a correlation_group (collector tag,
// e.g. "eth" for ETH/WETH/stETH, "native" for the token and its LPs) that
// together exceed 50% cap D4 lower, since they fail together under stress.
const CORRELATED_FAILURE_PCT = 50;
const CORRELATED_CAP = 60;
// control_coverage below 60%: score allowed but provisional, confidence capped
// below the "medium" label.
const LOW_CONTROL_CONFIDENCE_CAP = 59;

const PRICE_FRESH_MS = 60 * 60 * 1000; // valuation_freshness: 60 minutes
const HOLDINGS_FRESH_MS = 90 * 24 * 60 * 60 * 1000; // valuation_freshness: 90 days
const PRICE_AGREEMENT_PCT = 2; // two sources within 2% count as consistent
const MIN_PEERS = 20; // entity_scope.peer_rule
const STALE_DISCLOSURE_DAYS = 90;

const TIER_QUALITY = { 1: 100, 2: 75, 3: 50, 4: 30, 5: 10 };
const METRIC_STATUS_CONFIDENCE = { verified: 100, single_source: 70, estimated: 50, stale: 40, not_meaningful: 60, insufficient_data: 0 };

const round = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// "linearly interpolate only between stated anchors": anchors are
// [threshold, score] pairs, ascending. Below the first threshold scores
// `below` (the 0 anchor); at/above the last threshold scores the last anchor.
function anchorScore(x, anchors, below = 0) {
  if (x < anchors[0][0]) return below;
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, s0] = anchors[i];
    const [x1, s1] = anchors[i + 1];
    if (x < x1) return s0 + ((x - x0) / (x1 - x0)) * (s1 - s0);
  }
  return anchors[anchors.length - 1][1];
}

const ANCHORS = {
  D1: [[10, 25], [25, 50], [50, 75], [75, 100]], // percentile
  D2: [[3, 25], [6, 50], [12, 75], [24, 100]], // runway months
  D3: [[0.75, 25], [1.0, 50], [1.5, 75], [2.0, 100]], // coverage ratio
  D4: [[0, 25], [35, 50], [55, 75], [75, 100]], // survival pct (x <= 0 handled first)
  D5: [[-50, 25], [0, 50], [25, 75], [75, 100]], // self-funding ratio pct
};

function bandFor(score) {
  if (score >= 85) return "strong";
  if (score >= 70) return "positive";
  if (score >= 55) return "watch";
  if (score >= 40) return "weak";
  return "reject";
}

function confidenceLabel(c) {
  return c >= 80 ? "high" : c >= 60 ? "medium" : "low";
}

// --- valuation --------------------------------------------------------------

function haircutPct(asset) {
  const [lo, hi] = HAIRCUT_RANGES[asset.asset_class];
  const flags = asset.haircut_flags || [];
  if (asset.asset_class === "native_token" && flags.includes("no_orderly_exit")) return 100;
  if (asset.asset_class === "locked_unverifiable" && !asset.realization_path_evidenced) return 100;
  const severity = Number.isFinite(asset.haircut_severity)
    ? clamp(asset.haircut_severity, 0, 1)
    : clamp(HAIRCUT_BASE_SEVERITY + HAIRCUT_FLAG_STEP * flags.length, 0, 1);
  return lo + (hi - lo) * severity;
}

// Fair value and price provenance for one asset. Off-chain disclosed balances
// carry fair_value_usd directly (with their own source); on-chain holdings
// carry quantity + one or more timestamped prices.
function valueAsset(asset, asOfMs) {
  if (Number.isFinite(asset.fair_value_usd)) {
    const obs = ms(asset.holdings_observed_at);
    return { fair: asset.fair_value_usd, price_check: "disclosed", price_fresh: true, holdings_fresh: asOfMs - obs <= HOLDINGS_FRESH_MS };
  }
  const prices = (asset.prices || []).filter((p) => Number.isFinite(p.usd) && p.usd >= 0);
  if (!Number.isFinite(asset.quantity) || prices.length === 0) return null;
  let usd;
  let check;
  if (prices.length === 1) {
    usd = prices[0].usd;
    check = "single_source";
  } else {
    const vals = prices.map((p) => p.usd);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const spreadPct = lo > 0 ? ((hi - lo) / lo) * 100 : hi > 0 ? Infinity : 0;
    if (spreadPct <= PRICE_AGREEMENT_PCT) {
      usd = sum(vals) / vals.length;
      check = "consistent";
    } else {
      usd = lo; // conflict: preserve conservatism, surface as a data gap
      check = "conflict";
    }
  }
  const newestPrice = Math.max(...prices.map((p) => ms(p.observed_at)).filter(Number.isFinite));
  return {
    fair: asset.quantity * usd,
    price_check: check,
    price_fresh: Number.isFinite(newestPrice) && asOfMs - newestPrice <= PRICE_FRESH_MS,
    holdings_fresh: asOfMs - ms(asset.holdings_observed_at) <= HOLDINGS_FRESH_MS,
  };
}

// Anti-double-counting: one economic exposure counted once even when several
// addresses display it (collector tags them with the same exposure_id).
function dedupe(holdings) {
  const seen = new Set();
  return holdings.filter((h) => {
    if (!h.exposure_id) return true;
    if (seen.has(h.exposure_id)) return false;
    seen.add(h.exposure_id);
    return true;
  });
}

function obligationsTotal(obl) {
  if (!obl || !Array.isArray(obl.items)) return null;
  return sum(obl.items, (o) => (o.type === "contingency" ? (o.usd || 0) * clamp(o.probability ?? 1, 0, 1) : o.usd || 0));
}

// Stage 1: everything that depends only on this entity's own evidence.
function computeBase(bundle) {
  const asOfMs = ms(bundle.collected_at);
  const rows = [];
  for (const h of dedupe(bundle.holdings || [])) {
    if (!ASSET_CLASSES.includes(h.asset_class)) continue;
    const v = valueAsset(h, asOfMs);
    if (!v) continue;
    const verified = h.control === "verified";
    const hc = haircutPct(h);
    rows.push({
      h,
      ...v,
      verified,
      haircut_pct: hc,
      adjusted: verified ? v.fair * (1 - hc / 100) : 0, // control_verification_factor is 1 or 0
    });
  }
  const verifiedRows = rows.filter((r) => r.verified);
  const grossReported = sum(rows, (r) => r.fair);
  const grossVerified = sum(verifiedRows, (r) => r.fair);
  const grossAdjusted = sum(verifiedRows, (r) => r.adjusted);
  const obligations = obligationsTotal(bundle.obligations);
  const nrt = obligations === null ? null : grossAdjusted - obligations;
  return { asOfMs, rows, verifiedRows, grossReported, grossVerified, grossAdjusted, obligations, nrt };
}

// --- dimensions -------------------------------------------------------------

function metric(name, value, unit, method, status, source_refs) {
  return { name, value: typeof value === "number" ? round(value) : value, unit, method, status, source_refs: [...new Set(source_refs || [])] };
}

function dim(id, score, status, metrics, extra = {}) {
  const d = DIMENSIONS.find((x) => x.id === id);
  const conf = metrics.length ? sum(metrics, (m) => METRIC_STATUS_CONFIDENCE[m.status] ?? 0) / metrics.length : 0;
  const refs = [...new Set(metrics.flatMap((m) => m.source_refs))];
  return { id, name: d.name, weight_pct: d.weight_pct, score: score === null ? null : round(score, 1), status, confidence: round(conf, 1), primary_metrics: metrics, evidence_refs: refs, ...extra };
}

function holdingsRefs(rows) {
  return rows.flatMap((r) => [...(r.h.source_refs || []), ...(r.h.prices || []).map((p) => p.source_ref).filter(Boolean)]);
}

function valuationStatus(base) {
  if (base.verifiedRows.length === 0) return "insufficient_data";
  if (base.verifiedRows.some((r) => !r.price_fresh || !r.holdings_fresh)) return "stale";
  if (base.verifiedRows.every((r) => r.price_check === "consistent" || r.price_check === "disclosed")) return "verified";
  return "single_source";
}

function d1(base, peerNrts) {
  const vs = valuationStatus(base);
  const refs = holdingsRefs(base.verifiedRows);
  const eligible = peerNrts.filter((x) => Number.isFinite(x));
  let pct = null;
  if (base.nrt !== null && eligible.length >= MIN_PEERS) {
    const less = eligible.filter((x) => x < base.nrt).length;
    const equal = eligible.filter((x) => x === base.nrt).length;
    pct = ((less + 0.5 * equal) / eligible.length) * 100; // mid-rank percentile
  }
  const metrics = [
    metric("gross_adjusted_treasury_usd", base.verifiedRows.length ? base.grossAdjusted : null, "USD", "sum(fair_value * (1 - haircut) * control_factor)", vs, refs),
    metric("net_realizable_treasury_usd", base.nrt, "USD", "gross_adjusted - recorded obligations (contingencies probability-weighted)", base.nrt === null ? "insufficient_data" : vs, refs),
    metric("same_cohort_nrt_percentile", pct, "percentile", `mid-rank within cohort; requires >= ${MIN_PEERS} eligible peers (have ${eligible.length})`, pct === null ? "insufficient_data" : "estimated", []),
  ];
  if (pct === null) return dim("D1", null, "insufficient_data", metrics, { _peers: eligible.length, _pct: null });
  const score = base.nrt <= 0 ? 0 : anchorScore(pct, ANCHORS.D1);
  return dim("D1", score, "complete", metrics, { _peers: eligible.length, _pct: pct });
}

function d2(base, bundle) {
  const hqlaRows = base.verifiedRows.filter((r) => isHqla(r.h));
  const hqla = sum(hqlaRows, (r) => r.adjusted);
  const uses = bundle.cash_uses_12m;
  const refs = holdingsRefs(hqlaRows);
  const vs = valuationStatus(base);
  const usesOk = uses && Number.isFinite(uses.usd) && uses.usd > 0;
  const runway = usesOk ? (12 * hqla) / uses.usd : null;
  const metrics = [
    metric("tier_0_to_1_hqla_usd", base.verifiedRows.length ? hqla : null, "USD", "post-haircut value of cash equivalents, fiat-backed stablecoins, BTC/ETH-class assets; excludes any flagged for redemption limits, legal restriction, lockup, active depeg, thin depth, or custody concentration", vs, refs),
    metric("expected_12m_cash_uses_usd", usesOk ? uses.usd : null, "USD", "documented budget + debt service + unavoidable commitments", usesOk ? uses.status || "single_source" : "insufficient_data", usesOk ? uses.source_refs : []),
    metric("liquidity_runway_months", runway, "months", "12 * hqla / expected_12m_cash_uses", runway === null ? "insufficient_data" : "estimated", [...refs, ...(usesOk ? uses.source_refs || [] : [])]),
  ];
  if (base.verifiedRows.length === 0) return dim("D2", null, "insufficient_data", metrics);
  // Blueprint anchor 0 explicitly covers "no credible cash-use data".
  if (runway === null) return dim("D2", 0, "provisional", metrics);
  return dim("D2", anchorScore(runway, ANCHORS.D2), "complete", metrics);
}

function d3(base, bundle) {
  const obl = bundle.obligations || {};
  const refs = (obl.items || []).flatMap((o) => o.source_refs || []).concat(obl.source_refs || []);
  if (base.obligations === null || obl.visibility === "unknown") {
    return dim("D3", null, "insufficient_data", [
      metric("obligations_due_or_enforceable_usd", null, "USD", "sum of recorded obligations", "insufficient_data", refs),
      metric("claim_coverage_ratio", null, "x", "nrt / obligations", "insufficient_data", []),
    ]);
  }
  const status = obl.visibility === "adequate" ? "complete" : "provisional";
  const oblStatus = obl.visibility === "adequate" ? "verified" : "estimated";
  if (base.obligations === 0) {
    // "report no material known obligations ... rather than manufacturing an infinite ratio"
    const score = base.nrt > 0 && !obl.material_unresolved_claim ? 100 : base.nrt > 0 ? 75 : 0;
    return dim("D3", score, status, [
      metric("obligations_due_or_enforceable_usd", 0, "USD", "no material known obligations in documented legal/contingency evidence", oblStatus, refs),
      metric("net_realizable_treasury_usd", base.nrt, "USD", "see D1", valuationStatus(base), holdingsRefs(base.verifiedRows)),
      metric("claim_coverage_ratio", "no_material_known_obligations", "x", "denominator is zero; ratio not computed", "not_meaningful", refs),
    ]);
  }
  const ratio = base.nrt / base.obligations;
  let score = anchorScore(ratio, ANCHORS.D3);
  if (obl.material_unresolved_claim) score = Math.min(score, 75);
  return dim("D3", score, status, [
    metric("obligations_due_or_enforceable_usd", base.obligations, "USD", "debt + payables + pledge claims + pending distributions + probability-weighted contingencies", oblStatus, refs),
    metric("net_realizable_treasury_usd", base.nrt, "USD", "see D1", valuationStatus(base), holdingsRefs(base.verifiedRows)),
    metric("claim_coverage_ratio", ratio, "x", "nrt / obligations", "estimated", refs),
  ]);
}

function d4(base) {
  const rows = base.verifiedRows;
  if (rows.length === 0 || base.nrt === null) {
    return dim("D4", null, "insufficient_data", [metric("nrt_survival_pct", null, "pct", STRESS_SET.id, "insufficient_data", [])]);
  }
  const total = base.grossVerified;
  const weights = rows.map((r) => (total > 0 ? r.fair / total : 0));
  const top = rows.reduce((best, r, i) => (weights[i] > best.w ? { w: weights[i], r } : best), { w: 0, r: null });
  const nativeW = sum(rows.filter((r) => r.h.asset_class === "native_token"), (r) => (total > 0 ? r.fair / total : 0));
  const hhi = sum(weights, (w) => (w * 100) ** 2);
  const postStressAdjusted = sum(rows, (r) => r.fair * (1 - STRESS_SET.price_shock_pct[r.h.asset_class] / 100) * (1 - r.haircut_pct / 100));
  const postNrt = postStressAdjusted - base.obligations;
  const survival = base.nrt > 0 ? (postNrt / base.nrt) * 100 : 0;
  let score = survival <= 0 ? 0 : anchorScore(survival, ANCHORS.D4);
  const topIsCash = top.r && (top.r.h.asset_class === "cash_equivalent" || top.r.h.asset_class === "fiat_stablecoin");
  const concentrationFailure = top.w * 100 > CONCENTRATION_FAILURE_PCT && !topIsCash;
  if (concentrationFailure) score = Math.min(score, 75);

  const groups = new Map();
  rows.forEach((r, i) => {
    const g = r.h.correlation_group;
    if (!g || r.h.asset_class === "cash_equivalent" || r.h.asset_class === "fiat_stablecoin") return;
    const cur = groups.get(g) || { w: 0, n: 0 };
    groups.set(g, { w: cur.w + weights[i], n: cur.n + 1 });
  });
  const worstGroup = [...groups.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].w - a[1].w)[0] || null;
  const correlatedFailure = !!worstGroup && worstGroup[1].w * 100 > CORRELATED_FAILURE_PCT;
  if (correlatedFailure) score = Math.min(score, CORRELATED_CAP);

  const vs = valuationStatus(base);
  const refs = holdingsRefs(rows);
  const shocks = Object.entries(STRESS_SET.price_shock_pct).map(([k, v]) => `${k} -${v}%`).join(", ");
  return dim("D4", score, "complete", [
    metric("top_1_asset_weight_pct", top.w * 100, "pct", "largest verified exposure / gross verified fair value", vs, refs),
    metric("native_token_weight_pct", nativeW * 100, "pct", "native-token fair value / gross verified fair value", vs, refs),
    metric("largest_correlated_group_weight_pct", worstGroup ? worstGroup[1].w * 100 : 0, "pct", `combined weight of the largest group of 2+ non-cash exposures sharing a correlation_group${worstGroup ? ` ('${worstGroup[0]}')` : ""}; above ${CORRELATED_FAILURE_PCT}% caps D4 at ${CORRELATED_CAP}`, vs, refs),
    metric("herfindahl_hirschman_index", hhi, "index_0_10000", "sum of squared percentage weights", vs, refs),
    metric("post_stress_nrt_usd", postNrt, "USD", `${STRESS_SET.id}, ${STRESS_SET.label}: ${shocks}; haircuts re-applied after shock`, "estimated", refs),
    metric("nrt_survival_pct", survival, "pct", `post_stress_nrt / pre_stress_nrt * 100 under the ${STRESS_SET.label}`, "estimated", refs),
  ], { _concentrationFailure: concentrationFailure, _correlatedFailure: correlatedFailure, _correlatedGroup: worstGroup && worstGroup[0], _correlatedWeight: worstGroup ? worstGroup[1].w * 100 : 0, _topWeight: top.w * 100, _nativeWeight: nativeW * 100 });
}

function d5(bundle) {
  const f = bundle.flows_12m;
  const ok = f && Number.isFinite(f.recurring_treasury_inflows_usd) && Number.isFinite(f.controllable_cash_uses_usd) && f.controllable_cash_uses_usd > 0;
  const refs = (f && f.source_refs) || [];
  if (!ok) {
    return dim("D5", null, "insufficient_data", [metric("self_funding_ratio", null, "pct", "(inflows - uses) / uses", "insufficient_data", refs)]);
  }
  const net = f.recurring_treasury_inflows_usd - f.controllable_cash_uses_usd;
  const ratioPct = (net / f.controllable_cash_uses_usd) * 100;
  let score = anchorScore(ratioPct, ANCHORS.D5);
  if (!f.repeatable) score = Math.min(score, 75);
  const st = f.status || "single_source";
  return dim("D5", score, "complete", [
    metric("trailing_12m_recurring_treasury_inflows_usd", f.recurring_treasury_inflows_usd, "USD", "income verifiably accruing to the treasury only", st, refs),
    metric("trailing_12m_controllable_cash_uses_usd", f.controllable_cash_uses_usd, "USD", "documented controllable spend", st, refs),
    metric("net_treasury_flow_usd", net, "USD", "inflows - uses", "estimated", refs),
    metric("self_funding_ratio", ratioPct, "pct", "(inflows - uses) / uses * 100", "estimated", refs),
  ]);
}

// D6 has qualitative anchors only, so it is a step rubric, not interpolated.
function d6(base, bundle) {
  const g = bundle.governance;
  const refs = (g && g.source_refs) || [];
  if (!g) return dim("D6", null, "insufficient_data", [metric("verified_control_value_pct", null, "pct", "verified / reported gross value", "insufficient_data", [])]);
  const vcp = base.grossReported > 0 ? (base.grossVerified / base.grossReported) * 100 : null;
  const offchainTotal = sum(base.rows.filter((r) => r.h.bucket === "offchain"), (r) => r.fair);
  const offchainPct = base.grossReported > 0 ? (offchainTotal / base.grossReported) * 100 : null;
  const recon = Number.isFinite(g.reconciliation_pct) ? g.reconciliation_pct : null;
  const age = Number.isFinite(g.disclosure_age_days) ? g.disclosure_age_days : null;
  const msig = g.multisig || null;
  const visibleControls = !!(g.timelock || (msig && msig.threshold >= 2 && msig.threshold > msig.signers / 2));
  const controlsText = msig ? `${msig.threshold}-of-${msig.signers} multisig${g.timelock ? " + timelock" : ""}` : g.timelock ? "timelock" : "none evidenced";

  let score;
  let rule;
  if (!g.control_known || g.contradictory) [score, rule] = [0, "control unknown or contradictory"];
  else if (recon === null || recon < 60 || age === null || age > STALE_DISCLOSURE_DAYS || g.governance_opaque) [score, rule] = [25, `reconciliation <60%, disclosure older than ${STALE_DISCLOSURE_DAYS}d or missing, or governance opaque`];
  else if (recon >= 95 && g.independent_attestation && visibleControls && g.has_treasury_policy && g.governance_transparent) [score, rule] = [100, "reconciliation >=95%, independent attestation, visible controls, documented policy, transparent governance"];
  else if (recon >= 80 && visibleControls && g.has_treasury_policy) [score, rule] = [75, "reconciliation >=80%, visible controls, documented policy"];
  else [score, rule] = [50, "identifiable wallets with partial disclosure"];

  const yn = (b) => (b ? "yes" : "no");
  const st = g.status || "single_source";
  const evidence = [
    ["control_known", yn(g.control_known)],
    ["control_contradictory", yn(g.contradictory)],
    ["independent_attestation", yn(g.independent_attestation)],
    ["documented_treasury_policy", yn(g.has_treasury_policy)],
    ["timelock_present", yn(g.timelock)],
    ["multisig_threshold", msig ? `${msig.threshold}-of-${msig.signers}` : "none"],
    ["governance_transparent", yn(g.governance_transparent)],
    ["governance_opaque", yn(g.governance_opaque)],
  ].map(([n, v]) => metric(n, v, "flag", "D6 rubric input, as evidenced at collection time", st, refs));
  return dim("D6", score, "complete", [
    metric("verified_control_value_pct", vcp, "pct", "verified-control fair value / reported gross fair value", vcp === null ? "insufficient_data" : "estimated", holdingsRefs(base.rows)),
    metric("offchain_disclosure_value_pct", offchainPct, "pct", "off-chain disclosed fair value / reported gross fair value", offchainPct === null ? "insufficient_data" : "estimated", refs),
    metric("address_or_custody_reconciliation_pct", recon, "pct", "collector reconciliation of disclosed vs observed value", recon === null ? "insufficient_data" : st, refs),
    metric("disclosure_age_days", age, "days", "age of most recent treasury disclosure at as_of", age === null ? "insufficient_data" : st, refs),
    metric("treasury_policy_and_multisig_controls", `${controlsText}; treasury policy ${g.has_treasury_policy ? "documented" : "not documented"}`, "text", "rubric anchors 0/25/50/75/100 per blueprint D6", st, refs),
    ...evidence,
    metric("d6_rubric_step", `${score}: ${rule}`, "text", "first rubric rule satisfied, checked from 0 upward", "estimated", refs),
  ]);
}

// --- gates, coverage, confidence -------------------------------------------

function gates(entity, base, bundle, blockedSources) {
  const out = [];
  const idOk = entity.scoreable && (entity.registry_status === "verified" || entity.registry_status === "partially_verified");
  out.push({ id: "entity_identity", status: idOk ? "pass" : "fail", evidence_refs: [], effect: idOk ? "Entity perimeter is distinguishable from user funds and unrelated wallets." : "Registry record not yet vetted for scoring; no overall score issued." });

  const vcp = base.grossReported > 0 ? (base.grossVerified / base.grossReported) * 100 : null;
  out.push({
    id: "control_coverage",
    status: vcp !== null && vcp >= 60 ? "pass" : "unknown_gate",
    evidence_refs: [],
    effect: vcp === null ? "No reported holdings; unknown holdings are not treated as zero or as verified." : `${round(vcp, 1)}% of reported gross value has verified control evidence (threshold 60%).${vcp < 60 ? ` Score allowed but provisional; confidence capped at ${LOW_CONTROL_CONFIDENCE_CAP}.` : ""}`,
  });

  const stale = base.verifiedRows.filter((r) => !r.price_fresh || !r.holdings_fresh);
  out.push({
    id: "valuation_freshness",
    status: base.verifiedRows.length && stale.length === 0 ? "pass" : "fail",
    evidence_refs: [],
    effect: stale.length ? `${stale.length} verified position(s) have prices older than 60 minutes or holdings older than 90 days at as_of; affected metrics marked stale and confidence reduced.` : base.verifiedRows.length ? "All verified positions priced within 60 minutes and holdings within 90 days of as_of." : "No verified positions to value.",
  });

  const vis = (bundle.obligations && bundle.obligations.visibility) || "unknown";
  const bounded = !!(bundle.obligations && bundle.obligations.bounded);
  out.push({
    id: "obligation_visibility",
    status: vis === "adequate" ? "pass" : vis === "partial" ? "fail" : "unknown_gate",
    evidence_refs: (bundle.obligations && bundle.obligations.source_refs) || [],
    effect: vis === "adequate" ? "Known debt, pledges, payables, and commitments captured." : vis === "partial" && bounded ? "Obligations partially visible with an explicit bound; provisional score only." : "Unobserved obligation risk is not bounded; overall score withheld.",
  });

  out.push({
    id: "source_rights",
    status: "pass",
    evidence_refs: [],
    effect: blockedSources.length ? `${blockedSources.length} source(s) not cleared for customer delivery were withheld from this report; delivered content is derived values and citations only.` : "All delivered sources cleared for derived output; no raw vendor payloads delivered.",
  });
  return out;
}

function overall(dims, gateList, penalties, obligationsBounded) {
  const g = Object.fromEntries(gateList.map((x) => [x.id, x]));
  const available = dims.filter((d) => d.score !== null);
  const coverage = sum(available, (d) => d.weight_pct);
  const withheld =
    g.entity_identity.status !== "pass" ||
    (g.obligation_visibility.status !== "pass" && !(g.obligation_visibility.status === "fail" && obligationsBounded)) ||
    coverage < 60;
  if (withheld) return { score: null, coverage_pct: coverage, decision_band: null, status: "insufficient_data", method_version: METHOD_VERSION };
  const base = sum(available, (d) => d.weight_pct * d.score) / coverage;
  const penaltyPts = sum(penalties || [], (p) => (Number.isFinite(p.points) ? p.points : 0));
  const final = Math.round(clamp(base - penaltyPts, 0, 100));
  const provisional = coverage < 80 || g.control_coverage.status !== "pass" || g.obligation_visibility.status !== "pass";
  return {
    score: final,
    coverage_pct: coverage,
    decision_band: provisional ? null : bandFor(final),
    status: provisional ? "provisional" : "eligible",
    method_version: METHOD_VERSION,
  };
}

function confidence(base, coveragePct, sources, controlCoveragePass = true) {
  const sourceQuality = sources.length ? sum(sources, (s) => TIER_QUALITY[s.source_tier] || 0) / sources.length : 0;
  const v = base.grossVerified;
  const consistencyPts = { consistent: 100, disclosed: 100, single_source: 60, conflict: 0 };
  const consistency = v > 0 ? sum(base.verifiedRows, (r) => (r.fair / v) * consistencyPts[r.price_check]) : 0;
  const recency = v > 0 ? sum(base.verifiedRows, (r) => (r.price_fresh && r.holdings_fresh ? r.fair / v : 0)) * 100 : 0;
  const raw = 0.35 * sourceQuality + 0.3 * coveragePct + 0.2 * consistency + 0.15 * recency;
  const score = controlCoveragePass ? raw : Math.min(raw, LOW_CONTROL_CONFIDENCE_CAP);
  return {
    score: round(score, 1),
    label: confidenceLabel(score),
    source_quality: round(sourceQuality, 1),
    data_coverage: round(coveragePct, 1),
    cross_source_consistency: round(consistency, 1),
    recency_fit: round(recency, 1),
  };
}

function dataCoverage(base, bundle) {
  const r = base.grossReported;
  const v = base.grossVerified;
  const offchain = sum(base.rows.filter((x) => x.h.bucket === "offchain"), (x) => x.fair);
  const fresh = sum(base.verifiedRows.filter((x) => x.price_fresh), (x) => x.fair);
  const vis = (bundle.obligations && bundle.obligations.visibility) || "unknown";
  return {
    verified_control_value_pct: r > 0 ? round((v / r) * 100, 1) : null,
    offchain_disclosed_value_pct: r > 0 ? round((offchain / r) * 100, 1) : null,
    fresh_price_value_pct: v > 0 ? round((fresh / v) * 100, 1) : null,
    obligation_visibility_status: ["adequate", "partial"].includes(vis) ? vis : "unknown",
  };
}

module.exports = {
  METHOD_VERSION, DIMENSIONS, HAIRCUT_RANGES, ASSET_CLASSES, STRESS_SET, MIN_PEERS, CORRELATED_CAP, LOW_CONTROL_CONFIDENCE_CAP,
  anchorScore, bandFor, haircutPct, valueAsset, computeBase,
  d1, d2, d3, d4, d5, d6, gates, overall, confidence, dataCoverage, round,
};
