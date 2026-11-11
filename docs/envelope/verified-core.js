// pocket-agentic-envelope/1: the shared builder for the `verified` block (docs/envelope/README.md).
// This file is the canonical copy. Each service vendors it unchanged as lib/verified-core.js (a test in each
// service checks the copy is byte-identical) and keeps its own field mapping in lib/verified.js.
// No dependencies, no network. Every value comes from the response the service already built.
"use strict";

const { domainToASCII } = require("node:url");

const SCHEMA = "pocket-agentic-envelope/1";
const MAX_EVIDENCE = 50;
const MAX_LINKS = 50;
const STATUSES = new Set(["ok", "provisional", "insufficient_data", "ineligible", "not_scored"]);
const RIGHTS = new Set(["permitted_for_derived_output", "licensed_for_display", "internal_only", "pending_review"]);
const VERIFICATION = new Set(["valid", "invalid", "missing", "stale"]);
const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2}))?$/;

const ts = (x) => (typeof x === "string" && TS.test(x) ? x : null);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pct = (x) => (num(x) === null ? null : Math.max(0, Math.min(100, x)));

// The newest valid timestamp of a list (dates and date-times compare by their UTC instant).
function newest(list) {
  let best = null;
  let bestMs = -Infinity;
  for (const x of list) {
    const t = ts(x);
    if (!t) continue;
    const ms = Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = t;
      bestMs = ms;
    }
  }
  return best;
}

// Subject ids: <kind>:<namespace>:<value>; the value may not contain white space.
const clean = (v) => String(v).trim().replace(/\s+/g, "_");
const id = (kind, ns, value) => `${kind}:${ns}:${clean(value)}`;
function domainId(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/\.$/, "");
  return id("domain", "dns", domainToASCII(d) || d);
}
const caip10 = (chainId, address) => id("wallet", "caip10", `eip155:${chainId}:${address}`);
const link = (rel, subjectId, service = null) => ({ rel, id: subjectId, service });

function evidence({ source_ref, title, publisher, url = null, retrieved_at = null, observation_time = null, source_tier = null, rights_status = "pending_review" }) {
  return {
    source_ref: String(source_ref),
    title: String(title || source_ref),
    publisher: String(publisher || "unknown"),
    url: typeof url === "string" && /^https?:\/\//.test(url) ? url : null,
    retrieved_at: ts(retrieved_at),
    observation_time: ts(observation_time),
    source_tier: [1, 2, 3, 4, 5].includes(source_tier) ? source_tier : null,
    rights_status: RIGHTS.has(rights_status) ? rights_status : "pending_review",
  };
}

const gap = (field, reason, impact, remediation) => ({
  field: String(field), reason: String(reason), impact: String(impact), ...(remediation ? { remediation: String(remediation) } : {}),
});

const SCALE_0_100 = Object.freeze({ min: 0, max: 100, higher_is: "better" });
function assessment({ status, native_status = null, score = null, scale = null, label = null, confidence = null, coverage_pct = null }) {
  const c = confidence && (num(confidence.score) !== null || confidence.label)
    ? { score: pct(confidence.score), label: ["high", "medium", "low"].includes(confidence.label) ? confidence.label : null }
    : null;
  return {
    status: STATUSES.has(status) ? status : "not_scored",
    native_status: native_status === null || native_status === undefined ? null : String(native_status),
    score: num(score),
    scale: scale ? { min: scale.min, max: scale.max, higher_is: scale.higher_is } : null,
    label: label === null || label === undefined ? null : String(label),
    confidence: c,
    coverage_pct: pct(coverage_pct),
  };
}
const notScored = (label = null) => assessment({ status: "not_scored", label });

function attestationRef(a) {
  if (!a) return null;
  return {
    attestation_id: a.attestation_id || null,
    key_id: a.key_id || null,
    payload_hash: a.payload_hash || null,
    verification_status: VERIFICATION.has(a.verification_status) ? a.verification_status : "missing",
  };
}

/**
 * The whole block. Evidence over 50 items is cut to 50; evidence_more then points to moreRoute (or is null when
 * the service has no fuller list). Links are de-duplicated (case-insensitive) and capped at 50. as_of falls back
 * to generated_at only when the service has no observation time at all.
 */
function build({ service, version, route, subject, as_of, assessment: a, evidence: ev = [], evidence_more = null, moreRoute = null, gaps = [], attestation_ref = null, nowMs = Date.now() }) {
  const generated = new Date(nowMs).toISOString();
  const seenRefs = new Set();
  const items = ev.filter((e) => e && e.source_ref && !seenRefs.has(e.source_ref) && seenRefs.add(e.source_ref) && e.rights_status !== "internal_only");
  const seenLinks = new Set();
  const links = (subject.links || []).filter((l) => !seenLinks.has(l.id.toLowerCase()) && seenLinks.add(l.id.toLowerCase())).slice(0, MAX_LINKS);
  const seenGaps = new Set();
  const gs = gaps.filter((g) => !seenGaps.has(`${g.field}|${g.reason}`) && seenGaps.add(`${g.field}|${g.reason}`));
  return {
    schema: SCHEMA,
    service,
    service_version: String(version),
    route,
    subject: { kind: subject.kind, id: subject.id, name: subject.name ?? null, identifiers: subject.identifiers || {}, links },
    as_of: ts(as_of) || generated,
    generated_at: generated,
    assessment: a || notScored(),
    evidence: items.slice(0, MAX_EVIDENCE),
    evidence_more: evidence_more || (items.length > MAX_EVIDENCE ? { route: moreRoute || route, count: items.length } : null),
    gaps: gs,
    attestation_ref: attestationRef(attestation_ref),
  };
}

module.exports = { SCHEMA, SCALE_0_100, ts, num, newest, id, domainId, caip10, link, evidence, gap, assessment, notScored, attestationRef, build };
