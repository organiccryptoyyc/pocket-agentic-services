// Private evidence-ingest listener for the Raspberry Pi collector.
//
//   POST /ingest/evidence   Authorization: Bearer <TCS6_INGEST_TOKEN>
//   body: one evidence bundle (EVIDENCE.md) or {"bundles": [...]}
//
// Separate port from the paid API (default 127.0.0.1:8090) so it can never
// be reached through the RelayMiner, whose backend_url points at :8080 only.
// Expose it to the Pi through Caddy on its own hostname or over a private
// tunnel — never via the public relay endpoint. Disabled when no token is set.
"use strict";

const http = require("http");
const crypto = require("crypto");
const { sendJson, readJsonBody, ClientError } = require("./http");
const store = require("./store");

const ASSET_CLASSES = new Set(require("./scoring").ASSET_CLASSES);
const MAX_BUNDLES = 50;

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// Shape check only; the pipeline's schema validation is the real gate.
function checkBundle(b, registryIds) {
  const problems = [];
  if (!b || typeof b !== "object") return ["bundle must be an object"];
  if (!registryIds.has(b.entity_id)) problems.push(`entity_id '${b.entity_id}' not in registry`);
  if (!Number.isFinite(Date.parse(b.collected_at))) problems.push("collected_at must be an RFC 3339 timestamp");
  if (!Array.isArray(b.holdings)) problems.push("holdings must be an array");
  else b.holdings.forEach((h, i) => {
    if (!ASSET_CLASSES.has(h.asset_class)) problems.push(`holdings[${i}].asset_class invalid`);
    if (h.control !== "verified" && h.control !== "unverified") problems.push(`holdings[${i}].control must be verified|unverified`);
  });
  if (!Array.isArray(b.sources)) problems.push("sources must be an array");
  return problems;
}

function startIngest() {
  const token = process.env.TCS6_INGEST_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ ingest: "disabled", reason: "TCS6_INGEST_TOKEN not set" }));
    return null;
  }
  const host = process.env.TCS6_INGEST_HOST || "127.0.0.1";
  const port = Number(process.env.TCS6_INGEST_PORT || 8090);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/ingest/evidence") {
        return sendJson(res, 404, { error: { code: "not_found", message: "POST /ingest/evidence only" } });
      }
      if (!tokenOk(req.headers.authorization, token)) return sendJson(res, 401, { error: { code: "unauthorized", message: "bearer token required" } });
      const body = await readJsonBody(req);
      const bundles = Array.isArray(body.bundles) ? body.bundles : [body];
      if (bundles.length > MAX_BUNDLES) throw new ClientError(400, "too_many_bundles", `at most ${MAX_BUNDLES} per request`);
      const ids = new Set(store.loadRegistry().map((e) => e.entity_id));
      const accepted = [];
      const rejected = [];
      for (const b of bundles) {
        const problems = checkBundle(b, ids);
        if (problems.length) rejected.push({ entity_id: b && b.entity_id, problems });
        else {
          store.writeJsonAtomic(store.paths.evidence(b.entity_id), b);
          accepted.push(b.entity_id);
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

module.exports = { startIngest, checkBundle };
