// Service pack template: a paid Pocket service that answers from the PMIC hub.
//
// Every pack is this file plus a pack.json. The pack never fetches public sources itself; it asks
// the hub (http://pmic-hub-backend:8080 on the pocket-supplier network) with its fixed scope merged in,
// caches answers for cache_seconds, and serves the last good answer if the hub is briefly away.
//
//   POST /v1/signals  {horizon?, sort?, direction?, min_confidence?, limit?, entity_id?, industry?, geography?}
//   POST /v1/signal   {series_id}                (must be inside the pack's scope)
//   POST /v1/explain  {series_id, horizon?}
//   POST /v1/events   {entity_id?, event_type?, severity?, since?, limit?}
//   POST /v1/catalog  {entity_id?, industry?, geography?, q?}
//   GET  /v1/version, /v1/health
"use strict";

const path = require("path");
const { createServer, ClientError } = require("./lib/http");
const { fetchJSON, cached } = require("./lib/net");

const PACK = require(path.join(__dirname, process.env.PACK_FILE || "pack.json"));
const HUB = (process.env.PMIC_HUB_URL || "http://pmic-hub-backend:8080").replace(/\/$/, "");
const TOKEN = process.env.PMIC_API_TOKEN || "";
const PORT = Number(process.env.PORT || 8080);
const TTL = (PACK.cache_seconds || 300) * 1000;
const PASS = ["horizon", "sort", "direction", "min_confidence", "limit", "entity_id", "industry", "geography", "q", "series_id", "event_type", "severity", "since", "from", "to"];

function pick(body) {
  const out = {};
  for (const k of PASS) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}

async function hub(route, body) {
  const key = `${route} ${JSON.stringify(body)}`;
  const r = await cached(key, TTL, async () => {
    const res = await fetchJSON(`${HUB}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) });
    // Hub 4xx are the caller's input problems: pass them through as 400 with the hub's reason.
    if (!res.ok) throw new ClientError(400, (res.body.error && res.body.error.code) || "invalid_input", (res.body.error && res.body.error.message) || `hub answered ${res.status}`);
    return res.body;
  });
  const { service, ...rest } = r.value;
  return { service: PACK.service_id, pack_version: PACK.version, cache: { stale: r.stale, age_seconds: Math.round(r.ageMs / 1000) }, ...rest };
}

const scoped = (body) => ({ ...pick(body), ...PACK.scope });

let scopeIds = { at: 0, ids: null };
async function inScope(seriesId) {
  if (typeof seriesId !== "string" || !seriesId) throw new ClientError(400, "invalid_input", "field 'series_id' is required; list ids with POST /v1/catalog");
  if (!scopeIds.ids || Date.now() - scopeIds.at > TTL) {
    const c = await hub("/v1/catalog", { ...PACK.scope, limit: 2000 });
    scopeIds = { at: Date.now(), ids: new Set(c.series.map((s) => s.series_id)) };
  }
  if (!scopeIds.ids.has(seriesId)) throw new ClientError(400, "unknown_series", `'${seriesId}' is not covered by ${PACK.service_id}; list ids with POST /v1/catalog`);
}

const routes = new Map([
  ["POST /v1/signals", (b) => hub("/v1/signals", { horizon: PACK.default_horizon, ...scoped(b) })],
  ["POST /v1/signal", async (b) => { await inScope(b && b.series_id); return hub("/v1/signal", { series_id: b.series_id }); }],
  ["POST /v1/explain", async (b) => { await inScope(b && b.series_id); return hub("/v1/explain", { series_id: b.series_id, horizon: (b && b.horizon) || PACK.default_horizon }); }],
  ["POST /v1/events", (b) => hub("/v1/events", { ...pick(b), ...(PACK.events_scope || {}) })],
  ["POST /v1/catalog", (b) => hub("/v1/catalog", scoped(b))],
]);

if (require.main === module) {
  createServer({ service: PACK.service_id, version: PACK.version, versionPath: "/v1/version", healthPath: "/v1/health", routes })
    .listen(PORT, () => console.log(JSON.stringify({ service: PACK.service_id, version: PACK.version, port: PORT, hub: HUB, listening: true })));
}

module.exports = { routes, PACK };
