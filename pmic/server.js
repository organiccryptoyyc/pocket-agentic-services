// Public Market Intelligence Collection: query API.
//
// The read side every service pack builds on. Same contract as the other packages in this repo:
// JSON object bodies only, inputs in the POST body, 400 + JSON on bad input, never a 5xx.
//
//   POST /v1/catalog   {category?, industry?, geography?, entity_id?, source_id?, q?}
//   POST /v1/signal    {series_id} | {entity_id, metric_name}       one sourced, scored answer
//   POST /v1/signals   {filters..., horizon?, sort?, direction?, min_confidence?, limit?}
//   POST /v1/series    {series_id, from?, to?, limit?, include_rollups?}
//   POST /v1/explain   {series_id, horizon?}                          "why" from stored deltas
//   POST /v1/events    {entity_id?, event_type?, severity?, industry?, since?, limit?}
//   POST /v1/entities  {entity_type?, industry?, geography?}
//   POST /v1/sources   {}                                             source health + collector status
//   POST /v1/alerts    {open_only?, source_id?, limit?}
//   GET  /v1/version, /v1/health (also /healthz, for PSM)
//
// The API only reads (the database is opened read-only); bin/collect.js writes. When
// PMIC_API_TOKEN is set every POST route needs "Authorization: Bearer <token>": the collector API
// is private infrastructure, and the paid Pocket service packs are what face the gateway.
// With PMIC_INGEST_TOKEN set (hub mode) a second private listener accepts pushes from the Pi.
"use strict";

const crypto = require("crypto");
const { createServer, ClientError } = require("./lib/http");
const db = require("./lib/db");
const catalogLib = require("./lib/catalog");
const Q = require("./lib/query");
const { startIngest } = require("./lib/sync");

const SERVICE = "pmic";
const VERSION = "0.1.0";
const PORT = Number(process.env.PORT || 8088);

let _db = null;
function rdb() {
  if (!_db) _db = db.open({ readOnly: true });
  if (!_db) throw new ClientError(400, "not_ready", "the collector has not written any data yet; run bin/collect.js first");
  return _db;
}

function authorize(req) {
  const token = process.env.PMIC_API_TOKEN;
  if (!token) return;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const a = crypto.createHash("sha256").update(m ? m[1] : "").digest();
  const b = crypto.createHash("sha256").update(token).digest();
  if (!m || !crypto.timingSafeEqual(a, b)) throw new ClientError(401, "unauthorized", "bearer token required");
}

function route(fn) {
  return async (body, req) => {
    authorize(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ClientError(400, "invalid_input", "body must be a JSON object");
    return { service: SERVICE, ...fn(rdb(), body) };
  };
}

function health() {
  const d = (() => { try { return rdb(); } catch { return null; } })();
  if (!d) return { role: process.env.PMIC_INGEST_TOKEN ? "hub" : "collector", ready: false };
  const get = (k) => { const r = d.prepare("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : null; };
  const last = get("last_collect");
  const sync = get("last_sync");
  return {
    role: process.env.PMIC_INGEST_TOKEN ? "hub" : "collector",
    ready: true,
    series: d.prepare("SELECT COUNT(*) n FROM series WHERE enabled = 1").get().n,
    scored_series: d.prepare("SELECT COUNT(DISTINCT series_id) n FROM scores").get().n,
    last_collect: last ? last.finished_at : null,
    last_sync: sync ? sync.at : null,
    open_alerts: d.prepare("SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL").get().n,
  };
}

function build() {
  return createServer({
    service: SERVICE,
    version: VERSION,
    versionPath: "/v1/version",
    healthPath: "/v1/health",
    health,
    routes: new Map([
      ["POST /v1/catalog", route(Q.catalog)],
      ["POST /v1/signal", route(Q.signal)],
      ["POST /v1/signals", route(Q.signals)],
      ["POST /v1/series", route(Q.series)],
      ["POST /v1/explain", route(Q.explain)],
      ["POST /v1/events", route(Q.events)],
      ["POST /v1/entities", route(Q.entities)],
      ["POST /v1/sources", route((d) => {
        const r = d.prepare("SELECT v FROM kv WHERE k = 'collector_status'").get();
        return Q.sources(d, { collectorStatus: r ? JSON.parse(r.v) : null });
      })],
      ["POST /v1/alerts", route(Q.alerts)],
    ]),
  });
}

if (require.main === module) {
  const catalog = catalogLib.load();
  // Make sure the schema and catalog exist before opening read-only.
  const w = db.open();
  db.syncCatalog(w, catalog);
  require("./lib/raw").purgeSources(db.DATA_DIR, catalog.purged_sources);
  w.close();
  build().listen(PORT, () => console.log(JSON.stringify({ service: SERVICE, version: VERSION, port: PORT, data_dir: db.DATA_DIR, listening: true })));
  startIngest({ openDb: () => db.open(), catalog });
}

module.exports = { build, SERVICE, VERSION };
