// The shared `verified` block (pocket-agentic-envelope/1, docs/envelope/ in the repo) for the PMIC packs.
// Additive: built from the answer the route already returns, plus two hub lookups the pack already caches
// (entities for the company's SEC CIK, sources for publisher names and tiers).
//   brief:    a company brief is about the company (company:sec-cik:<cik>, else company:pmic:<id>); every other
//             brief is about its topic (topic:pmic-<pack>:<vertical>), linked to the countries asked for.
//   overview: the company or the pack's topic overview; facts and scores of several briefs, so not_scored.
//   events:   the company or the pack's event feed; not_scored.
//   tools/address (crypto): the address, not_scored.
// PMIC scores read against each vertical's own labels (a high score can mean "calm" or "heating"), so the
// shared scale is null and the label carries the meaning. Signed input attestations stay in `attestation`;
// attestation_ref is null because a brief cites many series, each with its own envelope.
"use strict";

const C = require("./verified-core");

// Data-quality flags that say something is missing or unverified (the rest describe the data, e.g. sharp_move).
const GAP_FLAGS = {
  insufficient_data: ["too few inputs have a current reading", "no score"],
  inputs_pending: ["some inputs have not been collected yet", "left out of the score"],
  partial_coverage: ["under 75% of the input weight has a reading", "confidence reduced"],
  stale_data: ["at least one input is older than its usual release cycle", "may not reflect the latest release"],
  cross_source_mismatch: ["an input disagrees with its cross-check source", "read that input with care"],
  single_source: ["no second source to cross-check", "not independently confirmed"],
};

const packTopic = (pack) => `pmic-${String(pack.service_id).replace(/^pmic-/, "").replace(/-signals$/, "")}`;
const rights = (tier) => (tier === 1 || tier === 2 ? "permitted_for_derived_output" : "pending_review");

function companySubject(entity, cik) {
  const e = entity || {};
  return {
    kind: "company",
    id: cik ? C.id("company", "sec-cik", String(cik).padStart(10, "0")) : C.id("company", "pmic", e.entity_id),
    name: e.name || null,
    identifiers: { pmic_entity_id: e.entity_id, ...(e.ticker ? { ticker: e.ticker } : {}), ...(e.industry ? { industry: e.industry } : {}), ...(cik ? { sec_cik: String(cik).padStart(10, "0") } : {}) },
  };
}

function topicSubject(pack, name, title, countries) {
  return {
    kind: "topic",
    id: C.id("topic", packTopic(pack), name),
    name: title || name,
    identifiers: { pack: pack.service_id, ...(name !== "overview" && name !== "events" ? { vertical: name } : {}) },
    links: (countries || []).filter((c) => /^[a-z]{2}$/.test(c)).map((c) => C.link("covers", C.id("jurisdiction", "iso3166", c), null)),
  };
}

// sources: Map source_id -> {name, tier} from the hub's /v1/sources (empty when the hub didn't answer).
function seriesEvidence(m, sources) {
  const s = sources.get(m.source) || {};
  return C.evidence({
    source_ref: m.series_id || m.url,
    title: m.label || m.series_id,
    publisher: s.name || m.source || "unknown",
    url: m.citation_url || m.url,
    observation_time: m.value ? m.value.as_of : m.as_of,
    source_tier: s.tier ?? null,
    rights_status: rights(s.tier),
  });
}

function briefEvidence(out, sources) {
  const members = [...(out.inputs || []), ...(out.watch || [])].filter((m) => m && m.series_id);
  const cites = (out.citations || []).filter((c) => c && (c.series_id || c.url));
  return [...members, ...cites].map((m) => seriesEvidence(m, sources));
}

function briefGaps(out) {
  const g = [];
  for (const f of out.risk_flags || []) if (GAP_FLAGS[f]) g.push(C.gap("brief", `${f}: ${GAP_FLAGS[f][0]}`, GAP_FLAGS[f][1]));
  for (const m of out.inputs || []) for (const f of m.risk_flags || []) if (GAP_FLAGS[f]) g.push(C.gap(`inputs.${m.series_id}`, `${f}: ${GAP_FLAGS[f][0]}`, GAP_FLAGS[f][1]));
  for (const p of out.pending_inputs || []) g.push(C.gap(`inputs.${p.series_id}`, "not collected yet", "excluded from the score", "fills in after the collector's next backfill"));
  const a = out.attestation && out.attestation.summary;
  if (a && a.series) {
    const unchecked = (a.missing || 0) + (a.stale || 0) + (a.invalid || 0);
    if (unchecked) g.push(C.gap("attestation", `${unchecked} of ${a.series} cited series have no current signed cross-check (${a.missing || 0} none, ${a.stale || 0} stale, ${a.invalid || 0} invalid)`, "those inputs are not independently confirmed", "see attestation.series"));
  }
  return g;
}

function briefAssessment(out) {
  const status = out.status === "ok" ? "ok" : out.status === "insufficient_data" ? "insufficient_data" : "not_scored";
  const share = out.coverage && typeof out.coverage.weight_share === "number" ? out.coverage.weight_share * 100 : null;
  return C.assessment({ status, native_status: out.status, score: out.score, scale: null, label: out.label, confidence: out.confidence, coverage_pct: share });
}

function asOfBrief(out) {
  return C.newest([
    ...(out.inputs || []).map((m) => m.value && m.value.as_of),
    ...(out.citations || []).map((c) => c.as_of),
    ...(out.drivers || []).map((d) => d.as_of || d.event_time),
  ]);
}

/**
 * ctx: { pack, version, cik (company CIK or null), sources (Map), countries (requested, or null) }
 */
function forBrief(out, ctx, nowMs = Date.now()) {
  const subject = out.entity && out.entity.entity_id ? companySubject(out.entity, ctx.cik) : topicSubject(ctx.pack, out.vertical, out.title, ctx.countries);
  return C.build({
    service: ctx.pack.service_id, version: ctx.version, route: "/v1/brief", nowMs,
    subject, as_of: asOfBrief(out),
    assessment: briefAssessment(out),
    evidence: briefEvidence(out, ctx.sources), moreRoute: "/v1/catalog",
    gaps: briefGaps(out),
  });
}

function forOverview(out, ctx, nowMs = Date.now()) {
  const subject = out.entity && out.entity.entity_id ? companySubject(out.entity, ctx.cik) : topicSubject(ctx.pack, "overview", `${ctx.pack.service_id} overview`, null);
  const thin = (out.briefs || []).filter((b) => b.status !== "ok").map((b) => C.gap(`briefs.${b.vertical}`, `${b.status}: not enough current data to score this brief`, "no score for it in this overview"));
  return C.build({
    service: ctx.pack.service_id, version: ctx.version, route: "/v1/overview", nowMs,
    subject, as_of: null,
    assessment: C.notScored(`${out.count} brief${out.count === 1 ? "" : "s"}`),
    evidence: [],
    evidence_more: out.count ? { route: "/v1/brief", count: out.count, note: "Each brief lists its own inputs and sources; ask for one with {vertical}." } : null,
    gaps: thin,
  });
}

function forEvents(out, ctx, nowMs = Date.now()) {
  const events = out.events || [];
  const subject = ctx.entity ? companySubject(ctx.entity, ctx.cik) : topicSubject(ctx.pack, "events", `${ctx.pack.service_id} events`, null);
  return C.build({
    service: ctx.pack.service_id, version: ctx.version, route: "/v1/events", nowMs,
    subject, as_of: C.newest(events.map((e) => e.event_time)),
    assessment: C.notScored(`${events.length} event${events.length === 1 ? "" : "s"}`),
    evidence: events.filter((e) => e.source_url).map((e) => {
      const s = ctx.sources.get(e.source_id) || {};
      return C.evidence({ source_ref: e.source_url, title: e.title || e.event_type, publisher: s.name || e.source_id, url: e.source_url, retrieved_at: e.fetch_time, observation_time: e.event_time, source_tier: s.tier ?? null, rights_status: rights(s.tier) });
    }),
    moreRoute: "/v1/events",
  });
}

function forAddress(out, ctx, nowMs = Date.now()) {
  const a = String(out.address);
  const evm = out.type === "evm" && /^0x[0-9a-fA-F]{40}$/.test(a);
  return C.build({
    service: ctx.pack.service_id, version: ctx.version, route: "/v1/tools/address", nowMs,
    subject: { kind: "wallet", id: evm ? C.id("wallet", "evm-address", a.toLowerCase()) : C.id("wallet", String(out.type || "unknown").replace(/_/g, "-"), a), name: null, identifiers: { address: a, format: String(out.type || "unknown") } },
    as_of: null,
    assessment: C.notScored(out.valid ? "valid format" : "invalid format"),
    evidence: [],
  });
}

module.exports = { forBrief, forOverview, forEvents, forAddress, packTopic };
