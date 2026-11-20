// Per-route call counts, aggregated by hour (packs 0.10.0, owner 2026-11-19).
//
// Why: the chain shows how many relays each service settles, but not which route or brief a
// caller asked for. These counts answer that, and nothing else.
//
// What is kept: per UTC hour, "METHOD /path" (plus the brief vertical or signal series id, both
// already validated against this pack's own lists) and the status class (2xx / 4xx), with a
// count and the total handling time. Nothing about the caller is kept: no address, header,
// body, query text or application id. Unknown paths are counted as one "unmatched" key, so
// a caller cannot write arbitrary text into the log.
//
// Where it goes: one JSON line per finished hour on stdout ({"usage": {...}}), read with
// `docker logs <pack>-backend | grep '"usage"'`. The current and last 48 hours are also kept in
// memory for tests. Health and version probes are counted under one "probe" key.
"use strict";

const MAX_KEYS_PER_HOUR = 200; // bounds memory; extra keys fold into "other"
const KEEP_HOURS = 48;

function hourOf(ms) {
  return new Date(ms).toISOString().slice(0, 13) + ":00Z";
}

function createUsage({ service, version, log = (line) => console.log(line), now = () => Date.now() } = {}) {
  const hours = new Map(); // hour -> Map(key -> {n2xx, n4xx, ms})
  let current = null;

  function emit(hour) {
    const m = hours.get(hour);
    if (!m || !m.size) return;
    const counts = {};
    let total = 0;
    for (const [k, v] of [...m.entries()].sort()) {
      counts[k] = { ok: v.ok, client_error: v.err, avg_ms: Math.round(v.ms / Math.max(1, v.ok + v.err)) };
      total += v.ok + v.err;
    }
    log(JSON.stringify({ usage: { service, version, hour, total, counts } }));
  }

  function roll(t) {
    const h = hourOf(t);
    if (current && current !== h) emit(current);
    if (current !== h) {
      current = h;
      if (!hours.has(h)) hours.set(h, new Map());
      while (hours.size > KEEP_HOURS) hours.delete(hours.keys().next().value);
    }
    return hours.get(h);
  }

  function record(key, status, ms) {
    const m = roll(now());
    let k = key;
    if (!m.has(k) && m.size >= MAX_KEYS_PER_HOUR) k = "other";
    const v = m.get(k) || { ok: 0, err: 0, ms: 0 };
    if (status < 400) v.ok += 1; else v.err += 1;
    v.ms += Math.max(0, ms || 0);
    m.set(k, v);
  }

  // Called once a minute: writes the finished hour even when no request arrives after it.
  function tick() { roll(now()); }

  // On shutdown (a redeploy) the unfinished hour is written so its counts are not lost.
  function flush() { if (current) emit(current); }

  function snapshot() {
    const out = {};
    for (const [h, m] of hours) out[h] = Object.fromEntries([...m.entries()].map(([k, v]) => [k, { ...v }]));
    return out;
  }

  return { record, tick, flush, snapshot };
}

// The key for one request: a known route (with its validated tag), "probe", or "unmatched".
function keyFor(method, path, { routes, probePaths, tag }) {
  if ((method === "GET" || method === "HEAD") && probePaths.includes(path)) return "probe";
  const route = `${method} ${path}`;
  if (!routes.has(route)) return "unmatched";
  return tag ? `${route} ${tag}` : route;
}

module.exports = { createUsage, keyFor, hourOf, MAX_KEYS_PER_HOUR };
