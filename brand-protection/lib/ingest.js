// Private listener for the Raspberry Pi collector (same pattern as TCS-6).
//
//   GET  /ingest/watch     -> the watch list, so the Pi knows what to scan
//   POST /ingest/watch     {brands: [{brand, official_domains, keywords}]}  seed brands (owner-approved list)
//   POST /ingest/results   {results: [scanResult, ...]}                     full scans from the Pi
//   Authorization: Bearer <BP_INGEST_TOKEN>
//
// Separate port from the paid API (default 127.0.0.1:8090), so the RelayMiner,
// whose backend_url points at :8080, can never reach it. Disabled without a token.
"use strict";

const http = require("http");
const crypto = require("crypto");
const { sendJson, readJsonBody, ClientError } = require("./http");
const store = require("./store");
const { isValidDomain } = require("./checks");
const { brandIdFor } = require("./scan");

const MAX_RESULTS = 50;
const MAX_FINDINGS = 3000;
const SECRET_RES = [/CG-[A-Za-z0-9]{20,}/, /\b[0-9a-f]{64}\b/, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/];

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function checkBrandEntry(b) {
  const problems = [];
  if (!b || typeof b !== "object") return ["brand entry must be an object"];
  if (typeof b.brand !== "string" || !b.brand.trim() || b.brand.length > 64) problems.push("brand must be a string of 1-64 chars");
  if (!Array.isArray(b.official_domains) || b.official_domains.length < 1 || b.official_domains.length > 5 || !b.official_domains.every(isValidDomain)) {
    problems.push("official_domains must be 1-5 lowercase domain names");
  }
  if (b.keywords !== undefined && (!Array.isArray(b.keywords) || b.keywords.length > 10)) problems.push("keywords must be an array of at most 10");
  return problems;
}

// Shape check plus a secret scan. Certificate fingerprints are colon-separated
// hex, and page/icon hashes are 64-hex by design, so those fields are skipped.
function checkResult(r, watch) {
  const problems = [];
  if (!r || typeof r !== "object") return ["result must be an object"];
  if (!watch.brands[r.brand_id]) problems.push(`brand_id '${r.brand_id}' is not on the watch list`);
  if (!Number.isFinite(Date.parse(r.as_of))) problems.push("as_of must be an RFC 3339 timestamp");
  if (!Array.isArray(r.findings) || r.findings.length > MAX_FINDINGS) problems.push(`findings must be an array of at most ${MAX_FINDINGS}`);
  if (!Array.isArray(r.evidence)) problems.push("evidence must be an array");
  if (problems.length) return problems;
  const ids = new Set(r.evidence.map((e) => e.evidence_id));
  r.evidence.forEach((e, i) => { if (!store.EVIDENCE_ID_RE.test(e.evidence_id || "")) problems.push(`evidence[${i}].evidence_id invalid`); });
  r.findings.forEach((f, i) => {
    if (!isValidDomain(f.domain)) problems.push(`findings[${i}].domain invalid`);
    if (!(f.risk >= 0 && f.risk <= 100)) problems.push(`findings[${i}].risk must be 0-100`);
    if (!ids.has(f.evidence_id)) problems.push(`findings[${i}].evidence_id has no evidence record`);
  });
  const text = JSON.stringify(r, (k, v) => (k === "sha256" || k === "icon_sha256" || k === "sha256_fingerprint" ? undefined : v));
  if (SECRET_RES.some((re) => re.test(text))) problems.push("result contains a key-like string; not stored");
  return problems;
}

function startIngest() {
  const token = process.env.BP_INGEST_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ ingest: "disabled", reason: "BP_INGEST_TOKEN not set" }));
    return null;
  }
  const host = process.env.BP_INGEST_HOST || "127.0.0.1";
  const port = Number(process.env.BP_INGEST_PORT || 8090);
  const server = http.createServer(async (req, res) => {
    try {
      const route = `${req.method} ${new URL(req.url, "http://x").pathname}`;
      if (!["GET /ingest/watch", "POST /ingest/watch", "POST /ingest/results"].includes(route)) {
        return sendJson(res, 404, { error: { code: "not_found", message: "GET|POST /ingest/watch, POST /ingest/results" } });
      }
      if (!tokenOk(req.headers.authorization, token)) return sendJson(res, 401, { error: { code: "unauthorized", message: "bearer token required" } });
      if (route === "GET /ingest/watch") {
        const w = store.loadWatch();
        const brands = Object.entries(w.brands).map(([brand_id, b]) => {
          const doc = store.loadBrand(brand_id);
          return { brand_id, ...b, last_full_scan_at: doc && doc.scan_type === "full" ? doc.as_of : null };
        });
        return sendJson(res, 200, { brands, max_watched: store.MAX_WATCHED });
      }
      const body = await readJsonBody(req);
      if (route === "POST /ingest/watch") {
        const list = Array.isArray(body.brands) ? body.brands : [];
        const accepted = [];
        const rejected = [];
        for (const b of list) {
          const problems = checkBrandEntry(b);
          if (problems.length) { rejected.push({ brand: b && b.brand, problems }); continue; }
          const brand_id = brandIdFor(b.official_domains);
          const r = store.touchWatch({ brand_id, brand: b.brand.trim(), official_domains: b.official_domains, keywords: b.keywords || [] }, { source: "seed" });
          if (r.added === false && r.reason) rejected.push({ brand: b.brand, problems: [r.reason] });
          else accepted.push(brand_id);
        }
        return sendJson(res, 200, { accepted, rejected });
      }
      const results = Array.isArray(body.results) ? body.results : [];
      if (results.length > MAX_RESULTS) throw new ClientError(400, "too_many_results", `at most ${MAX_RESULTS} per request`);
      const watch = store.loadWatch();
      const accepted = [];
      const rejected = [];
      for (const r of results) {
        const problems = checkResult(r, watch);
        if (problems.length) rejected.push({ brand_id: r && r.brand_id, problems: problems.slice(0, 10) });
        else {
          store.saveResult({ ...r, scan_type: "full" });
          accepted.push(r.brand_id);
        }
      }
      return sendJson(res, rejected.length && !accepted.length ? 400 : 200, { accepted, rejected });
    } catch (e) {
      const status = e instanceof ClientError ? e.status : 400;
      return sendJson(res, status, { error: { code: e.code || "ingest_error", message: String(e.message).slice(0, 300) } });
    }
  });
  server.listen(port, host, () => console.log(JSON.stringify({ ingest: "listening", host, port })));
  return server;
}

module.exports = { startIngest, checkResult, checkBrandEntry, tokenOk };
