// Read side used by the query API (server.js) and, through it, by every service pack. Each
// function takes a read-only DatabaseSync and a validated request body and returns a JSON object.
// The response shape for a single signal is the marketplace answer in the spec: sourced summary,
// composite score, trend, risk flags, confidence, provenance links.
"use strict";

const { ClientError } = require("./http");

const HORIZONS = { "7d": "pct_change_7d", "30d": "pct_change_30d", "90d": "pct_change_90d", "365d": "pct_change_365d" };
const SEVERITIES = ["low", "medium", "high"];
const DAY = 86400000;

function str(body, k, { required = false, max = 128, re = null } = {}) {
  const v = body[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ClientError(400, "invalid_input", `field '${k}' is required`);
    return null;
  }
  if (typeof v !== "string" || v.length > max || (re && !re.test(v))) throw new ClientError(400, "invalid_input", `field '${k}' must be a string${re ? ` matching ${re}` : ""}`);
  return v;
}

function int(body, k, def, min, max) {
  const v = body[k];
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw new ClientError(400, "invalid_input", `field '${k}' must be an integer ${min}-${max}`);
  return v;
}

function date(body, k) {
  const v = str(body, k, { max: 32 });
  if (v === null) return null;
  if (!Number.isFinite(Date.parse(v))) throw new ClientError(400, "invalid_input", `field '${k}' must be a date (YYYY-MM-DD or RFC 3339)`);
  return v;
}

function horizon(body) {
  const h = str(body, "horizon", { max: 8 }) || "90d";
  if (!HORIZONS[h]) throw new ClientError(400, "invalid_input", "field 'horizon' must be one of 7d, 30d, 90d, 365d");
  return h;
}

function filters(body) {
  const where = ["s.enabled = 1"];
  const args = [];
  for (const [k, col] of [["category", "s.category"], ["industry", "s.industry"], ["geography", "s.geography"], ["entity_id", "s.entity_id"], ["source_id", "s.source_id"], ["metric_name", "s.metric_name"]]) {
    const v = str(body, k, { max: 64 });
    if (v !== null) {
      where.push(`${col} = ?`);
      args.push(k === "geography" ? v.toUpperCase() : v);
    }
  }
  const q = str(body, "q", { max: 64 });
  if (q !== null) {
    where.push("(s.label LIKE ? OR s.metric_name LIKE ? OR s.series_id LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return { where: where.join(" AND "), args };
}

function latestScore(db, seriesId) {
  return db.prepare("SELECT * FROM scores WHERE series_id = ? ORDER BY as_of DESC, computed_at DESC LIMIT 1").get(seriesId);
}

function seriesRow(db, seriesId) {
  const s = db.prepare(`SELECT s.*, src.name source_name, src.terms_url, src.homepage, src.tier FROM series s JOIN sources src USING (source_id)
    WHERE s.series_id = ? AND s.enabled = 1`).get(seriesId);
  if (!s) throw new ClientError(400, "unknown_series", `'${seriesId}' is not in the catalog; list series with POST /v1/catalog`);
  return s;
}

function answer(db, s, sc, { withEvents = true, now = Date.now() } = {}) {
  const entity = db.prepare("SELECT entity_id, entity_type, name, ticker, cik, geography, industry FROM assets_or_entities WHERE entity_id = ?").get(s.entity_id);
  const base = {
    series_id: s.series_id,
    entity,
    metric: { name: s.metric_name, label: s.label, unit: s.unit, category: s.category, industry: s.industry, geography: s.geography, frequency: s.frequency, polarity: s.polarity, transform: s.transform },
  };
  if (!sc) {
    return { ...base, status: "no_data", summary: "No observations have been collected for this series yet.", composite_score: null, trend: "unknown", risk_flags: ["no_data"], confidence: { score: 0, label: "low" }, provenance: { source: { id: s.source_id, name: s.source_name, terms_url: s.terms_url } } };
  }
  const prov = JSON.parse(sc.provenance_json);
  const out = {
    ...base,
    status: "ok",
    summary: sc.rationale,
    value: { current: sc.current_value, unit: sc.unit, as_of: sc.as_of, transformed: sc.transformed_value },
    changes_pct: { "7d": sc.pct_change_7d, "30d": sc.pct_change_30d, "90d": sc.pct_change_90d, "365d": sc.pct_change_365d },
    zscore: sc.zscore,
    percentile: sc.percentile,
    composite_score: sc.composite_score,
    trend: sc.trend,
    risk_flags: JSON.parse(sc.risk_flags),
    confidence: { score: sc.confidence_score, label: sc.confidence_label },
    freshness_score: sc.freshness_score,
    reliability_score: sc.reliability_score,
    computed_at: sc.computed_at,
    provenance: {
      citation_url: sc.citation_url,
      source: { id: s.source_id, name: s.source_name, homepage: s.homepage, terms_url: s.terms_url, tier: s.tier },
      fetch_time: prov.fetch_time,
      raw_sha256: prov.raw_sha256,
      observation_id: prov.observation_id,
      revision: prov.revision,
      cross_check: prov.cross_check,
      history_points: prov.history_points,
      window_start: prov.window_start,
      transform_version: sc.transform_version,
    },
  };
  if (withEvents) {
    const since = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    out.recent_events = db.prepare(`SELECT event_type, event_time, title, severity, source_url FROM events WHERE entity_id = ? AND event_time >= ?
      ORDER BY event_time DESC LIMIT 10`).all(s.entity_id, since);
  }
  return out;
}

function catalog(db, body) {
  const { where, args } = filters(body);
  const limit = int(body, "limit", 500, 1, 2000);
  const rows = db.prepare(`SELECT s.series_id, s.source_id, s.entity_id, s.metric_name, s.label, s.unit, s.frequency, s.category, s.industry, s.geography,
      s.polarity, s.transform, s.last_success_at, ls.as_of, ls.composite_score, ls.trend, ls.confidence_label
    FROM series s LEFT JOIN scores ls ON ls.rowid = (SELECT rowid FROM scores x WHERE x.series_id = s.series_id ORDER BY x.as_of DESC, x.computed_at DESC LIMIT 1)
    WHERE ${where} ORDER BY s.category, s.entity_id, s.series_id LIMIT ?`).all(...args, limit);
  return { count: rows.length, series: rows };
}

function signal(db, body) {
  const id = str(body, "series_id", { max: 128 });
  if (id) return answer(db, seriesRow(db, id), latestScore(db, id));
  const entity = str(body, "entity_id", { max: 64 });
  const metric = str(body, "metric_name", { max: 64 });
  if (!entity || !metric) throw new ClientError(400, "invalid_input", "send 'series_id', or both 'entity_id' and 'metric_name'");
  const ids = db.prepare("SELECT series_id FROM series WHERE entity_id = ? AND metric_name = ? AND enabled = 1 ORDER BY source_id").all(entity, metric);
  if (!ids.length) throw new ClientError(400, "unknown_series", `no series for entity '${entity}' and metric '${metric}'; list them with POST /v1/catalog`);
  const answers = ids.map((r) => answer(db, seriesRow(db, r.series_id), latestScore(db, r.series_id)));
  return answers.length === 1 ? answers[0] : { count: answers.length, note: "More than one source reports this metric; compare them before relying on one.", signals: answers };
}

function signals(db, body) {
  const { where, args } = filters(body);
  const h = horizon(body);
  const sort = str(body, "sort", { max: 16 }) || "composite";
  if (!["composite", "change", "abs_change", "confidence", "deviation"].includes(sort)) throw new ClientError(400, "invalid_input", "field 'sort' must be composite, change, abs_change, confidence or deviation");
  const dir = (str(body, "direction", { max: 4 }) || "desc").toLowerCase();
  if (!["asc", "desc"].includes(dir)) throw new ClientError(400, "invalid_input", "field 'direction' must be asc or desc");
  const minConf = int(body, "min_confidence", 0, 0, 100);
  const limit = int(body, "limit", 20, 1, 200);
  const col = HORIZONS[h];
  const order = { composite: "sc.composite_score", change: `sc.${col}`, abs_change: `ABS(sc.${col})`, confidence: "sc.confidence_score", deviation: "ABS(sc.zscore)" }[sort];
  const rows = db.prepare(`SELECT s.series_id, sc.as_of FROM series s JOIN scores sc ON sc.rowid = (SELECT rowid FROM scores x WHERE x.series_id = s.series_id ORDER BY x.as_of DESC, x.computed_at DESC LIMIT 1)
    WHERE ${where} AND sc.confidence_score >= ? AND ${order} IS NOT NULL ORDER BY ${order} ${dir.toUpperCase()}, s.series_id LIMIT ?`).all(...args, minConf, limit);
  return {
    horizon: h,
    sort,
    direction: dir,
    count: rows.length,
    signals: rows.map((r) => answer(db, seriesRow(db, r.series_id), latestScore(db, r.series_id), { withEvents: false })),
  };
}

function series(db, body) {
  const id = str(body, "series_id", { required: true, max: 128 });
  const s = seriesRow(db, id);
  const from = date(body, "from");
  const to = date(body, "to");
  const limit = int(body, "limit", 400, 1, 5000);
  const rows = db.prepare(`SELECT observation_time, period, metric_value value, fetch_time, source_url, qc_flags, revision, confidence_score FROM observations
    WHERE series_id = ? AND (? IS NULL OR observation_time >= ?) AND (? IS NULL OR observation_time <= ?) ORDER BY observation_time DESC LIMIT ?`)
    .all(id, from, from, to, to, limit)
    .map((r) => ({ ...r, qc_flags: JSON.parse(r.qc_flags) }));
  const out = { series_id: id, label: s.label, unit: s.unit, frequency: s.frequency, source_id: s.source_id, count: rows.length, observations: rows.reverse() };
  if (body.include_rollups === true) out.weekly_rollups = db.prepare("SELECT * FROM rollups_weekly WHERE series_id = ? ORDER BY week_start").all(id);
  return out;
}

// "Why" explanations from stored history: what moved between the score at the start of the
// horizon and the latest one, and what happened to the entity in between.
function explain(db, body) {
  const id = str(body, "series_id", { required: true, max: 128 });
  const s = seriesRow(db, id);
  const h = horizon(body);
  const days = Number(h.replace("d", ""));
  const now = latestScore(db, id);
  if (!now) return { series_id: id, horizon: h, status: "no_data", explanation: "No observations collected yet." };
  const cutoff = new Date(Date.parse(now.as_of) - days * DAY).toISOString().slice(0, 10);
  const then = db.prepare("SELECT * FROM scores WHERE series_id = ? AND as_of <= ? ORDER BY as_of DESC, computed_at DESC LIMIT 1").get(id, cutoff);
  const obs = db.prepare("SELECT observation_time, metric_value FROM observations WHERE series_id = ? AND observation_time > ? ORDER BY observation_time").all(id, cutoff);
  const steps = [];
  for (let i = 1; i < obs.length; i++) steps.push({ from: obs[i - 1].observation_time, to: obs[i].observation_time, change: obs[i].metric_value - obs[i - 1].metric_value });
  const biggest = [...steps].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 3);
  const events = db.prepare(`SELECT event_type, event_time, title, severity, source_url FROM events WHERE entity_id = ? AND event_time >= ?
    ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, event_time DESC LIMIT 10`).all(s.entity_id, cutoff);
  const reasons = [];
  if (then) {
    const dc = now.composite_score !== null && then.composite_score !== null ? now.composite_score - then.composite_score : null;
    if (dc !== null) reasons.push(`Composite moved ${dc >= 0 ? "+" : ""}${dc} (from ${then.composite_score} on ${then.as_of} to ${now.composite_score} on ${now.as_of}).`);
    if (now.percentile !== null && then.percentile !== null) reasons.push(`Percentile vs trailing history went from ${Math.round(then.percentile * 100)} to ${Math.round(now.percentile * 100)}.`);
    reasons.push(`Value went from ${then.current_value} to ${now.current_value} ${s.unit.replace(/_/g, " ")}.`);
  } else {
    reasons.push(`No stored score from ${h} ago (history starts later); explaining from observations only.`);
  }
  for (const b of biggest) reasons.push(`Largest step: ${b.change >= 0 ? "+" : ""}${Number(b.change.toPrecision(6))} between ${b.from} and ${b.to}.`);
  if (events.length) reasons.push(`${events.length} event(s) for ${s.entity_id} in the window, ${events.filter((e) => e.severity === "high").length} high severity.`);
  return {
    series_id: id,
    horizon: h,
    status: "ok",
    current: answer(db, s, now, { withEvents: false }),
    previous: then ? { as_of: then.as_of, current_value: then.current_value, composite_score: then.composite_score, percentile: then.percentile, trend: then.trend } : null,
    largest_steps: biggest,
    events,
    explanation: reasons.join(" "),
  };
}

function events(db, body) {
  const entity = str(body, "entity_id", { max: 64 });
  const type = str(body, "event_type", { max: 64 });
  const sev = str(body, "severity", { max: 8 });
  if (sev && !SEVERITIES.includes(sev)) throw new ClientError(400, "invalid_input", "field 'severity' must be low, medium or high");
  const since = date(body, "since");
  const limit = int(body, "limit", 50, 1, 500);
  const rows = db.prepare(`SELECT e.source_id, e.entity_id, e.event_type, e.event_time, e.title, e.severity, e.detail_json, e.source_url, e.fetch_time
    FROM events e JOIN assets_or_entities a USING (entity_id)
    WHERE (? IS NULL OR e.entity_id = ?) AND (? IS NULL OR e.event_type = ?) AND (? IS NULL OR e.severity = ?) AND (? IS NULL OR e.event_time >= ?)
      AND (? IS NULL OR a.industry = ?)
    ORDER BY e.event_time DESC, e.id DESC LIMIT ?`)
    .all(entity, entity, type, type, sev, sev, since, since, str(body, "industry", { max: 64 }), str(body, "industry", { max: 64 }), limit)
    .map(({ detail_json, ...r }) => ({ ...r, detail: JSON.parse(detail_json) }));
  return { count: rows.length, events: rows };
}

function entities(db, body) {
  const type = str(body, "entity_type", { max: 32 });
  const industry = str(body, "industry", { max: 64 });
  const geo = str(body, "geography", { max: 16 });
  const rows = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM series s WHERE s.entity_id = a.entity_id AND s.enabled = 1) series_count
    FROM assets_or_entities a WHERE (? IS NULL OR entity_type = ?) AND (? IS NULL OR industry = ?) AND (? IS NULL OR geography = ?) ORDER BY entity_type, entity_id`)
    .all(type, type, industry, industry, geo && geo.toUpperCase(), geo && geo.toUpperCase());
  return { count: rows.length, entities: rows };
}

function sources(db, { collectorStatus = null } = {}) {
  const rows = db.prepare("SELECT * FROM sources ORDER BY source_id").all().map((src) => {
    const last = db.prepare("SELECT started_at, ok, http_status, error FROM fetch_logs WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(src.source_id) || null;
    const recent = db.prepare("SELECT ok FROM fetch_logs WHERE source_id = ? ORDER BY id DESC LIMIT 20").all(src.source_id);
    const lastOk = db.prepare("SELECT MAX(started_at) t FROM fetch_logs WHERE source_id = ? AND ok = 1").get(src.source_id).t;
    const alerts = db.prepare("SELECT kind, COUNT(*) n FROM alerts WHERE source_id = ? AND resolved_at IS NULL GROUP BY kind").all(src.source_id);
    const n = db.prepare("SELECT COUNT(*) n, MAX(observation_time) latest FROM observations WHERE source_id = ?").get(src.source_id);
    return {
      ...src,
      observations: n.n,
      latest_observation: n.latest,
      last_fetch: last,
      last_success_at: lastOk,
      success_rate_last_20: recent.length ? recent.filter((r) => r.ok).length / recent.length : null,
      open_alerts: Object.fromEntries(alerts.map((a) => [a.kind, a.n])),
    };
  });
  return { count: rows.length, sources: rows, collector: collectorStatus };
}

function alerts(db, body) {
  const openOnly = body.open_only !== false;
  const src = str(body, "source_id", { max: 32 });
  const limit = int(body, "limit", 100, 1, 1000);
  const rows = db.prepare(`SELECT * FROM alerts WHERE (? = 0 OR resolved_at IS NULL) AND (? IS NULL OR source_id = ?) ORDER BY last_seen DESC LIMIT ?`)
    .all(openOnly ? 1 : 0, src, src, limit);
  return { count: rows.length, alerts: rows };
}

module.exports = { catalog, signal, signals, series, explain, events, entities, sources, alerts, answer, HORIZONS };
