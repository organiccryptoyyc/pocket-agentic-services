// Internal, read-only domain lookup for other backends on the same Docker network
// (agent-trust's /v1/preflight). Given one domain, it says whether that domain is the
// official domain of a watched brand, a lookalike we have a finding for, or unknown to us.
//
//   GET /internal/domain?domain=<name>
//
// Own port (default 127.0.0.1:8091; the compose file sets 0.0.0.0 inside the
// container). It is never put in deploy/routes.json, so Caddy never routes to it and the
// RelayMiner (backend_url :8080) can't reach it. No token: it returns only what the paid
// API already sells, from the stored reports, and it never starts a scan.
"use strict";

const http = require("http");
const { sendJson } = require("./http");
const store = require("./store");
const { isValidDomain } = require("./checks");

const INDEX_TTL_MS = 60_000;
let index = null; // { builtAt, official: Map<domain, brand>, findings: Map<domain, [{brand, finding}]> }

function buildIndex(now = Date.now()) {
  const official = new Map();
  const findings = new Map();
  const w = store.loadWatch();
  for (const [brand_id, b] of Object.entries(w.brands)) {
    const doc = store.loadBrand(brand_id);
    const brand = { brand_id, brand: b.brand, official_domains: b.official_domains, as_of: doc ? doc.as_of : null, scan_type: doc ? doc.scan_type : null };
    for (const d of b.official_domains || []) official.set(d, brand);
    for (const f of doc ? doc.findings : []) {
      if (!findings.has(f.domain)) findings.set(f.domain, []);
      findings.get(f.domain).push({ brand, finding: f });
    }
  }
  return { builtAt: now, official, findings };
}

function normalise(domain) {
  return String(domain || "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

// match: "official" | "lookalike" | "none". `watched_brands` says how many brands the
// answer covers: "none" means no finding among those brands, not that the domain is safe.
function lookupDomain(domain, now = Date.now()) {
  const d = normalise(domain);
  if (!index || now - index.builtAt > INDEX_TTL_MS) index = buildIndex(now);
  const watched = index.official.size ? new Set([...index.official.values()].map((b) => b.brand_id)).size : 0;
  const base = { domain: d, watched_brands: watched, index_built_at: new Date(index.builtAt).toISOString() };
  const own = index.official.get(d);
  if (own) return { ...base, match: "official", brand: own, findings: [] };
  const hits = (index.findings.get(d) || []).map(({ brand, finding: f }) => ({
    brand_id: brand.brand_id,
    brand: brand.brand,
    official_domains: brand.official_domains,
    report_as_of: brand.as_of,
    scan_type: brand.scan_type,
    risk: f.risk,
    risk_level: f.risk_level,
    status: f.status,
    first_seen: f.first_seen || null,
    changed_at: f.changed_at || null,
    evidence_id: f.evidence_id || null,
  })).sort((a, b) => b.risk - a.risk);
  return { ...base, match: hits.length ? "lookalike" : "none", brand: null, findings: hits };
}

function resetIndex() {
  index = null;
}

function startLookup() {
  if (process.env.BP_LOOKUP_PORT === "off") return null;
  const host = process.env.BP_LOOKUP_HOST || "127.0.0.1";
  const port = Number(process.env.BP_LOOKUP_PORT || 8091);
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (req.method !== "GET" || u.pathname !== "/internal/domain") {
        return sendJson(res, 404, { error: { code: "not_found", message: "GET /internal/domain?domain=<name>" } });
      }
      const d = normalise(u.searchParams.get("domain"));
      if (!isValidDomain(d)) return sendJson(res, 400, { error: { code: "invalid_input", message: "domain must be a valid domain name" } });
      return sendJson(res, 200, lookupDomain(d));
    } catch (e) {
      return sendJson(res, 400, { error: { code: "lookup_error", message: String(e.message).slice(0, 200) } });
    }
  });
  server.listen(port, host, () => console.log(JSON.stringify({ lookup: "listening", host, port })));
  return server;
}

module.exports = { lookupDomain, startLookup, resetIndex, normalise };
