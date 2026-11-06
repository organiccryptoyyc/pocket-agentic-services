// Brand Protection Monitor: a Pocket Network service.
//
// Finds lookalike domains of a brand (typos, homoglyphs, TLD swaps, added
// words like "-claim" or "-airdrop", and names seen in Certificate
// Transparency logs), checks which ones exist, and for those reads the
// registry (RDAP), the TLS certificate and the homepage. Each finding gets a
// deterministic 0-100 risk score with reasons and an evidence record with
// fetch times and SHA-256 hashes. Detection and evidence only: no takedowns.
//
// The Raspberry Pi collector runs the full scans and pushes them through the
// private ingest listener (lib/ingest.js). This server answers from that
// store; for a brand nobody has watched yet it runs a quick, deadline-bounded
// DNS-only scan and queues the brand for the Pi's next full run.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const { cached } = require("./lib/net");
const checks = require("./lib/checks");
const store = require("./lib/store");
const { scanBrand, brandIdFor } = require("./lib/scan");
const { startIngest } = require("./lib/ingest");

const SERVICE = "brand-protection";
const VERSION = "0.1.7";
const QUICK = {
  deadlineMs: Number(process.env.BP_QUICK_DEADLINE_MS || 9000),
  maxCandidates: Number(process.env.BP_QUICK_MAX_CANDIDATES || 120),
  dnsConcurrency: 40,
  deepLimit: 0,
  skipOfficial: true,
};
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// --- input ------------------------------------------------------------------

function domainList(body, field, max) {
  const v = body?.[field];
  if (!Array.isArray(v) || v.length < 1 || v.length > max) {
    throw new ClientError(422, "invalid_input", `field '${field}' must be an array of 1-${max} domain names`);
  }
  return v.map((d) => {
    const s = typeof d === "string" ? d.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!checks.isValidDomain(s)) throw new ClientError(422, "invalid_input", `'${d}' in '${field}' is not a valid domain name (e.g. "uniswap.org")`);
    return s;
  });
}

function oneDomain(body, field) {
  return domainList({ [field]: [body?.[field]] }, field, 1)[0];
}

function brandRequest(body) {
  const official_domains = domainList(body, "official_domains", 5);
  const brand = typeof body?.brand === "string" && body.brand.trim() ? body.brand.trim().slice(0, 64) : official_domains[0];
  const kw = body?.keywords === undefined ? [] : body.keywords;
  if (!Array.isArray(kw) || kw.length > 10 || !kw.every((k) => typeof k === "string" && k.length <= 40)) {
    throw new ClientError(422, "invalid_input", "field 'keywords' must be an array of at most 10 strings (40 chars each)");
  }
  return { brand, official_domains, keywords: kw };
}

function sinceAndLimit(body) {
  let since = null;
  if (body?.since !== undefined) {
    since = Date.parse(body.since);
    if (!Number.isFinite(since)) throw new ClientError(422, "invalid_input", "field 'since' must be an RFC 3339 timestamp, e.g. 2026-11-01T00:00:00Z");
  }
  const limit = body?.limit === undefined ? DEFAULT_LIMIT : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ClientError(422, "invalid_input", `field 'limit' must be an integer 1-${MAX_LIMIT}`);
  return { since, limit };
}

// --- output -----------------------------------------------------------------

function report(doc, { since, limit }, extra = {}) {
  let findings = doc.findings;
  if (since !== null) findings = findings.filter((f) => Date.parse(f.changed_at || f.first_seen) > since);
  const ageHours = Math.round((Date.now() - Date.parse(doc.as_of)) / 360_000) / 10;
  return {
    service: SERVICE,
    version: VERSION,
    fetched_at: new Date().toISOString(),
    brand_id: doc.brand_id,
    brand: doc.brand,
    official_domains: doc.official_domains,
    as_of: doc.as_of,
    age_hours: ageHours,
    scan_type: doc.scan_type,
    ...extra,
    collector_warnings: doc.collector_warnings || [],
    method: doc.method,
    coverage: doc.coverage,
    since: since === null ? null : new Date(since).toISOString(),
    findings_total: findings.length,
    findings_returned: Math.min(limit, findings.length),
    findings: findings.slice(0, limit),
    risk_scale: "0-100, higher means more signs of impersonation; 70+ high, 40-69 medium; unchecked means only DNS was read, so the page and registry have not been assessed and the number is a floor, not a verdict",
    note: "Findings are observed signals (lookalike name, recent registration, fresh certificate, page copies the brand, " +
      "wallet or password prompt), not a finding of fraud. Detection and evidence only. Fetch /v1/brand/evidence " +
      "with a finding's evidence_id for fetch times and SHA-256 hashes.",
  };
}

// One quick scan per brand at a time, however many callers ask at once.
const inFlight = new Map();

async function quickScan(req) {
  const id = brandIdFor(req.official_domains);
  if (!inFlight.has(id)) {
    inFlight.set(id, (async () => {
      try {
        const result = await scanBrand(req, QUICK);
        return store.saveResult({ ...result, scan_type: "quick" });
      } finally {
        inFlight.delete(id);
      }
    })());
  }
  return inFlight.get(id);
}

// --- routes -----------------------------------------------------------------

async function handleScan(body) {
  const req = brandRequest(body);
  const opts = sinceAndLimit(body);
  const brand_id = brandIdFor(req.official_domains);
  const watch = store.touchWatch({ brand_id, ...req });
  let doc = store.loadBrand(brand_id);
  let queued = false;
  if (!doc) {
    doc = await quickScan(req);
    queued = true;
  }
  const full = doc.scan_type === "full";
  return report(doc, opts, {
    full_scan: full ? "done" : (watch.added === false && watch.reason ? "not_queued_watch_list_full" : "queued"),
    ...(queued || !full ? { next_step: "A full scan (registry, certificate and homepage checks) runs on the collector's next cycle; call again later." } : {}),
  });
}

async function handleLookalikes(body) {
  const domain = oneDomain(body, "domain");
  const opts = sinceAndLimit(body);
  const brand_id = brandIdFor([domain]);
  const stored = store.loadBrand(brand_id);
  if (stored) return report(stored, opts, { source: "watch_list" });
  const { value } = await cached(`lookalikes:${brand_id}`, 3_600_000, () => scanBrand({ brand: domain, official_domains: [domain] }, QUICK));
  return report({ ...value, scan_type: "quick" }, opts, {
    source: "live_dns_only",
    next_step: "Call POST /v1/brand/scan to add this brand to the watch list for full checks.",
  });
}

async function handleEvidence(body) {
  const id = body?.evidence_id;
  if (typeof id !== "string" || !store.EVIDENCE_ID_RE.test(id)) {
    throw new ClientError(422, "invalid_input", "field 'evidence_id' must be the 24-hex id from a finding");
  }
  const e = store.loadEvidence(id);
  if (!e) throw new ClientError(404, "not_found", `no evidence record '${id}' (records are kept while their finding is current, and 30 days after)`);
  return { service: SERVICE, version: VERSION, fetched_at: new Date().toISOString(), ...e };
}

async function handleWatched() {
  const w = store.loadWatch();
  const brands = Object.entries(w.brands).map(([brand_id, b]) => {
    const doc = store.loadBrand(brand_id);
    return {
      brand_id,
      brand: b.brand,
      official_domains: b.official_domains,
      watched_since: b.added_at,
      last_scan_at: doc ? doc.as_of : null,
      scan_type: doc ? doc.scan_type : null,
      high_risk_findings: doc ? doc.findings.filter((f) => f.risk_level === "high").length : 0,
    };
  }).sort((a, b) => a.brand_id.localeCompare(b.brand_id));
  return { service: SERVICE, version: VERSION, fetched_at: new Date().toISOString(), count: brands.length, max_watched: store.MAX_WATCHED, brands };
}

const routes = new Map([
  ["POST /v1/brand/scan", handleScan],
  ["POST /v1/brand/lookalikes", handleLookalikes],
  ["POST /v1/brand/evidence", handleEvidence],
  ["GET /v1/brand/watched", handleWatched],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: "/v1/version", healthPath: "/v1/health", routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => console.log(`${SERVICE} v${VERSION} listening on :${PORT}`));
const ingest = startIngest();

module.exports = { server, ingest };
