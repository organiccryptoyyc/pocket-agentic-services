// POST /v1/evidence-packet (Build 3, 2026-11-14): every dated, cited regulatory event for one entity in a
// date window, as one packet an agent can quote from. Pure functions; the server passes in what the hub
// answered (/v1/events and /v1/sources), so this file has no network code.
//
// The bundle's `evidence_packet` block says which entities the pack answers for and which hub sources apply
// to each (a rule names `entities` or an entity `industry`; with neither it applies to every entity). Only
// events from an applicable source are included, and every applicable source gets a coverage line:
//   checked_ok  the source is fresh and has items in the window
//   empty       the source is fresh and has nothing in the window (checked, nothing found)
//   stale       the source's last successful fetch is older than its freshness limit
//   failed      the hub has no successful fetch for the source
// An empty source is reported, never dropped. Titles and the source's own field values only: no copied text.
"use strict";

const crypto = require("crypto");
const { ClientError } = require("./http");

const DAY = 86400000;
const MAX_WINDOW_DAYS = 366;
const MAX_LOOKBACK_DAYS = 1095; // high-severity events are kept 3 years; others 400 days (hub retention.json)
const STANDARD_RETENTION_DAYS = 400;
const HUB_LIMIT = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KIND = /^[a-z0-9_]{1,40}$/;

const sha256 = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseInput(body, cfg, { now = Date.now() } = {}) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const entity = typeof b.entity_id === "string" ? b.entity_id.toLowerCase() : null;
  if (!entity || !cfg.entities.includes(entity)) throw new ClientError(400, "unknown_entity", `field 'entity_id' must be one of: ${cfg.entities.join(", ")}`);

  const day = (k) => {
    if (b[k] === undefined || b[k] === null) return null;
    if (typeof b[k] !== "string" || !DATE.test(b[k]) || !Number.isFinite(Date.parse(`${b[k]}T00:00:00Z`))) throw new ClientError(400, "invalid_input", `field '${k}' must be a date, YYYY-MM-DD`);
    return Date.parse(`${b[k]}T00:00:00Z`);
  };
  const today = Date.parse(`${isoDate(now)}T00:00:00Z`);
  const to = day("to") ?? today;
  const from = day("from") ?? to - (MAX_WINDOW_DAYS - 1) * DAY;
  if (to > today) throw new ClientError(400, "invalid_input", "field 'to' cannot be in the future");
  if (from > to) throw new ClientError(400, "invalid_input", "field 'from' must be on or before 'to'");
  const days = Math.round((to - from) / DAY) + 1;
  if (days > MAX_WINDOW_DAYS) throw new ClientError(400, "invalid_input", `the window is at most ${MAX_WINDOW_DAYS} days (asked ${days}); split it into several calls`);
  if (today - from > MAX_LOOKBACK_DAYS * DAY) throw new ClientError(400, "out_of_range", `'from' can be at most ${MAX_LOOKBACK_DAYS} days back; the hub keeps events 400 days, high-severity ones 3 years`);

  let kinds = null;
  if (b.kinds !== undefined && b.kinds !== null) {
    if (!Array.isArray(b.kinds) || b.kinds.length < 1 || b.kinds.length > 10 || !b.kinds.every((k) => typeof k === "string" && KIND.test(k))) {
      throw new ClientError(400, "invalid_input", "field 'kinds' must be a list of 1-10 event kinds, e.g. [\"drug_recall\",\"warning_letter\"]; see kinds_found in any packet");
    }
    kinds = [...new Set(b.kinds)];
  }
  let q = null;
  if (b.q !== undefined && b.q !== null) {
    if (typeof b.q !== "string" || !b.q.trim() || b.q.length > 80) throw new ClientError(400, "invalid_input", "field 'q' must be a word or phrase of at most 80 characters (matched in titles and fields)");
    q = b.q.trim().toLowerCase();
  }
  const max = b.max_items === undefined || b.max_items === null ? 50 : b.max_items;
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new ClientError(400, "invalid_input", "field 'max_items' must be an integer 1-50");
  let offset = 0;
  if (b.cursor !== undefined && b.cursor !== null) {
    if (typeof b.cursor !== "string" || !/^\d{1,4}$/.test(b.cursor)) throw new ClientError(400, "invalid_input", "field 'cursor' must be the next_cursor of the previous page");
    offset = Number(b.cursor);
  }
  return { entity, from: isoDate(from), to: isoDate(to), days, kinds, q, max, offset };
}

// The source rules that apply to an entity (entity: {entity_id, industry}).
function sourcesFor(cfg, entity) {
  return cfg.sources.filter((r) => (r.entities ? r.entities.includes(entity.entity_id) : r.industry ? r.industry === entity.industry : true)).map((r) => r.source_id);
}

// Collector alerts that mean a source could not be read (lib/collect.js); others describe the data.
const FETCH_FAILURES = new Set(["api_failure", "schema_change", "missing_key", "empty_response"]);
const PUSH_LIMIT_MS = 2 * DAY;

// health: Map source_id -> the hub's /v1/sources row ({name, tier, cadence_minutes, last_success_at}).
// collector: the hub's /v1/sources `collector` block, what the Pi pushed with its last run
// ({received_at, open_alerts: [{kind, source_id, last_seen}]}). On the hub, fetches happen on the Pi, so
// the hub's own last_success_at is empty; then freshness is the Pi's last push and its open alerts.
function coverageLine(sourceId, items, health, now, collector = null) {
  const h = health.get(sourceId);
  const base = { source_id: sourceId, source_name: (h && h.name) || sourceId, items_in_window: items, last_success_at: (h && h.last_success_at) || null };
  if ((!h || !h.last_success_at) && collector && collector.received_at) {
    const pushed = { ...base, collector_pushed_at: collector.received_at };
    const age = now - Date.parse(collector.received_at);
    if (!(age <= PUSH_LIMIT_MS)) return { ...pushed, status: "stale", note: `the collector last pushed to the hub ${Math.round(age / 3600000)} h ago` };
    const alert = (collector.open_alerts || []).find((a) => a.source_id === sourceId && FETCH_FAILURES.has(a.kind));
    if (alert) return { ...pushed, status: "stale", note: `open collector alert: ${alert.kind}${alert.last_seen ? ` (last seen ${alert.last_seen})` : ""}` };
    return { ...pushed, status: items ? "checked_ok" : "empty" };
  }
  if (!h || !h.last_success_at) return { ...base, status: "failed", note: "the hub has no successful fetch and no collector status for this source" };
  // Fresh means a success within three collection cycles, and never less than two days.
  const limitMs = Math.max(3 * (h.cadence_minutes || 1440) * 60000, 2 * DAY);
  const age = now - Date.parse(h.last_success_at);
  if (!(age <= limitMs)) return { ...base, status: "stale", note: `last successful fetch ${Math.round(age / 3600000)} h ago (limit ${Math.round(limitMs / 3600000)} h)` };
  return { ...base, status: items ? "checked_ok" : "empty" };
}

// hubEvents: events the hub returned for the entity since `from` (newest first, at most HUB_LIMIT per list).
// lists: the raw lists, to tell whether any list hit the hub limit before reaching `from`.
function buildPacket({ input, entity, cfg, lists, health, collector = null, now = Date.now() }) {
  const applicable = sourcesFor(cfg, entity);
  const all = lists.flatMap((l) => l);
  const seen = new Set();
  const inWindow = all.filter((e) => {
    const key = `${e.source_id}|${e.event_type}|${e.event_time}|${e.title}|${e.source_url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const d = String(e.event_time).slice(0, 10);
    return applicable.includes(e.source_id) && d >= input.from && d <= input.to;
  });
  const kindsFound = {};
  for (const e of inWindow) kindsFound[e.event_type] = (kindsFound[e.event_type] || 0) + 1;
  const matched = inWindow
    .filter((e) => !input.kinds || input.kinds.includes(e.event_type))
    .filter((e) => !input.q || `${e.title} ${JSON.stringify(e.detail || {})}`.toLowerCase().includes(input.q))
    .sort((a, b) => String(b.event_time).localeCompare(String(a.event_time)) || String(a.title).localeCompare(String(b.title)));

  const items = matched.map((e) => {
    const item = {
      date: String(e.event_time).slice(0, 10),
      kind: e.event_type,
      source_id: e.source_id,
      source_name: (health.get(e.source_id) || {}).name || e.source_id,
      title: e.title,
      severity: e.severity,
      url: e.source_url,
      fields: e.detail || {},
      fetched_at: e.fetch_time || null,
    };
    return { ...item, evidence_hash: sha256(item) };
  });

  // A list that hit the hub limit and still ends after `from` may have cut off older events.
  const truncated = lists.some((l) => l.length >= HUB_LIMIT && String(l[l.length - 1].event_time).slice(0, 10) > input.from);
  const coverage = applicable.map((s) => coverageLine(s, inWindow.filter((e) => e.source_id === s).length, health, now, collector));
  const page = items.slice(input.offset, input.offset + input.max);
  const next = input.offset + input.max < items.length ? String(input.offset + input.max) : null;
  const notes = [];
  if (truncated) notes.push(`the hub returns at most ${HUB_LIMIT} events per list and this window holds more; older events may be missing. Narrow the window or pass 'kinds'.`);
  if (Date.parse(`${isoDate(now)}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`) > STANDARD_RETENTION_DAYS * DAY) notes.push("before 400 days ago only high-severity events are kept, so the early part of this window lists high-severity events only.");
  const problems = coverage.filter((c) => c.status === "stale" || c.status === "failed");
  if (problems.length) notes.push(`not current: ${problems.map((c) => `${c.source_id} (${c.status})`).join(", ")}; items from these sources may be missing.`);

  const subject = { entity_id: entity.entity_id, name: entity.name || null, ticker: entity.ticker || null, industry: entity.industry || null };
  const window = { from: input.from, to: input.to, days: input.days };
  return {
    subject,
    window,
    filters: { kinds: input.kinds, q: input.q },
    complete: !truncated && !problems.length,
    items_total: items.length,
    items_returned: page.length,
    next_cursor: next,
    kinds_found: kindsFound,
    items: page,
    coverage,
    packet_hash: sha256({ subject, window, filters: { kinds: input.kinds, q: input.q }, items: items.map((i) => i.evidence_hash) }),
    notes,
    note: "Dated regulatory events with citations, newest first; titles and the source's own field values only. Each item's evidence_hash is the SHA-256 of the item; packet_hash covers every matching item across pages.",
  };
}

module.exports = { parseInput, sourcesFor, coverageLine, buildPacket, HUB_LIMIT, MAX_WINDOW_DAYS };
