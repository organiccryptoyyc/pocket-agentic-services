// One collection pass: find due series, run each source's adapter, log every fetch, keep every
// raw payload, ingest through QC, then recompute derived metrics and scores for what changed.
"use strict";

const { fetchText, FetchError, redact } = require("./net");
const raw = require("./raw");
const { tx, syncCatalog, raiseAlert, resolveAlerts, kvGet, kvSet } = require("./db");
const { ingestObservation, ingestEvent } = require("./qc");
const { scoreSeries } = require("./derive");
const { SchemaError } = require("./adapters/common");

const ADAPTERS = {
  fred: require("./adapters/fred"),
  bls: require("./adapters/bls"),
  bea: require("./adapters/bea"),
  sec: require("./adapters/sec"),
  openfda: require("./adapters/openfda"),
  worldbank: require("./adapters/worldbank"),
  ecb: require("./adapters/ecb"),
  fdic: require("./adapters/fdic"),
  cfpb: require("./adapters/cfpb"),
  wikimedia: require("./adapters/wikimedia"),
  ctgov: require("./adapters/ctgov"),
  cpsc: require("./adapters/cpsc"),
  nhtsa: require("./adapters/nhtsa"),
  fec: require("./adapters/fec"),
  lda: require("./adapters/lda"),
  usaspending: require("./adapters/usaspending"),
  pinksheet: require("./adapters/pinksheet"),
};

const DAY = 86400000;
// After a failed attempt, wait this long before retrying (or the series cadence, if shorter).
const FAILURE_BACKOFF_MIN = Number(process.env.PMIC_FAILURE_BACKOFF_MIN || 60);

function dueSeries(db, catalog, { now, force = false, sources = null, seriesIds = null }) {
  const state = new Map(db.prepare("SELECT series_id, last_attempt_at, last_success_at FROM series").all().map((r) => [r.series_id, r]));
  return catalog.series.filter((s) => {
    if (sources && !sources.includes(s.source_id)) return false;
    if (seriesIds && !seriesIds.includes(s.series_id)) return false;
    if (force) return true;
    const st = state.get(s.series_id) || {};
    const since = (iso) => (iso ? (now.getTime() - Date.parse(iso)) / 60000 : Infinity);
    if (since(st.last_success_at) < s.cadence_minutes) return false;
    const failedLast = st.last_attempt_at && (!st.last_success_at || st.last_attempt_at > st.last_success_at);
    if (failedLast && since(st.last_attempt_at) < Math.min(FAILURE_BACKOFF_MIN, s.cadence_minutes)) return false;
    return true;
  });
}

function makeCtx(db, catalog, source, { now, dataDir, env, fetchImpl }) {
  const nowIso = now.toISOString();
  const failures = new Map();
  const fetchIds = new Map(); // sha -> fetch_log id
  const R = catalog.retention.classes;
  const watermark = kvGet(db, `events_watermark:${source.source_id}`);
  const ctx = {
    now,
    nowIso,
    env,
    catalog,
    source,
    failures,
    fetchIds,
    notes: [],
    since(s) {
      return new Date(now.getTime() - R[s.retention_class] * DAY).toISOString().slice(0, 10);
    },
    // Events: everything inside the standard event window on the first run, then 14 days of overlap.
    eventSince() {
      const full = new Date(now.getTime() - R.event_standard * DAY).toISOString().slice(0, 10);
      if (!watermark) return full;
      const inc = new Date(Date.parse(watermark) - 14 * DAY).toISOString().slice(0, 10);
      return inc > full ? inc : full;
    },
    async get(jobKey, url, init = {}, { allowStatus = [] } = {}) {
      const started = new Date().toISOString();
      const cleanUrl = redact(url);
      let r;
      try {
        r = await (fetchImpl || fetchText)(url, init);
      } catch (e) {
        db.prepare(`INSERT INTO fetch_logs (source_id, job_key, url, started_at, finished_at, http_status, ok, bytes, error)
          VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?)`).run(source.source_id, jobKey, cleanUrl, started, new Date().toISOString(), String(e.message).slice(0, 500));
        throw e;
      }
      const ok = (r.status >= 200 && r.status < 300) || allowStatus.includes(r.status);
      let stored = null;
      if (r.text) stored = raw.store(db, dataDir, { source_id: source.source_id, job_key: jobKey, url: cleanUrl, fetched_at: nowIso, status: r.status, content_type: r.contentType || null, body: r.text });
      const id = Number(db.prepare(`INSERT INTO fetch_logs (source_id, job_key, url, started_at, finished_at, http_status, ok, bytes, raw_sha256, raw_file, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(source.source_id, jobKey, cleanUrl, started, new Date().toISOString(), r.status, ok ? 1 : 0,
          Buffer.byteLength(r.text || ""), stored && stored.sha256, stored && stored.raw_file, ok ? null : `HTTP ${r.status}: ${String(r.text || "").slice(0, 300)}`).lastInsertRowid);
      if (!ok) throw new FetchError(`HTTP ${r.status} from ${cleanUrl}`, r.status);
      if (stored) fetchIds.set(stored.sha256, id);
      return { status: r.status, text: r.text, sha256: stored && stored.sha256, url: cleanUrl };
    },
    fail(seriesIds, err, { kind } = {}) {
      const k = kind || (err instanceof SchemaError ? "schema_change" : err instanceof FetchError ? "api_failure" : "api_failure");
      for (const id of seriesIds) failures.set(id, { kind: k, message: String(err.message || err).slice(0, 500) });
      if (!seriesIds.length) failures.set(`__source:${source.source_id}`, { kind: k, message: String(err.message || err).slice(0, 500) });
    },
    missingKey(sourceId, envName, seriesIds) {
      for (const id of seriesIds) failures.set(id, { kind: "missing_key", message: `${envName} is not set; ${sourceId} series are skipped` });
    },
    // Small per-source memory between passes (the Form 4 values already read, for example).
    kvGet(k) {
      return kvGet(db, `${source.source_id}:${k}`);
    },
    kvSet(k, v) {
      kvSet(db, `${source.source_id}:${k}`, v);
    },
    note(_src, msg) {
      ctx.notes.push(msg);
    },
  };
  return ctx;
}

async function runSource(db, catalog, source, series, opts) {
  const ctx = makeCtx(db, catalog, source, opts);
  const bySeries = new Map(series.map((s) => [s.series_id, s]));
  let result = { observations: [], events: [] };
  try {
    result = await ADAPTERS[source.source_id].collect(series, ctx);
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  const counts = { inserted: 0, revised: 0, unchanged: 0, rejected: 0, events: 0 };
  const perSeries = new Map();
  const perSha = new Map();
  const obs = result.observations.sort((a, b) => (a.observation_time < b.observation_time ? -1 : a.observation_time > b.observation_time ? 1 : 0));
  tx(db, () => {
    for (const rec of obs) {
      const s = bySeries.get(rec.series_id);
      if (!s || ctx.failures.has(rec.series_id)) continue;
      const outcome = ingestObservation(db, ctx, s, rec);
      counts[outcome]++;
      perSeries.set(rec.series_id, (perSeries.get(rec.series_id) || 0) + 1);
      if (rec.raw_sha256) perSha.set(rec.raw_sha256, (perSha.get(rec.raw_sha256) || 0) + 1);
    }
    for (const ev of result.events) {
      if (ingestEvent(db, ctx, ev)) counts.events++;
      if (ev.raw_sha256) perSha.set(ev.raw_sha256, (perSha.get(ev.raw_sha256) || 0) + 1);
    }
    for (const [sha, n] of perSha) {
      const id = ctx.fetchIds.get(sha);
      if (id) db.prepare("UPDATE fetch_logs SET records = ? WHERE id = ?").run(n, id);
    }
    const nowIso = ctx.nowIso;
    for (const s of series) {
      const f = ctx.failures.get(s.series_id);
      db.prepare("UPDATE series SET last_attempt_at = ? WHERE series_id = ?").run(nowIso, s.series_id);
      if (f) {
        raiseAlert(db, { kind: f.kind, source_id: s.source_id, series_id: s.series_id, entity_id: s.entity_id, detail: f.message }, nowIso);
        continue;
      }
      db.prepare("UPDATE series SET last_success_at = ? WHERE series_id = ?").run(nowIso, s.series_id);
      for (const kind of ["api_failure", "schema_change", "missing_key", "empty_response"]) {
        resolveAlerts(db, { kind, source_id: s.source_id, series_id: s.series_id, entity_id: s.entity_id }, nowIso);
      }
      if (!perSeries.get(s.series_id)) {
        const have = db.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = ?").get(s.series_id).n;
        if (!have) raiseAlert(db, { kind: "empty_response", source_id: s.source_id, series_id: s.series_id, entity_id: s.entity_id, detail: "fetch succeeded but returned no observations inside the retention window" }, nowIso);
      }
    }
    const srcFail = ctx.failures.get(`__source:${source.source_id}`);
    if (srcFail) raiseAlert(db, { kind: srcFail.kind, source_id: source.source_id, detail: srcFail.message }, nowIso);
    else if (result.events.length || series.some((s) => !ctx.failures.has(s.series_id))) kvSet(db, `events_watermark:${source.source_id}`, nowIso);
  });

  return {
    source_id: source.source_id,
    series: series.length,
    failed: [...ctx.failures.entries()].filter(([k]) => !k.startsWith("__")).map(([series_id, f]) => ({ series_id, ...f })),
    ...counts,
    touched: series.filter((s) => !ctx.failures.has(s.series_id)).map((s) => s.series_id),
    notes: ctx.notes,
  };
}

async function collectOnce(db, catalog, { now = new Date(), dataDir, env = process.env, force = false, sources = null, seriesIds = null, fetchImpl = null } = {}) {
  syncCatalog(db, catalog, now.toISOString());
  const due = dueSeries(db, catalog, { now, force, sources, seriesIds });
  const bySource = new Map();
  for (const s of due) {
    if (!bySource.has(s.source_id)) bySource.set(s.source_id, []);
    bySource.get(s.source_id).push(s);
  }
  // Sources are independent hosts, so they run in parallel; each adapter paces its own host.
  const runs = await Promise.all([...bySource.entries()].map(([sid, list]) => {
    const source = catalog.sources.find((x) => x.source_id === sid);
    return runSource(db, catalog, source, list, { now, dataDir, env, fetchImpl }).catch((e) => ({ source_id: sid, error: String(e.message || e) }));
  }));
  // Score once every source has landed, so cross-source checks and event flags see this pass's
  // data from all sources. Series sharing a cross_check group with anything touched are rescored too.
  const touched = new Set(runs.flatMap((r) => r.touched || []));
  const groups = new Set(catalog.series.filter((s) => touched.has(s.series_id) && s.cross_check).map((s) => s.cross_check));
  for (const s of catalog.series) if (s.cross_check && groups.has(s.cross_check)) touched.add(s.series_id);
  const scored = rescoreAll(db, catalog, { now, seriesIds: [...touched] });
  for (const r of runs) {
    r.scored = (r.touched || []).length;
    delete r.touched;
  }
  const summary = { started_at: now.toISOString(), finished_at: new Date().toISOString(), due: due.length, scored, sources: runs };
  kvSet(db, "last_collect", summary);
  return summary;
}

// Rescore every enabled series without fetching (after a methodology change, or on a hub).
function rescoreAll(db, catalog, { now = new Date(), seriesIds = null } = {}) {
  const bySource = new Map(catalog.sources.map((s) => [s.source_id, s]));
  const only = seriesIds ? new Set(seriesIds) : null;
  let n = 0;
  tx(db, () => {
    for (const s of catalog.series) {
      if (only && !only.has(s.series_id)) continue;
      if (scoreSeries(db, s, bySource.get(s.source_id), { now })) n++;
    }
  });
  return n;
}

module.exports = { collectOnce, rescoreAll, dueSeries, ADAPTERS };
