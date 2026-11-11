// The shared `verified` block (pocket-agentic-envelope/1, docs/envelope/ in the repo; owner decisions 2026-11-11):
// who the response is about, when it was true, what it concluded and which evidence backs it, spelled the same way
// in every service. Additive only: every value is copied from the TCS-6 report and evidence bundle this response is
// already built from, and the dossier's own fields stay authoritative. TCS-6 keeps its frozen v1 contract; protocols
// get this block through the dossier.
"use strict";

const SCHEMA = "pocket-agentic-envelope/1";
const MAX_EVIDENCE = 50;
const MAX_LINKS = 50;

// EVM chain IDs for CAIP-10 wallet ids. Same values as the TCS-6 collector (evidence/checks.py CHAIN_IDS) plus the
// chains it reads through Etherscan V2 (config.example.json etherscan_chainid). A chain not listed gets no link.
const CHAIN_IDS = {
  ethereum: 1, optimism: 10, bnb: 56, gnosis: 100, polygon: 137, sonic: 146, monad: 143, mantle: 5000,
  base: 8453, plasma: 9745, arbitrum: 42161, avalanche: 43114, linea: 59144,
};

// TCS-6 overall_score.status -> the shared status; the TCS-6 value is kept in native_status.
const STATUS = { eligible: "ok", provisional: "provisional", insufficient_data: "insufficient_data", ineligible: "ineligible" };
const VERIFICATION = new Set(["valid", "invalid", "missing", "stale"]);
const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2}))?$/;
const ts = (x) => (typeof x === "string" && TS.test(x) ? x : null);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function subject(report, bundle) {
  const e = report.entity || {};
  const seen = new Set();
  const links = [];
  for (const c of ((bundle.governance || {}).wallet_controls || [])) {
    const cid = CHAIN_IDS[String(c.chain || "").toLowerCase()];
    if (!cid || c.perimeter !== "include" || !/^0x[0-9a-fA-F]{40}$/.test(c.address || "")) continue;
    const id = `wallet:caip10:eip155:${cid}:${c.address}`;
    if (seen.has(id.toLowerCase()) || links.length >= MAX_LINKS) continue;
    seen.add(id.toLowerCase());
    links.push({ rel: "treasury_wallet", id, service: null });
  }
  return {
    kind: "protocol",
    id: `protocol:tcs6:${e.entity_id}`,
    name: e.name || null,
    identifiers: { tcs6_entity_id: e.entity_id, ...(e.entity_type ? { entity_type: e.entity_type } : {}), ...(e.peer_cohort ? { peer_cohort: e.peer_cohort } : {}) },
    links,
  };
}

// The TCS-6 report's source_manifest has every field the shared evidence item needs; older snapshots only have the
// bundle's sources, whose missing fields become null. internal_only sources are never copied out.
function evidence(report, bundle, onlyRefs = null) {
  const manifest = Array.isArray(report.source_manifest) && report.source_manifest.length ? report.source_manifest : null;
  const want = onlyRefs ? new Set(onlyRefs.filter(Boolean)) : null;
  const items = (manifest || bundle.sources || [])
    .filter((s) => s && typeof s.source_ref === "string" && s.source_ref && (!want || want.has(s.source_ref)))
    .filter((s) => s.rights_status !== "internal_only")
    .map((s) => ({
      source_ref: s.source_ref,
      title: String(s.title || s.source_ref),
      publisher: String(s.publisher || "unknown"),
      url: typeof s.url === "string" && /^https?:\/\//.test(s.url) ? s.url : null,
      retrieved_at: ts(s.retrieved_at),
      observation_time: ts(s.observation_time),
      source_tier: [1, 2, 3, 4, 5].includes(s.source_tier) ? s.source_tier : null,
      rights_status: ["permitted_for_derived_output", "licensed_for_display", "pending_review"].includes(s.rights_status) ? s.rights_status : "pending_review",
    }));
  return { shown: items.slice(0, MAX_EVIDENCE), total: items.length };
}

function gapsOf(report) {
  return (report.data_gaps || []).filter((g) => g && g.field).map((g) => ({
    field: String(g.field), reason: String(g.reason || "not stated"), impact: String(g.impact || "not stated"),
    ...(g.remediation ? { remediation: String(g.remediation) } : {}),
  }));
}

// Same source as the dossier's attestation_ref; evidence_manifest_hash is the shared payload_hash. No attestation
// on the report at all -> null.
function attestationRef(report) {
  const a = report.attestation;
  if (!a) return null;
  const p = a.payload || {};
  const key = (a.verification_detail || "").match(/key (\S+)/);
  return {
    attestation_id: p.attestation_id || null,
    key_id: key ? key[1] : null,
    payload_hash: p.evidence_manifest_hash || a.payload_hash || null,
    verification_status: VERIFICATION.has(a.verification_status) ? a.verification_status : "missing",
  };
}

function tcs6Assessment(report) {
  const o = report.overall_score || {};
  const c = report.confidence || {};
  const score = num(o.score);
  return {
    status: STATUS[o.status] || "not_scored",
    native_status: o.status || null,
    score,
    scale: { min: 0, max: 100, higher_is: "better" },
    label: o.decision_band || null,
    confidence: num(c.score) === null && !c.label ? null
      : { score: num(c.score) === null ? null : Math.max(0, Math.min(100, c.score)), label: ["high", "medium", "low"].includes(c.label) ? c.label : null },
    coverage_pct: num(o.coverage_pct) === null ? null : Math.max(0, Math.min(100, o.coverage_pct)),
  };
}

// Extra gaps are added only when the TCS-6 report does not already state the same reason (availability's not_valued
// lines come from the same bundle gaps the report lists).
function mergeGaps(base, extra) {
  const seen = new Set(base.map((g) => g.reason));
  return [...base, ...extra.filter((g) => !seen.has(g.reason) && seen.add(g.reason))];
}

const NOT_SCORED = { status: "not_scored", native_status: null, score: null, scale: null, label: null, confidence: null, coverage_pct: null };

/**
 * route: "/v1/dossier/plan" | "/v1/dossier/section" | "/v1/dossier/availability"
 * opts.assessment: "tcs6" (plan: the TCS-6 judgement the dossier is pinned to) or "none" (facts, not a judgement)
 * opts.evidenceRefs: limit evidence to these source_refs (a section that cites a subset)
 * opts.evidenceOnPlan: list no evidence here and point to the plan, which carries it (sections that cite no source of
 *   their own, so the same list is not repeated on every paid call)
 * opts.extraGaps: more gaps (availability's not_valued tokens)
 */
function build(route, version, report, bundle, opts = {}, nowMs = Date.now()) {
  const all = evidence(report, bundle, null);
  const ev = opts.evidenceOnPlan ? { shown: [], total: all.total } : opts.evidenceRefs ? evidence(report, bundle, opts.evidenceRefs) : all;
  const more = opts.evidenceOnPlan
    ? (all.total ? { route: "/v1/dossier/plan", count: all.total, note: "This section cites no source of its own; the plan response lists the snapshot's sources." } : null)
    : ev.total > ev.shown.length
      ? { route: "/v1/dossier/section", count: ev.total, note: "The holdings_map, reconciliation and obligations_register sections cite every source." }
      : null;
  return {
    schema: SCHEMA,
    service: "capital-integrity-dossier",
    service_version: version,
    route,
    subject: subject(report, bundle),
    as_of: ts(report.as_of) || ts(bundle.collected_at) || new Date(nowMs).toISOString(),
    generated_at: new Date(nowMs).toISOString(),
    assessment: opts.assessment === "tcs6" ? tcs6Assessment(report) : { ...NOT_SCORED },
    evidence: ev.shown,
    evidence_more: more,
    gaps: mergeGaps(gapsOf(report), opts.extraGaps || []),
    attestation_ref: attestationRef(report),
  };
}

module.exports = { build, subject, evidence, attestationRef, tcs6Assessment, SCHEMA, CHAIN_IDS };
