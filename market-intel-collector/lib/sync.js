// Collector -> hub replication, the same shape as the TCS-6 Pi collector pushing evidence to
// the Hetzner box: the Pi pushes normalized observations, revisions and events (never raw
// payloads) to the hub's private ingest listener with a bearer token. The hub has the same
// config, applies its own retention, and rescores what it received, so the service packs on the
// hub read exactly what the Pi computed.
"use strict";

const http = require("http");
const crypto = require("crypto");
const { sendJson, readJsonBody, ClientError } = require("./http");
const { tx, kvGet, kvSet, syncCatalog } = require("./db");
const { rescoreAll } = require("./collect");

const BATCH = Number(process.env.PMIC_PUSH_BATCH || 2000);
const MAX_SYNC_BYTES = 8 * 1024 * 1024;
const OBS_COLS = ["source_id", "series_id", "entity_id", "metric_name", "metric_value", "unit", "observation_time", "period", "fetch_time", "source_url",
  "raw_sha256", "transform_version", "retention_class", "confidence_score", "qc_flags", "revision", "updated_at"];
const EVT_COLS = ["source_id", "external_id", "entity_id", "event_type", "event_time", "title", "severity", "detail_json", "source_url", "raw_sha256",
  "fetch_time", "retention_class", "updated_at"];

// Cursor-paged reads: (updated_at, id) so thousands of rows sharing one timestamp page cleanly.
function page(db, table, cols, cursor) {
  return db.prepare(`SELECT id, ${cols.join(", ")} FROM ${table} WHERE updated_at > ? OR (updated_at = ? AND id > ?) ORDER BY updated_at, id LIMIT ?`)
    .all(cursor.t, cursor.t, cursor.id, BATCH);
}

async function push(db, { url, token, fetchImpl = fetch, statusExtra = {} } = {}) {
  if (!url || !token) throw new Error("PMIC_PUSH_URL and PMIC_PUSH_TOKEN are required to push");
  const cur = kvGet(db, "push_cursor") || { obs: { t: "", id: 0 }, evt: { t: "", id: 0 } };
  let sent = { observations: 0, events: 0, requests: 0 };
  for (;;) {
    const obs = page(db, "observations", OBS_COLS, cur.obs);
    const evt = page(db, "events", EVT_COLS, cur.evt);
    const revIds = obs.map((o) => o.id);
    const revisions = revIds.length
      ? db.prepare(`SELECT o.source_id, o.entity_id, o.observation_time, o.metric_name, r.revision, r.metric_value, r.fetch_time, r.raw_sha256, r.replaced_at
          FROM observation_revisions r JOIN observations o ON o.id = r.observation_id WHERE r.observation_id IN (${revIds.map(() => "?").join(",")})`).all(...revIds)
      : [];
    const last = obs.length < BATCH && evt.length < BATCH;
    const body = {
      pushed_at: new Date().toISOString(),
      observations: obs.map(({ id, ...r }) => r),
      revisions,
      events: evt.map(({ id, ...r }) => r),
      collector_status: last ? { last_collect: kvGet(db, "last_collect"), maintenance_last: kvGet(db, "maintenance_last"), open_alerts: db.prepare("SELECT kind, source_id, series_id, detail, last_seen, count FROM alerts WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT 200").all(), ...statusExtra } : null,
    };
    if (!obs.length && !evt.length && sent.requests > 0) break;
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`hub answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    sent.requests++;
    sent.observations += obs.length;
    sent.events += evt.length;
    if (obs.length) cur.obs = { t: obs[obs.length - 1].updated_at, id: obs[obs.length - 1].id };
    if (evt.length) cur.evt = { t: evt[evt.length - 1].updated_at, id: evt[evt.length - 1].id };
    kvSet(db, "push_cursor", cur);
    if (last) break;
  }
  kvSet(db, "last_push", { at: new Date().toISOString(), ...sent });
  return sent;
}

// Hub side: upsert what arrived, keep the collector's own fetch_time/revision/provenance, rescore.
function apply(db, catalog, body, now = new Date()) {
  if (!body || !Array.isArray(body.observations) || !Array.isArray(body.events)) throw new ClientError(400, "invalid_input", "body needs observations[] and events[]");
  const known = new Set(catalog.series.map((s) => s.series_id));
  const knownEntities = new Set(catalog.entities.map((e) => e.entity_id));
  const touched = new Set();
  let skipped = 0;
  tx(db, () => {
    const upObs = db.prepare(`INSERT INTO observations (${OBS_COLS.join(", ")}) VALUES (${OBS_COLS.map(() => "?").join(", ")})
      ON CONFLICT (source_id, entity_id, observation_time, metric_name) DO UPDATE SET ${OBS_COLS.filter((c) => !["source_id", "entity_id", "observation_time", "metric_name"].includes(c)).map((c) => `${c}=excluded.${c}`).join(", ")}`);
    for (const o of body.observations) {
      if (!known.has(o.series_id) || typeof o.metric_value !== "number") { skipped++; continue; }
      upObs.run(...OBS_COLS.map((c) => (o[c] === undefined ? null : o[c])));
      touched.add(o.series_id);
    }
    const upRev = db.prepare(`INSERT OR IGNORE INTO observation_revisions (observation_id, revision, metric_value, fetch_time, raw_sha256, replaced_at)
      SELECT id, ?, ?, ?, ?, ? FROM observations WHERE source_id = ? AND entity_id = ? AND observation_time = ? AND metric_name = ?`);
    for (const r of body.revisions || []) upRev.run(r.revision, r.metric_value, r.fetch_time, r.raw_sha256, r.replaced_at, r.source_id, r.entity_id, r.observation_time, r.metric_name);
    const upEvt = db.prepare(`INSERT INTO events (${EVT_COLS.join(", ")}) VALUES (${EVT_COLS.map(() => "?").join(", ")})
      ON CONFLICT (source_id, external_id) DO UPDATE SET ${EVT_COLS.filter((c) => !["source_id", "external_id"].includes(c)).map((c) => `${c}=excluded.${c}`).join(", ")}`);
    for (const e of body.events) {
      if (!knownEntities.has(e.entity_id)) { skipped++; continue; }
      upEvt.run(...EVT_COLS.map((c) => (e[c] === undefined ? null : e[c])));
    }
    if (body.collector_status) kvSet(db, "collector_status", { received_at: now.toISOString(), ...body.collector_status });
    kvSet(db, "last_sync", { at: now.toISOString(), observations: body.observations.length, events: body.events.length, skipped });
  });
  const rescored = touched.size ? rescoreAll(db, catalog, { now, seriesIds: [...touched] }) : 0;
  return { accepted_observations: body.observations.length - skipped, events: body.events.length, skipped, rescored };
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// Private listener on its own port (default 127.0.0.1:8091), never the RelayMiner backend.
function startIngest({ openDb, catalog }) {
  const token = process.env.PMIC_INGEST_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ ingest: "disabled", reason: "PMIC_INGEST_TOKEN not set" }));
    return null;
  }
  const host = process.env.PMIC_INGEST_HOST || "127.0.0.1";
  const port = Number(process.env.PMIC_INGEST_PORT || 8091);
  const db = openDb();
  syncCatalog(db, catalog);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/ingest/sync") return sendJson(res, 404, { error: { code: "not_found", message: "POST /ingest/sync only" } });
      if (!tokenOk(req.headers.authorization, token)) return sendJson(res, 401, { error: { code: "unauthorized", message: "bearer token required" } });
      const body = await readJsonBody(req, MAX_SYNC_BYTES);
      return sendJson(res, 200, apply(db, catalog, body));
    } catch (e) {
      return sendJson(res, e instanceof ClientError ? e.status : 400, { error: { code: e.code || "ingest_error", message: String(e.message).slice(0, 300) } });
    }
  });
  server.listen(port, host, () => console.log(JSON.stringify({ ingest: "listening", host, port })));
  return server;
}

module.exports = { push, apply, startIngest, tokenOk };
