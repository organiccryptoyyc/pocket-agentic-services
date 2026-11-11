// The shared `verified` block (pocket-agentic-envelope/1, docs/envelope/ in the repo) for brand-protection.
// Additive: built from the report or evidence record the route already returns.
//   scan, lookalikes: subject brand:bp:<brand_id>, linked to its official domains (agent-trust answers about them);
//     findings are observations, not a verdict, so not_scored; each finding's sources live in /v1/brand/evidence.
//   evidence: subject the lookalike domain, linked back to the brand; one evidence item per lookup that answered.
"use strict";

const C = require("./verified-core");

const SERVICE = "brand-protection";
const OK = "permitted_for_derived_output";
const KINDS = {
  dns: { publisher: "Public DNS (live lookup)", tier: 1, what: "DNS records" },
  rdap: { publisher: "RDAP (registry registration data)", tier: 1, what: "registration record" },
  tls: { publisher: "TLS handshake (live)", tier: 1, what: "TLS certificate" },
  http: { publisher: "Homepage fetch (live)", tier: 2, what: "homepage" },
  ct: { publisher: "Certificate Transparency log", tier: 1, what: "certificate log entry" },
};

function brandSubject(doc) {
  return {
    kind: "brand",
    id: C.id("brand", "bp", doc.brand_id),
    name: doc.brand || null,
    identifiers: { brand_id: doc.brand_id, official_domains: (doc.official_domains || []).slice(0, 50) },
    links: (doc.official_domains || []).map((d) => C.link("official_domain", C.domainId(d), "agent-trust")),
  };
}

function coverageGaps(out) {
  const c = out.coverage || {};
  const g = [];
  if (out.scan_type !== "full") g.push(C.gap("scan_type", "only a quick scan has run: lookalike names were checked in DNS, not their registry records, certificates or pages", "risk is a floor, not a verdict", "call again after the collector's next full scan"));
  if (c.partial) g.push(C.gap("coverage", `checked ${c.candidates_dns_checked ?? "?"} of ${c.candidates_generated ?? "?"} candidate names in DNS and ${c.full_checks ?? "?"} of ${c.existing ?? "?"} existing lookalikes in full`, "some lookalikes may be missing or unassessed"));
  if (num(c.dns_errors) > 0) g.push(C.gap("dns_errors", `${c.dns_errors} DNS lookups failed`, "those names were not assessed"));
  for (const w of out.collector_warnings || []) g.push(C.gap("collector", String(w), "see collector_warnings"));
  return g;
}
const num = (x) => (typeof x === "number" ? x : 0);

function forReport(route, out, version, nowMs) {
  const findings = out.findings_total;
  const high = (out.findings || []).filter((f) => f.risk_level === "high").length;
  return C.build({
    service: SERVICE, version, route, nowMs,
    subject: brandSubject(out),
    as_of: out.as_of,
    assessment: C.notScored(`${findings} finding${findings === 1 ? "" : "s"}${high ? `, ${high} high risk in this page` : ""}`),
    evidence: [],
    evidence_more: findings ? { route: "/v1/brand/evidence", count: findings, note: "One evidence record per finding: send its evidence_id for the lookups, fetch times and SHA-256 hashes." } : null,
    gaps: coverageGaps(out),
  });
}

function forEvidence(out, version, nowMs) {
  const sources = out.sources || [];
  return C.build({
    service: SERVICE, version, route: "/v1/brand/evidence", nowMs,
    subject: {
      kind: "domain", id: C.domainId(out.domain), name: out.domain,
      identifiers: { domain: out.domain, evidence_id: out.evidence_id },
      links: out.brand_id ? [C.link("lookalike_of", C.id("brand", "bp", out.brand_id), SERVICE)] : [],
    },
    as_of: out.collected_at,
    assessment: C.notScored("evidence record"),
    evidence: sources.filter((s) => s.ok).map((s) => {
      const k = KINDS[s.kind] || { publisher: String(s.kind), tier: null, what: String(s.kind) };
      return C.evidence({ source_ref: `${s.kind}:${out.domain}`, title: `${k.what} of ${out.domain}`, publisher: k.publisher, url: s.url, retrieved_at: s.fetched_at, observation_time: s.fetched_at, source_tier: k.tier, rights_status: OK });
    }),
    gaps: sources.filter((s) => !s.ok).map((s) => C.gap(`sources.${s.kind}`, s.error || "lookup failed", `${(KINDS[s.kind] || { what: s.kind }).what} not assessed`)),
  });
}

function withVerified(route, out, version, nowMs = Date.now()) {
  if (route === "/v1/brand/scan" || route === "/v1/brand/lookalikes") return { ...out, verified: forReport(route, out, version, nowMs) };
  if (route === "/v1/brand/evidence") return { ...out, verified: forEvidence(out, version, nowMs) };
  return out;
}

module.exports = { withVerified };
