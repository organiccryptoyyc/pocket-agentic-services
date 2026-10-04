// PMIC service pack: one paid Pocket service that bundles several related verticals and answers
// from the PMIC hub. The bundle file (bundles/<service_id>.json, picked with PACK_FILE) says which
// verticals it sells and which slice of the hub it may read. The pack never fetches public data
// itself; it asks the hub (http://pmic-hub-backend:8080 on the pocket-supplier network), caches
// answers for cache_seconds, and serves the last good answer if the hub is briefly away.
//
//   POST /v1/verticals {}                                   what this service sells
//   POST /v1/brief     {vertical, entity_id?, horizon?, countries?}   one scored brief
//   POST /v1/overview  {entity_id?, horizon?}               every brief at once, compact
//   POST /v1/signals   {source_id?, category?, entity_id?, horizon?, sort?, direction?, min_confidence?, limit?}
//   POST /v1/signal    {series_id}        POST /v1/explain {series_id, horizon?}
//   POST /v1/catalog   {entity_id?, q?, ...}
//   POST /v1/events    {entity_id?, event_type?, severity?, since?, limit?}   (company and pharma bundles)
//   POST /v1/inflation/adjust {amount, from: "YYYY-MM", to?: "YYYY-MM"}     (macro bundle)
//   GET  /v1/version, /v1/health, /healthz
//   GET  /v1/selftest                                       every vertical end to end; 200 only if all pass
"use strict";

const path = require("path");
const { createServer, ClientError } = require("./lib/http");
const { fetchJSON, cached } = require("./lib/net");
const V = require("./lib/verticals");

const PACK = require(path.resolve(__dirname, process.env.PACK_FILE || "bundle.json"));
const HUB = (process.env.PMIC_HUB_URL || "http://pmic-hub-backend:8080").replace(/\/$/, "");
const TOKEN = process.env.PMIC_API_TOKEN || "";
const PORT = Number(process.env.PORT || 8080);
const TTL = (PACK.cache_seconds || 300) * 1000;
const HORIZONS = ["7d", "30d", "90d", "365d"];
const DAY = 86400000;
const VERTICALS = new Map(PACK.verticals.map((v) => [v.id, v]));
const PASS = ["horizon", "sort", "direction", "min_confidence", "limit", "entity_id", "industry", "geography", "q", "category", "metric_name", "event_type", "severity", "since"];

// ---- hub access ---------------------------------------------------------------------------

async function hubRaw(route, body) {
  const key = `${route} ${JSON.stringify(body)}`;
  const r = await cached(key, TTL, async () => {
    const res = await fetchJSON(`${HUB}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) });
    // Hub 4xx are input problems: pass them through as 400 with the hub's reason.
    if (!res.ok) throw new ClientError(400, (res.body.error && res.body.error.code) || "invalid_input", (res.body.error && res.body.error.message) || `hub answered ${res.status}`);
    return res.body;
  });
  return r;
}

async function hub(route, body) {
  return (await hubRaw(route, body)).value;
}

// A series the bundle names but the hub does not have (a metric a company doesn't report).
async function hubOptional(route, body) {
  try {
    return await hub(route, body);
  } catch (e) {
    if (e instanceof ClientError && e.code === "unknown_series") return null;
    throw e;
  }
}

function wrap(obj, stale = false) {
  const { service, ...rest } = obj;
  return { service: PACK.service_id, pack_version: PACK.version, ...rest, ...(stale ? { cache: { stale: true } } : {}) };
}

// ---- input checks -------------------------------------------------------------------------

function obj(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ClientError(400, "invalid_input", "request body must be a JSON object");
  return body;
}

function horizonOf(body, fallback = PACK.default_horizon) {
  const h = body.horizon === undefined ? fallback : body.horizon;
  if (!HORIZONS.includes(h)) throw new ClientError(400, "invalid_input", "field 'horizon' must be one of 7d, 30d, 90d, 365d");
  return h;
}

function verticalOf(body) {
  const id = body.vertical;
  if (typeof id !== "string" || !VERTICALS.has(id)) throw new ClientError(400, "unknown_vertical", `field 'vertical' must be one of: ${[...VERTICALS.keys()].join(", ")}`);
  return VERTICALS.get(id);
}

function entityOf(body, required) {
  const e = body.entity_id;
  if (e === undefined || e === null || e === "") {
    if (required) throw new ClientError(400, "invalid_input", `field 'entity_id' is required: one of ${(PACK.entities || []).join(", ")}`);
    return null;
  }
  const id = typeof e === "string" ? e.toLowerCase() : null;
  if (!id || !(PACK.entities || []).includes(id)) throw new ClientError(400, "unknown_entity", `field 'entity_id' must be one of: ${(PACK.entities || []).join(", ")}`);
  return id;
}

const needsEntity = (v) => v.kind === "entity_composite" || v.kind === "entity_events" || v.kind === "peer_table";
const sinceFor = (horizon) => new Date(Date.now() - Number(horizon.replace("d", "")) * DAY).toISOString().slice(0, 10);

let entityCache = { at: 0, map: null };
async function entityInfo(id) {
  if (!entityCache.map || Date.now() - entityCache.at > TTL) {
    const r = await hub("/v1/entities", {});
    entityCache = { at: Date.now(), map: new Map(r.entities.map((e) => [e.entity_id, e])) };
  }
  const e = entityCache.map.get(id);
  return e ? { entity_id: e.entity_id, name: e.name, ticker: e.ticker, industry: e.industry } : { entity_id: id };
}

// ---- briefs -------------------------------------------------------------------------------

async function member(cfg, horizon) {
  const ex = await hubOptional("/v1/explain", { series_id: cfg.series_id, horizon });
  if (!ex) return null;
  if (ex.status === "ok") return V.scoreMember(cfg, ex.current, ex.previous);
  const sig = await hubOptional("/v1/signal", { series_id: cfg.series_id });
  return sig ? V.scoreMember(cfg, sig, null) : null;
}

function curve(members) {
  const val = (id) => {
    const m = members.find((x) => x.series_id === id);
    return m && m.value ? m.value.current : null;
  };
  const slope = val("fred:T10Y2Y");
  const dff = val("fred:DFF");
  const y10 = val("fred:DGS10");
  return {
    policy_rate_pct: dff,
    treasury_2y_pct: val("fred:DGS2"),
    treasury_10y_pct: y10,
    slope_10y_minus_2y_pct: slope,
    inverted: slope === null ? null : slope < 0,
    policy_minus_10y_pct: dff !== null && y10 !== null ? Math.round((dff - y10) * 100) / 100 : null,
  };
}

// Treasury yields by tenor, with both slopes markets watch for inversion.
const TENORS = [["1m", "fred:DGS1MO"], ["3m", "fred:DGS3MO"], ["1y", "fred:DGS1"], ["2y", "fred:DGS2"], ["5y", "fred:DGS5"], ["10y", "fred:DGS10"], ["30y", "fred:DGS30"]];
function termStructure(members) {
  const val = (id) => {
    const m = members.find((x) => x.series_id === id);
    return m && m.value ? m.value.current : null;
  };
  const s3m = val("fred:T10Y3M");
  const s2y = val("fred:T10Y2Y");
  return {
    yields_pct: Object.fromEntries(TENORS.map(([t, id]) => [t, val(id)])),
    slope_10y_minus_3m_pct: s3m,
    slope_10y_minus_2y_pct: s2y,
    inverted_10y_3m: s3m === null ? null : s3m < 0,
    inverted_10y_2y: s2y === null ? null : s2y < 0,
  };
}

async function brief(v, { horizon, entity, countries }) {
  if (v.kind === "composite") {
    const members = (await Promise.all(v.members.map((m) => member(m, horizon)))).filter(Boolean);
    const out = V.combine(v, members, { horizon });
    if ((v.extras || []).includes("curve")) out.curve = curve(members);
    if ((v.extras || []).includes("term_structure")) out.term_structure = termStructure(members);
    if (v.events_entities) {
      // Sector briefs (recalls, bank failures) list the latest events of their sector entities.
      const lists = await Promise.all(v.events_entities.map((id) => hub("/v1/events", { entity_id: id, since: sinceFor(horizon), limit: 20 })));
      out.recent_events = lists.flatMap((l) => l.events).sort((a, b) => String(b.event_time).localeCompare(String(a.event_time))).slice(0, 20);
    }
    return out;
  }
  if (v.kind === "entity_composite") {
    const ticker = entity.toUpperCase();
    const cfgs = v.metrics.map((m) => ({ ...m, series_id: v.series_pattern.replace("{TICKER}", ticker).replace("{metric}", m.metric) }));
    const members = (await Promise.all(cfgs.map((m) => member(m, horizon)))).filter(Boolean);
    const out = V.combine(v, members, { horizon, entity: await entityInfo(entity) });
    if (v.include_events) {
      // event_types narrows the list (insider-activity shows Form 4 and 13D only).
      const events = (await hub("/v1/events", { entity_id: entity, since: sinceFor(horizon), limit: v.event_types ? 500 : 20 })).events;
      out.recent_events = (v.event_types ? events.filter((e) => v.event_types.includes(e.event_type)) : events).slice(0, 20);
    }
    return out;
  }
  if (v.kind === "peer_table") {
    const byMetric = new Map();
    for (const m of v.metrics) {
      const r = await hub("/v1/signals", { source_id: v.source_id, metric_name: m.metric, limit: 200, horizon });
      byMetric.set(m.metric, r.signals);
    }
    return V.peerTable(v, byMetric, { horizon, entity: await entityInfo(entity), peers: PACK.entities });
  }
  if (v.kind === "entity_events") {
    const events = (await hub("/v1/events", { entity_id: entity, since: sinceFor(horizon), limit: 500 })).events;
    const w = await member({ series_id: `sec:${entity.toUpperCase()}:${v.watch_metric}`, direction: 0 }, horizon);
    return V.filingRisk(v, events, { horizon, entity: await entityInfo(entity), watch: w ? [w] : [] });
  }
  if (v.kind === "country_table") {
    const byMetric = new Map();
    for (const metric of v.metrics) {
      const r = await hub("/v1/signals", { source_id: v.source_id, metric_name: metric, sort: "confidence", limit: 50, horizon });
      byMetric.set(metric, r.signals);
    }
    return V.countryTable(v, byMetric, { horizon, countries });
  }
  throw new ClientError(400, "invalid_input", `vertical '${v.id}' has an unknown kind`);
}

function countriesOf(body) {
  if (body.countries === undefined) return null;
  if (!Array.isArray(body.countries) || !body.countries.every((c) => typeof c === "string" && c.length <= 8)) throw new ClientError(400, "invalid_input", "field 'countries' must be a list of country ids, e.g. [\"us\",\"de\"]");
  return body.countries.map((c) => c.toLowerCase());
}

// ---- scope for the raw routes ------------------------------------------------------------

function scopeFilters(body) {
  // A scope entry pinned to one entity only answers for that entity.
  const fs = PACK.hub_scope.filter((f) => (!body.source_id || f.source_id === body.source_id) && (!body.entity_id || !f.entity_id || f.entity_id === body.entity_id));
  if (!fs.length) throw new ClientError(400, "out_of_scope", `nothing in scope for that source_id/entity_id; 'source_id' must be one of: ${[...new Set(PACK.hub_scope.map((f) => f.source_id))].join(", ")}`);
  return fs;
}

const pick = (body) => Object.fromEntries(PASS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

let scopeIds = { at: 0, ids: null };
async function inScope(seriesId) {
  if (typeof seriesId !== "string" || !seriesId) throw new ClientError(400, "invalid_input", "field 'series_id' is required; list ids with POST /v1/catalog");
  if (!scopeIds.ids || Date.now() - scopeIds.at > TTL) {
    const ids = new Set();
    for (const f of PACK.hub_scope) for (const s of (await hub("/v1/catalog", { ...f, limit: 2000 })).series) ids.add(s.series_id);
    scopeIds = { at: Date.now(), ids };
  }
  if (!scopeIds.ids.has(seriesId)) throw new ClientError(400, "unknown_series", `'${seriesId}' is not covered by ${PACK.service_id}; list ids with POST /v1/catalog`);
}

const SORTS = {
  composite: (s) => s.composite_score,
  change: (s, h) => (s.changes_pct ? s.changes_pct[h] : null),
  abs_change: (s, h) => (s.changes_pct && s.changes_pct[h] !== null ? Math.abs(s.changes_pct[h]) : null),
  confidence: (s) => (s.confidence ? s.confidence.score : null),
  deviation: (s) => (s.zscore === null || s.zscore === undefined ? null : Math.abs(s.zscore)),
};

async function signals(body) {
  const h = horizonOf(body, PACK.default_horizon);
  const sort = body.sort || "composite";
  if (!SORTS[sort]) throw new ClientError(400, "invalid_input", "field 'sort' must be composite, change, abs_change, confidence or deviation");
  const dir = body.direction === "asc" ? 1 : -1;
  const limit = body.limit === undefined ? 20 : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ClientError(400, "invalid_input", "field 'limit' must be an integer 1-200");
  const all = [];
  for (const f of scopeFilters(body)) all.push(...(await hub("/v1/signals", { ...pick(body), horizon: h, limit, ...f })).signals);
  const key = SORTS[sort];
  all.sort((a, b) => {
    const x = key(a, h);
    const y = key(b, h);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir * (x - y) || a.series_id.localeCompare(b.series_id);
  });
  return { horizon: h, sort, direction: dir === 1 ? "asc" : "desc", count: Math.min(limit, all.length), signals: all.slice(0, limit) };
}

async function catalog(body) {
  const series = [];
  for (const f of scopeFilters(body)) series.push(...(await hub("/v1/catalog", { ...pick(body), limit: 2000, ...f })).series);
  return { count: series.length, series };
}

// ---- extras -------------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function inflationAdjust(body) {
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e15) throw new ClientError(400, "invalid_input", "field 'amount' must be a positive number");
  if (typeof body.from !== "string" || !MONTH.test(body.from)) throw new ClientError(400, "invalid_input", "field 'from' must be a month, YYYY-MM");
  if (body.to !== undefined && (typeof body.to !== "string" || !MONTH.test(body.to))) throw new ClientError(400, "invalid_input", "field 'to' must be a month, YYYY-MM");
  const s = await hub("/v1/series", { series_id: "fred:CPIAUCSL", limit: 5000 });
  const obs = s.observations.filter((o) => o.value !== null);
  if (!obs.length) throw new ClientError(400, "no_data", "CPI has not been collected yet");
  const month = (o) => o.observation_time.slice(0, 7);
  const first = month(obs[0]);
  const last = month(obs[obs.length - 1]);
  const at = (m) => obs.find((o) => month(o) === m);
  const from = at(body.from);
  const to = body.to ? at(body.to) : obs[obs.length - 1];
  if (!from || !to) throw new ClientError(400, "out_of_range", `CPI months available: ${first} to ${last}`);
  const factor = to.value / from.value;
  return {
    amount,
    from: month(from),
    to: month(to),
    adjusted: Math.round(amount * factor * 100) / 100,
    change_pct: Math.round((factor - 1) * 10000) / 100,
    cpi: { series_id: "fred:CPIAUCSL", from: from.value, to: to.value, label: s.label },
    summary: `${amount} in ${month(from)} has the same buying power as ${Math.round(amount * factor * 100) / 100} in ${month(to)} (CPI ${factor >= 1 ? "+" : ""}${Math.round((factor - 1) * 10000) / 100}%).`,
    citation_url: "https://fred.stlouisfed.org/series/CPIAUCSL",
    available_range: { from: first, to: last },
  };
}

// ---- routes -------------------------------------------------------------------------------

function verticalList() {
  return {
    count: PACK.verticals.length,
    verticals: PACK.verticals.map((v) => ({
      id: v.id,
      title: v.title,
      question: v.question,
      kind: v.kind,
      needs_entity_id: needsEntity(v),
      ...(needsEntity(v) ? { entities: PACK.entities } : {}),
      labels: v.labels || null,
      note: v.note || null,
      inputs: v.members ? v.members.map((m) => m.series_id) : v.metrics ? v.metrics.map((m) => (typeof m === "string" ? m : m.metric)) : null,
    })),
    ...(PACK.extra_routes || []).includes("inflation_adjust") ? { extra_routes: ["POST /v1/inflation/adjust {amount, from: \"YYYY-MM\", to?}"] } : {},
  };
}

async function overview(body) {
  const horizon = horizonOf(body);
  const entity = entityOf(body, false);
  const vs = PACK.verticals.filter((v) => (entity ? needsEntity(v) : !needsEntity(v)));
  if (!vs.length) throw new ClientError(400, "invalid_input", `send 'entity_id', one of: ${(PACK.entities || []).join(", ")}`);
  const briefs = await Promise.all(vs.map((v) => brief(v, { horizon, entity })));
  return {
    horizon,
    ...(entity ? { entity: briefs[0].entity } : {}),
    count: briefs.length,
    briefs: briefs.map((b) => ({ vertical: b.vertical, title: b.title, status: b.status, score: b.score ?? null, label: b.label ?? null, trend: b.trend ?? null, change: b.change ?? null, summary: b.summary, risk_flags: b.risk_flags || [], confidence: b.confidence || null, ...(b.country_scores ? { country_scores: b.country_scores } : {}) })),
  };
}

const routes = new Map([
  ["POST /v1/verticals", async () => wrap(verticalList())],
  ["POST /v1/brief", async (raw) => {
    const b = obj(raw);
    const v = verticalOf(b);
    return wrap(await brief(v, { horizon: horizonOf(b), entity: entityOf(b, needsEntity(v)), countries: countriesOf(b) }));
  }],
  ["POST /v1/overview", async (raw) => wrap(await overview(obj(raw)))],
  ["POST /v1/signals", async (raw) => wrap(await signals(obj(raw)))],
  ["POST /v1/signal", async (raw) => { const b = obj(raw); await inScope(b.series_id); return wrap(await hub("/v1/signal", { series_id: b.series_id })); }],
  ["POST /v1/explain", async (raw) => { const b = obj(raw); await inScope(b.series_id); return wrap(await hub("/v1/explain", { series_id: b.series_id, horizon: horizonOf(b) })); }],
  ["POST /v1/catalog", async (raw) => wrap(await catalog(obj(raw)))],
]);
if (PACK.events_scope) {
  // Bundles without an industry scope (company) only answer for one of their own entities.
  routes.set("POST /v1/events", async (raw) => {
    const b = obj(raw);
    const entity = entityOf(b, !PACK.events_scope.industry);
    return wrap(await hub("/v1/events", { ...pick(b), ...PACK.events_scope, ...(entity ? { entity_id: entity } : {}) }));
  });
}
if ((PACK.extra_routes || []).includes("inflation_adjust")) routes.set("POST /v1/inflation/adjust", async (raw) => wrap(await inflationAdjust(obj(raw))));

// Every vertical end to end through the hub. 200 only if each one answers status ok with a score,
// so a deploy probed at /v1/selftest proves the service on the server without a shell there.
async function selftest() {
  const entity = (PACK.entities || []).includes("pfe") ? "pfe" : (PACK.entities || [])[0];
  const results = await Promise.all(PACK.verticals.map(async (v) => {
    try {
      const b = await brief(v, { horizon: PACK.default_horizon, entity: needsEntity(v) ? entity : null, countries: null });
      const score = typeof b.score === "number" ? b.score : (b.country_scores || []).find((c) => typeof c.score === "number")?.score ?? null;
      return { vertical: v.id, ...(needsEntity(v) ? { entity_id: entity } : {}), status: b.status, score, pass: b.status === "ok" && score !== null };
    } catch (e) {
      // Only the error code: hub messages can name internal hosts, and this route is public.
      return { vertical: v.id, status: "error", code: e instanceof ClientError ? e.code : "unavailable", pass: false };
    }
  }));
  const out = { service: PACK.service_id, pack_version: PACK.version, pass: results.every((r) => r.pass), results };
  if (!out.pass) throw new ClientError(400, "selftest_failed", results.filter((r) => !r.pass).map((r) => `${r.vertical}: ${r.code || r.status}`).join("; "));
  return out;
}
routes.set("GET /v1/selftest", selftest);

function health() {
  return { service: PACK.service_id, version: PACK.version, verticals: PACK.verticals.map((v) => v.id), hub: HUB.replace(/\/\/[^@]*@/, "//") };
}

if (require.main === module) {
  createServer({ service: PACK.service_id, version: PACK.version, versionPath: "/v1/version", healthPath: "/v1/health", routes, health })
    .listen(PORT, () => console.log(JSON.stringify({ service: PACK.service_id, version: PACK.version, port: PORT, hub: HUB, listening: true })));
}

module.exports = { routes, PACK };
