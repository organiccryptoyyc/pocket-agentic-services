// Certificate Transparency, read directly from tiled logs (static-ct-api,
// c2sp.org/static-ct-api). Public by design; no vendor terms (phase 0, 2026-11-02).
//
// Logs are sharded by certificate *expiry*, so the shards that receive new
// certificates are the ones whose interval covers roughly now + 90 days. We
// pick them from Chrome's log list at run time, so shard roll-overs need no
// config change.
"use strict";

const zlib = require("zlib");

const LOG_LIST_URL = "https://www.gstatic.com/ct/log_list/v3/log_list.json";
const UA = "brand-protection-ct/0.1 (+https://github.com/organiccryptoyyc/pocket-agentic-services)";
const ENTRIES_PER_TILE = 256;

async function get(url, timeoutMs = 30_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// operators: e.g. ["Let's Encrypt", "Google"]; aheadDays: expiry to target.
function selectLogs(logList, operators, aheadDays = 90, now = Date.now()) {
  const target = new Date(now + aheadDays * 86_400_000).toISOString();
  const out = [];
  for (const op of logList.operators || []) {
    if (!operators.includes(op.name)) continue;
    for (const l of op.tiled_logs || []) {
      const ti = l.temporal_interval || {};
      const usable = l.state && l.state.usable;
      if (usable && (ti.start_inclusive || "") <= target && target < (ti.end_exclusive || "9")) {
        out.push({ operator: op.name, name: l.description, monitoring_url: l.monitoring_url.endsWith("/") ? l.monitoring_url : `${l.monitoring_url}/` });
      }
    }
  }
  return out;
}

// N -> "x001/x234/067" (c2sp.org/tlog-tiles path encoding).
function tilePath(n) {
  let s = String(n);
  s = "0".repeat((3 - (s.length % 3)) % 3) + s;
  const parts = s.match(/.{3}/g);
  return parts.map((p, i) => (i < parts.length - 1 ? `x${p}` : p)).join("/");
}

function parseCheckpoint(buf) {
  const lines = buf.toString("utf8").split("\n");
  const size = Number(lines[1]);
  if (!Number.isSafeInteger(size)) throw new Error("checkpoint has no tree size");
  return { origin: lines[0], size };
}

// TileLeaf: timestamp u64, entry_type u16, then either
//   x509:    cert<3-byte len>, extensions<2>, chain<2>
//   precert: issuer_key_hash[32], tbs<3>, extensions<2>, pre_certificate<3>, chain<2>
function parseDataTile(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    const timestamp = Number(buf.readBigUInt64BE(o)); o += 8;
    const type = buf.readUInt16BE(o); o += 2;
    if (type === 1) o += 32;
    else if (type !== 0) throw new Error(`unknown entry_type ${type} at offset ${o - 2}`);
    const certLen = buf.readUIntBE(o, 3); o += 3;
    const cert = buf.subarray(o, o + certLen); o += certLen;
    o += 2 + buf.readUInt16BE(o);
    if (type === 1) o += 3 + buf.readUIntBE(o, 3);
    o += 2 + buf.readUInt16BE(o);
    if (o > buf.length) throw new Error("truncated tile");
    out.push({ timestamp, type, cert });
  }
  return out;
}

const NAME_RE = /(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})/g;

// Cheap keyword pre-filter on raw bytes, then pull DNS names out of the
// matching certificate. SAN and CN values are plain ASCII inside the DER.
function matchEntry(cert, keywordBufs, keywords) {
  let hit = false;
  for (const k of keywordBufs) if (cert.indexOf(k) !== -1) { hit = true; break; }
  if (!hit) return [];
  const text = cert.toString("latin1").toLowerCase();
  const names = new Set();
  for (const m of text.matchAll(NAME_RE)) {
    // Names inside URLs are the CA's own CRL/OCSP/issuer links, not the subject.
    if (text.slice(Math.max(0, m.index - 3), m.index) === "://") continue;
    const name = m[0].replace(/^\*\./, "");
    if (keywords.some((k) => name.includes(k))) names.add(name);
  }
  return [...names];
}

module.exports = { LOG_LIST_URL, ENTRIES_PER_TILE, get, selectLogs, tilePath, parseCheckpoint, parseDataTile, matchEntry };
