// File-backed state shared by the API server and the ingest listener.
// Layout under BP_DATA_DIR (default ./var):
//   watch.json              brands under watch (seeded by the Pi, grown by paid scans)
//   brands/<brand_id>.json  latest scan result for a brand, findings merged with history
//   evidence/<id>.json      one evidence record per finding (hashes and derived fields only)
// Every write is temp-file + rename so a reader never sees a partial file.
"use strict";

const fs = require("fs");
const path = require("path");
const { isValidDomain } = require("./checks");

const DATA_DIR = path.resolve(process.env.BP_DATA_DIR || path.join(__dirname, "..", "var"));
const MAX_WATCHED = Number(process.env.BP_MAX_WATCHED || 200);
const GONE_KEEP_DAYS = 30;
const EVIDENCE_ID_RE = /^[0-9a-f]{24}$/;

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const paths = {
  watch: () => path.join(DATA_DIR, "watch.json"),
  brand: (id) => {
    if (!isValidDomain(id)) throw new Error(`bad brand id '${id}'`);
    return path.join(DATA_DIR, "brands", `${id}.json`);
  },
  evidence: (id) => {
    if (!EVIDENCE_ID_RE.test(id)) throw new Error(`bad evidence id '${id}'`);
    return path.join(DATA_DIR, "evidence", `${id}.json`);
  },
};

function loadWatch() {
  return readJson(paths.watch()) || { brands: {} };
}

// Adds or refreshes a brand. Paid requests count towards popularity; when the
// list is full, the least recently requested non-seed brand makes room.
function touchWatch(entry, { source = "request", now = new Date().toISOString() } = {}) {
  const w = loadWatch();
  const prev = w.brands[entry.brand_id];
  if (!prev) {
    const ids = Object.keys(w.brands);
    if (ids.length >= MAX_WATCHED) {
      const evictable = ids.filter((id) => w.brands[id].source !== "seed")
        .sort((a, b) => (w.brands[a].last_requested_at || "").localeCompare(w.brands[b].last_requested_at || ""));
      if (evictable.length === 0) return { added: false, reason: "watch list full" };
      delete w.brands[evictable[0]];
    }
  }
  w.brands[entry.brand_id] = {
    brand: entry.brand,
    official_domains: entry.official_domains,
    keywords: entry.keywords || [],
    source: prev && prev.source === "seed" ? "seed" : source,
    added_at: prev ? prev.added_at : now,
    last_requested_at: source === "request" ? now : (prev && prev.last_requested_at) || null,
    request_count: (prev ? prev.request_count || 0 : 0) + (source === "request" ? 1 : 0),
  };
  writeJsonAtomic(paths.watch(), w);
  return { added: !prev };
}

function loadBrand(id) {
  return readJson(paths.brand(id));
}

// Carry first_seen forward, stamp changed_at when risk or status moves, and
// keep findings that disappeared as `no_longer_seen` for 30 days so a weekly
// caller using `since` learns about them.
function mergeFindings(prev, next, asOf) {
  const old = new Map((prev ? prev.findings : []).map((f) => [f.domain, f]));
  const merged = next.map((f) => {
    const p = old.get(f.domain);
    old.delete(f.domain);
    if (!p) return { ...f, first_seen: asOf, changed_at: asOf };
    const changed = p.risk !== f.risk || p.status !== f.status;
    return { ...f, first_seen: p.first_seen || asOf, changed_at: changed ? asOf : p.changed_at || asOf };
  });
  const cutoff = Date.parse(asOf) - GONE_KEEP_DAYS * 86_400_000;
  for (const p of old.values()) {
    if (p.status === "no_longer_seen") {
      if (Date.parse(p.changed_at) >= cutoff) merged.push(p);
    } else {
      merged.push({ ...p, status: "no_longer_seen", risk: 0, risk_level: "none", changed_at: asOf });
    }
  }
  return merged.sort((a, b) => b.risk - a.risk || a.domain.localeCompare(b.domain));
}

function saveResult(result) {
  const prev = loadBrand(result.brand_id);
  const findings = mergeFindings(prev, result.findings, result.as_of);
  for (const e of result.evidence || []) writeJsonAtomic(paths.evidence(e.evidence_id), e);
  const { evidence, ...rest } = result;
  const doc = { ...rest, findings };
  writeJsonAtomic(paths.brand(result.brand_id), doc);
  // Drop evidence nothing points at any more.
  const keep = new Set(findings.map((f) => f.evidence_id));
  for (const f of prev ? prev.findings : []) {
    if (!keep.has(f.evidence_id)) fs.rmSync(paths.evidence(f.evidence_id), { force: true });
  }
  return doc;
}

function loadEvidence(id) {
  return readJson(paths.evidence(id));
}

module.exports = { DATA_DIR, MAX_WATCHED, paths, writeJsonAtomic, readJson, loadWatch, touchWatch, loadBrand, mergeFindings, saveResult, loadEvidence, EVIDENCE_ID_RE };
