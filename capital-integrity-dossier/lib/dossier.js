// Capital Integrity Dossier: a disclosed multi-call report on one TCS-6 entity (PNF rule D12).
//
//   plan(entity_id)            -> dossier_id pinned to the latest TCS-6 snapshot, the sections, calls_required,
//                                 the price estimate and the buyer notice
//   section(dossier_id, name)  -> one section of that pinned snapshot
//
// Every section is built from data TCS-6 already collected, scored and attested: the dossier never calls a
// chain or a vendor, so no section costs upstream CU. Per-position haircuts come from TCS-6's own scoring
// code (vendored at package time), so the dossier and the score can never disagree on a value.
"use strict";

const crypto = require("crypto");
const store = require("./store");
const { ClientError } = require("./http");
const S = require("./tcs6-scoring");

const SCHEMA = "capital-integrity-dossier/1.0";
const PRICE_PER_CALL_USD = 0.005; // agent.pocket.network: "Every service costs $0.005 per call" (owner 2026-10-25)

const SECTIONS = [
  ["holdings_map", "Every counted position by wallet and chain: value, haircut, value after haircut, flags and price source; plus what was left out and why"],
  ["authority_graph", "Who can move the money: each wallet's Safe threshold and signers (or contract/account), signers shared across wallets, governance controls"],
  ["obligations_register", "Every obligation and disclosed commitment, how it is read (curated or on chain), the visibility checklist and its score effect"],
  ["exit_liquidity", "What could be withdrawn or sold now: locked and encumbered positions, loan health, the liquid remainder"],
  ["reconciliation", "The protocol's own reported treasury total against what we observe for the same scope, with netted items"],
  ["unresolved_items", "Everything we could not verify (data gaps, review items, failed gates, perimeter gaps) and what would resolve it"],
];
const SECTION_NAMES = SECTIONS.map(([n]) => n);

const round2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const usd = (calls) => Math.round(calls * PRICE_PER_CALL_USD * 1000) / 1000;

function notice(callsRequired, upTo = false) {
  const n = upTo ? "up to " : "";
  return `Heads-up for your security and cost control: this dossier is a disclosed multi-call product. A full dossier takes ${n}${callsRequired} calls `
    + `(the plan call plus one call per section), ${upTo ? "up to" : "about"} $${usd(callsRequired).toFixed(3)} at $${PRICE_PER_CALL_USD} per call. `
    + "You pay only for the calls you make and can stop after any section; each response shows how many calls remain. Thank you for understanding.";
}

function attestationRef(report) {
  const a = report.attestation || {};
  const p = a.payload || {};
  const key = (a.verification_detail || "").match(/key (\S+)/);
  return {
    attestation_id: p.attestation_id || null,
    key_id: key ? key[1] : null,
    evidence_manifest_hash: p.evidence_manifest_hash || null,
    verification_status: a.verification_status || "absent",
  };
}

function availability(bundle) {
  const g = bundle.governance || {};
  return {
    holdings_map: [true, null],
    authority_graph: Array.isArray(g.wallet_controls) && g.wallet_controls.length
      ? [true, null] : [false, "this snapshot predates per-wallet control facts; plan again after the next TCS-6 run"],
    obligations_register: [true, null],
    exit_liquidity: [true, null],
    reconciliation: g.reconciliation ? [true, null] : [false, "the protocol publishes no treasury total we can compare (see unresolved_items)"],
    unresolved_items: [true, null],
  };
}

// ---- plan --------------------------------------------------------------------------------------------

function plan(body, nowMs = Date.now()) {
  const id = body && typeof body.entity_id === "string" ? body.entity_id.trim().toLowerCase() : "";
  if (!store.ENTITY_ID_RE.test(id)) {
    throw new ClientError(400, "invalid_input", "field 'entity_id' is required, e.g. \"aave\"; list ids with POST /v1/dossier/entities");
  }
  const snap = store.latestSnapshot(id);
  if (!snap) throw new ClientError(400, "unknown_entity", `'${id}' has no scored TCS-6 snapshot; list ids with POST /v1/dossier/entities`);
  store.purgeExpired(nowMs);
  const createdAt = new Date(nowMs).toISOString();
  const dossierId = "dos_" + crypto.createHash("sha256").update(`${snap.report.report_id}|${id}|${createdAt}|${crypto.randomBytes(8).toString("hex")}`).digest("hex").slice(0, 24);
  const avail = availability(snap.bundle);
  const sections = SECTIONS.map(([name, description]) => ({ section: name, description, available: avail[name][0], ...(avail[name][1] ? { reason: avail[name][1] } : {}) }));
  const callsRequired = 1 + sections.filter((s) => s.available).length;
  store.savePinned(dossierId, { dossier_id: dossierId, entity_id: id, created_at: createdAt, calls_required: callsRequired, calls_made: 1, sections_done: [], report: snap.report, bundle: snap.bundle });
  const r = snap.report;
  return {
    schema_version: SCHEMA,
    dossier_id: dossierId,
    entity: r.entity,
    as_of: r.as_of,
    snapshot_report_id: r.report_id,
    valid_until: new Date(nowMs + store.TTL_MS).toISOString(),
    headline: { ...Object.fromEntries(Object.entries(r.headline || {}).map(([k, v]) => [k, round2(v)])), overall_score: r.overall_score.score, status: r.overall_score.status },
    sections,
    calls_required: callsRequired,
    calls_used: 1,
    calls_remaining: callsRequired - 1,
    estimate: { price_per_call_usd: PRICE_PER_CALL_USD, total_usd: usd(callsRequired), remaining_usd: usd(callsRequired - 1), basis: "agent.pocket.network flat price per call" },
    notice: notice(callsRequired),
    next: "POST /v1/dossier/section {dossier_id, section} for each available section, in any order",
    attestation_ref: attestationRef(r),
    disclaimer: r.disclaimer,
  };
}

// ---- sections ----------------------------------------------------------------------------------------

function rowsOf(bundle) {
  return S.computeBase(bundle).rows.map((x) => ({
    symbol: x.h.symbol, chain: x.h.chain, address: x.h.address, asset_class: x.h.asset_class, control: x.h.control, flags: x.h.haircut_flags || [],
    note: x.h.note || null, value_usd: round2(x.fair), haircut_pct: round2(x.haircut_pct), value_after_haircut_usd: round2(x.adjusted),
    price_source: ((x.h.prices || [])[0] || {}).source_ref || null, price_observed_at: ((x.h.prices || [])[0] || {}).observed_at || null,
  }));
}

// Title, publisher and URL of each cited source (never the raw vendor payload).
function citations(bundle, refs) {
  const want = new Set(refs.filter(Boolean));
  return (bundle.sources || []).filter((s) => want.has(s.source_ref)).map((s) => ({ source_ref: s.source_ref, title: s.title, publisher: s.publisher, url: s.url || null }));
}

function holdingsMap(report, bundle) {
  const rows = rowsOf(bundle);
  const roles = new Map(((bundle.governance || {}).wallet_controls || []).map((c) => [`${c.chain}:${c.address.toLowerCase()}`, c.role]));
  const byWallet = new Map();
  for (const r of rows) {
    const k = `${r.chain}:${(r.address || "").toLowerCase()}`;
    if (!byWallet.has(k)) byWallet.set(k, { chain: r.chain, address: r.address, role: roles.get(k) || null, positions: [] });
    const { chain, address, ...pos } = r;
    byWallet.get(k).positions.push(pos);
  }
  const wallets = [...byWallet.values()].map((w) => ({
    ...w, positions: w.positions.sort((a, b) => b.value_usd - a.value_usd),
    value_usd: round2(w.positions.reduce((s, p) => s + p.value_usd, 0)), value_after_haircut_usd: round2(w.positions.reduce((s, p) => s + p.value_after_haircut_usd, 0)),
  })).sort((a, b) => b.value_usd - a.value_usd);
  const byClass = new Map();
  for (const r of rows) byClass.set(r.asset_class, (byClass.get(r.asset_class) || 0) + r.value_after_haircut_usd);
  return {
    data: {
      wallets,
      totals: { value_usd: round2(rows.reduce((s, r) => s + r.value_usd, 0)), value_after_haircut_usd: round2(rows.reduce((s, r) => s + r.value_after_haircut_usd, 0)), positions: rows.length },
      left_out: (bundle.gaps || []).filter((g) => g.field.startsWith("holdings.prices") || g.field === "holdings.dust").map((g) => g.reason),
      sources: citations(bundle, rows.map((r) => r.price_source)),
      method: "Value = quantity x price read by the TCS-6 collector; haircut from the TCS-6 asset-class range and condition flags; positions whose control is not verified count at 0 after haircut.",
    },
    chart: { type: "bar", title: "Value after haircut by asset class (USD)", series: [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: round2(value) })) },
  };
}

function authorityGraph(report, bundle) {
  const g = bundle.governance || {};
  const wallets = (g.wallet_controls || []).map((c) => ({
    chain: c.chain, address: c.address, role: c.role, perimeter: c.perimeter, control: c.control,
    ...(c.control === "safe" ? { threshold: `${c.threshold}-of-${(c.signers || []).length}`, signers: c.signers || [] } : {}),
  }));
  const use = new Map();
  for (const w of wallets) for (const s of w.signers || []) use.set(s.toLowerCase(), [...(use.get(s.toLowerCase()) || []), `${w.role}@${w.chain}`]);
  const shared = [...use.entries()].filter(([, v]) => v.length > 1).map(([signer, wallets]) => ({ signer, wallets })).sort((a, b) => b.wallets.length - a.wallets.length);
  const safes = wallets.filter((w) => w.control === "safe");
  const mostShared = shared[0];
  return {
    data: {
      wallets,
      shared_signers: shared.slice(0, 20),
      shared_signer_count: shared.length,
      summary: mostShared && safes.length > 1
        ? `${shared.filter((s) => s.wallets.length === mostShared.wallets.length).length} signer(s) sit on ${mostShared.wallets.length} of ${safes.length} Safes.`
        : "No signer is shared across Safes.",
      governance: { multisig_scored: g.multisig || null, timelock_evidenced: !!g.timelock, treasury_policy_documented: !!g.has_treasury_policy },
      proxy_checks: ((bundle.verification_summary || {}).fields || []).filter((f) => f.field.startsWith("control.")).map((f) => ({ label: f.label, status: f.status })),
      method: "Safe getThreshold()/getOwners() read on chain each collector run; EIP-1967 slots compared across two RPCs plus Sourcify (evidence bank).",
    },
  };
}

// How the overall score is reached: the weighted dimension score, each deduction, the final score.
// TCS-6's obligations_policy.score_effect_points compares the policy with the earlier flat rule (both
// deduct 10 points for a partial gap, so it often reads 0); buyers need the deduction itself.
function scoreWalk(report, bundle) {
  const score = (report.overall_score || {}).score;
  const dims = (report.dimensions || []).filter((d) => Number.isFinite(d.score));
  const coverage = dims.reduce((s, d) => s + d.weight_pct, 0);
  if (!Number.isFinite(score) || !coverage) return null;
  const weighted = dims.reduce((s, d) => s + d.weight_pct * d.score, 0) / coverage;
  const deductions = (bundle.penalties || []).filter((p) => Number.isFinite(p.points)).map((p) => ({ id: p.id || null, points: p.points, reason: p.reason || null }));
  const gate = (report.hard_gates || []).find((g) => g.id === "obligation_visibility");
  const m = gate && /(\d+) points deducted/.exec(gate.effect || "");
  if (m) deductions.push({ id: "obligation_visibility", points: Number(m[1]), reason: gate.effect.split(" Under ")[0] });
  const total = deductions.reduce((s, d) => s + d.points, 0);
  const reconciles = Math.round(Math.min(100, Math.max(0, weighted - total))) === score;
  return {
    weighted_dimension_score: Math.round(weighted * 10) / 10,
    coverage_pct: coverage,
    deductions,
    points_deducted: total,
    final_score: score,
    reconciles,
    ...(reconciles ? {} : { note: "A further adjustment (for example the input-attestation materiality policy) also applies; see the TCS-6 report." }),
  };
}

function obligationsRegister(report, bundle) {
  const op = report.obligations_policy || {};
  const walk = scoreWalk(report, bundle);
  const oblPoints = walk ? walk.deductions.filter((d) => d.id === "obligation_visibility").reduce((s, d) => s + d.points, 0) : null;
  return {
    data: {
      items: ((bundle.obligations || {}).items || []).map((i) => ({ ...i })),
      obligations_total_usd: round2((report.headline || {}).obligations_usd),
      disclosed_commitments: op.disclosed_commitments || [],
      visibility: { status: op.obligations_status || (report.data_coverage || {}).obligation_visibility_status || null, materiality: op.materiality || null,
        checklist: op.materiality_reasons || [], penalty_policy: op.penalty_policy || null,
        points_deducted_from_score: oblPoints,
        ...(op.policy_id ? { change_vs_previous_rule_points: op.score_effect_points ?? null,
          change_vs_previous_rule_note: `How the overall score differs under ${op.policy_id} from the earlier flat obligations rule; not the deduction itself (see points_deducted_from_score).` } : {}) },
      score_walk: walk,
    },
  };
}

function exitLiquidity(report, bundle) {
  const rows = rowsOf(bundle);
  const restricted = rows.filter((r) => r.flags.some((f) => f === "lockup" || f === "redemption_limits" || f === "unlock_pending" || f === "legal_restriction"));
  const free = rows.filter((r) => !restricted.includes(r));
  const d2 = (report.dimensions || []).find((d) => d.id === "D2") || { primary_metrics: [] };
  const metric = (n) => ((d2.primary_metrics || []).find((m) => m.name === n) || {}).value ?? null;
  return {
    data: {
      restricted_positions: restricted.map((r) => ({ symbol: r.symbol, chain: r.chain, address: r.address, value_usd: r.value_usd, value_after_haircut_usd: r.value_after_haircut_usd, why: r.flags, ...(r.note ? { note: r.note } : {}) })),
      liquid_after_haircut_usd: round2(free.reduce((s, r) => s + r.value_after_haircut_usd, 0)),
      tier_0_1_liquid_usd: metric("tier_0_to_1_hqla_usd"),
      runway_months: metric("liquidity_runway_months"),
      loan_and_liquidity_risks: (report.risks || []).filter((x) => /liquidat|exit|depeg|lock/i.test(`${x.id} ${x.description}`)),
      method: "v1: lending/vault liquidity reads, lock end dates and loan health, all read on chain by the collector; full eth_call exit simulations are not included.",
    },
  };
}

function reconciliation(report, bundle) {
  const g = bundle.governance || {};
  const rec = g.reconciliation;
  const reported = rec.reported_total_usd ?? rec.reported_quantity;
  const observed = rec.observed_usd_same_scope ?? rec.observed_quantity_same_scope;
  return {
    data: {
      unit: rec.unit || "USD", reported_total: reported, reported_as_of: rec.reported_as_of, observed_same_scope: round2(observed),
      reconciliation_pct: g.reconciliation_pct ?? null, difference: round2(reported - observed), scope_status: rec.scope_status, scope_note: rec.scope_note || null,
      netted_obligation_items: rec.netted_obligation_items || [], source_refs: rec.source_refs || [], sources: citations(bundle, rec.source_refs || []), method: rec.method,
    },
    chart: { type: "bar", title: `Reported vs observed (${rec.unit || "USD"})`, series: [{ label: "reported", value: reported }, { label: "observed, same scope", value: round2(observed) }] },
  };
}

function unresolvedItems(report) {
  const p = (report.attestation || {}).payload || {};
  return {
    data: {
      data_gaps: (report.data_gaps || []).map((g) => ({ field: g.field, reason: g.reason, remediation: g.remediation || null })),
      review_required: p.review_required ?? null,
      review_items: p.review_items || null,
      failed_gates: (report.hard_gates || []).filter((g) => g.status !== "pass").map((g) => ({ id: g.id, status: g.status, effect: g.effect })),
      perimeter_gaps: (report.capital_perimeter || {}).known_perimeter_gaps || [],
    },
  };
}

const BUILDERS = { holdings_map: holdingsMap, authority_graph: authorityGraph, obligations_register: obligationsRegister, exit_liquidity: exitLiquidity, reconciliation, unresolved_items: unresolvedItems };

function section(body, nowMs = Date.now()) {
  const id = body && typeof body.dossier_id === "string" ? body.dossier_id.trim() : "";
  const name = body && typeof body.section === "string" ? body.section.trim() : "";
  if (!store.DOSSIER_ID_RE.test(id)) throw new ClientError(400, "invalid_input", "field 'dossier_id' is required: the id returned by POST /v1/dossier/plan");
  if (!SECTION_NAMES.includes(name)) throw new ClientError(400, "invalid_input", `field 'section' must be one of: ${SECTION_NAMES.join(", ")}`);
  const d = store.loadPinned(id, nowMs);
  if (!d) throw new ClientError(400, "unknown_dossier", "dossier_id not found or older than 24 hours; call POST /v1/dossier/plan again for a fresh snapshot");
  const r = d.report;
  // calls_used counts every call made on this dossier (a repeated section is a normal paid relay too);
  // calls_remaining counts the available sections not yet returned.
  const repeat = (d.sections_done || []).includes(name);
  d.sections_done = repeat ? d.sections_done : [...(d.sections_done || []), name];
  d.calls_made = (d.calls_made || 1) + 1;
  store.savePinned(id, d);
  const avail = availability(d.bundle)[name];
  const callsUsed = d.calls_made;
  const remaining = Object.entries(availability(d.bundle)).filter(([n, [ok]]) => ok && !d.sections_done.includes(n)).length;
  const built = avail[0] ? BUILDERS[name](r, d.bundle) : { data: null };
  return {
    schema_version: SCHEMA,
    dossier_id: id,
    entity: r.entity,
    section: name,
    available: avail[0],
    ...(avail[1] ? { reason: avail[1] } : {}),
    as_of: r.as_of,
    snapshot_report_id: r.report_id,
    calls_used: callsUsed,
    calls_remaining: remaining,
    estimate: { price_per_call_usd: PRICE_PER_CALL_USD, remaining_usd: usd(remaining), basis: "agent.pocket.network flat price per call" },
    attestation_ref: attestationRef(r),
    data: built.data,
    ...(built.chart ? { chart: built.chart } : {}),
    ...(repeat ? { note: "this section was already returned for this dossier; the content is the same pinned snapshot" } : {}),
    disclaimer: r.disclaimer,
  };
}

function entities() {
  return {
    schema_version: SCHEMA,
    entities: store.listEntities().map((id) => {
      const s = store.latestSnapshot(id);
      return s ? { entity_id: id, name: (s.report.entity || {}).name || id, as_of: s.report.as_of, overall_score: s.report.overall_score.score, status: s.report.overall_score.status } : { entity_id: id };
    }),
    note: "Start a dossier with POST /v1/dossier/plan {entity_id}. " + notice(1 + SECTIONS.length, true),
  };
}

module.exports = { plan, section, entities, SECTIONS, SECTION_NAMES, PRICE_PER_CALL_USD, SCHEMA, notice };
