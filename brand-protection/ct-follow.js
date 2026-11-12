// Certificate Transparency follower, run as its own container next to the
// backend (same image, same data volume; see ops/psm/docker-compose.template.yaml).
//
// Follows the tiled CT log shards that receive new certificates (one per
// operator in BP_CT_OPERATORS, picked from Chrome's log list so shard
// roll-overs need no change), keeps names that contain a watched brand word,
// and appends them to <BP_DATA_DIR>/ct/hits.jsonl. The Pi collector reads them
// through GET /ingest/ct-hits and deep-checks the ones built around the brand.
//
// Moved here from the Pi collector (owner 2026-11-11): about 15 GB/day of
// download, which Hetzner Cloud does not count; the Pi's home line would.
//
//   node ct-follow.js           follow forever
//   node ct-follow.js --once    one pass over each log
"use strict";

const fs = require("fs");
const path = require("path");
const ct = require("./lib/ct");
const store = require("./lib/store");
const { brandKeywords, splitDomain, WORDS } = require("./lib/permute");

const ONCE = process.argv.includes("--once");
const POLL_MS = 20_000;
const MAX_TILES_PER_PASS = 400; // ~100k entries; beyond this we skip ahead and record a gap
const KEYWORD_RELOAD_MS = 600_000;
const LOG_LIST_RELOAD_MS = 86_400_000;
const KEEP_DAYS = 14;

const CT_DIR = path.join(store.DATA_DIR, "ct");
const f = (name) => path.join(CT_DIR, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => console.log(JSON.stringify({ at: new Date().toISOString(), ...obj }));

function readJson(name) {
  return store.readJson(f(name));
}

function writeJson(name, obj) {
  store.writeJsonAtomic(f(name), obj);
}

function appendHits(lines) {
  fs.mkdirSync(CT_DIR, { recursive: true });
  fs.appendFileSync(f("hits.jsonl"), lines.map((l) => `${l}\n`).join(""), "utf8");
}

function readHits() {
  try {
    return fs.readFileSync(f("hits.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function pruneHits(days = KEEP_DAYS, now = Date.now()) {
  const cutoff = now - days * 86_400_000;
  const all = readHits();
  const keep = all.filter((x) => Date.parse(x.seen_at) >= cutoff);
  if (keep.length === all.length) return;
  const tmp = `${f("hits.jsonl")}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, keep.map((x) => `${JSON.stringify(x)}\n`).join(""), "utf8");
  fs.renameSync(tmp, f("hits.jsonl"));
}

// Every watched brand's words (>= 4 chars, see brandKeywords), from the backend's own
// watch list, plus the brands' own registrable domains (their subdomains are not lookalikes).
function loadKeywords() {
  const brands = Object.values(store.loadWatch().brands);
  const kws = [...new Set(brands.flatMap((b) => brandKeywords(b.official_domains, b.keywords)))].sort();
  const official = new Set(brands.flatMap((b) => b.official_domains.map((d) => (splitDomain(d) || {}).registrable).filter(Boolean)));
  return { keywords: kws, bufs: kws.map((k) => Buffer.from(k, "latin1")), official };
}

// Same rule as the Pi collector's run.js: a name counts only when it is built around
// the brand word, not when the word sits inside another one ("morpho" in
// metamorphosist.art): some label is exactly the keyword (uniswap.claim-now.xyz), or
// the registrable label is the keyword with a hyphen, digit or phishing word on
// either side (uniswap-airdrop, getuniswap, uniswap2). Keeps the stored hits small.
const SHAPE_WORDS = `(?:${WORDS.join("|")}|get|my|the|go)`;
function brandShaped(domain, keyword) {
  const labels = domain.split(".");
  if (labels.includes(keyword)) return true;
  const sp = splitDomain(domain);
  if (!sp) return false;
  const k = keyword.replace(/[^a-z0-9-]/g, "");
  return new RegExp(`^(?:${SHAPE_WORDS}-?|[a-z0-9]*-)?${k}(?:-?${SHAPE_WORDS}|-[a-z0-9-]*|[0-9]+)?$`).test(sp.label);
}

function keep(domain, kw) {
  const sp = splitDomain(domain);
  if (!sp || (kw.official && kw.official.has(sp.registrable))) return false;
  return kw.keywords.some((k) => domain.includes(k) && brandShaped(domain, k));
}

async function passLog(logInfo, kw, pos, stats) {
  const cp = ct.parseCheckpoint(await ct.get(`${logInfo.monitoring_url}checkpoint`));
  const fullTiles = Math.floor(cp.size / ct.ENTRIES_PER_TILE);
  let next = pos[logInfo.name];
  if (next === undefined) next = Math.max(0, fullTiles - 1); // start at the tip; no backfill
  const s = (stats[logInfo.name] ||= { entries: 0, hits: 0, gaps: [], last_size: 0 });
  if (fullTiles - next > MAX_TILES_PER_PASS) {
    s.gaps.push({ at: new Date().toISOString(), skipped_tiles: fullTiles - next - MAX_TILES_PER_PASS });
    s.gaps = s.gaps.slice(-20);
    next = fullTiles - MAX_TILES_PER_PASS;
  }
  for (; next < fullTiles; next++) {
    const entries = ct.parseDataTile(await ct.get(`${logInfo.monitoring_url}tile/data/${ct.tilePath(next)}`));
    const lines = [];
    entries.forEach((e, i) => {
      for (const domain of ct.matchEntry(e.cert, kw.bufs, kw.keywords)) {
        if (!keep(domain, kw)) { s.dropped = (s.dropped || 0) + 1; continue; }
        lines.push(JSON.stringify({ domain, log: logInfo.name, index: next * ct.ENTRIES_PER_TILE + i, timestamp: e.timestamp, seen_at: new Date().toISOString() }));
      }
    });
    if (lines.length) appendHits(lines);
    s.entries += entries.length;
    s.hits += lines.length;
    pos[logInfo.name] = next + 1;
    writeJson("pos.json", pos);
  }
  s.last_size = cp.size;
  s.last_pass_at = new Date().toISOString();
  delete s.last_error;
}

function settings(env = process.env) {
  const operators = (env.BP_CT_OPERATORS || "Let's Encrypt,Google").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    operators,
    aheadDays: Number(env.BP_CT_AHEAD_DAYS || 90),
    logsPerOperator: Number(env.BP_CT_LOGS_PER_OPERATOR || 1),
  };
}

async function main() {
  const cfg = settings();
  let logs = [];
  let logsAt = 0;
  let kw = loadKeywords();
  let kwAt = Date.now();
  const pos = readJson("pos.json") || {};
  const saved = readJson("stats.json");
  const stats = (saved && saved.logs) || {};
  log({ ct_follow: "start", operators: cfg.operators, keywords: kw.keywords.length });
  for (;;) {
    if (Date.now() - logsAt > LOG_LIST_RELOAD_MS) {
      try {
        const list = JSON.parse(await ct.get(ct.LOG_LIST_URL));
        let picked = ct.selectLogs(list, cfg.operators, cfg.aheadDays);
        const per = {};
        picked = picked.filter((l) => (per[l.operator] = (per[l.operator] || 0) + 1) <= cfg.logsPerOperator);
        logs = picked;
        logsAt = Date.now();
        log({ ct_logs: logs.map((l) => l.name) });
      } catch (e) {
        log({ ct_follow: "log list failed", error: String(e.message).slice(0, 200) });
      }
    }
    if (Date.now() - kwAt > KEYWORD_RELOAD_MS) { kw = loadKeywords(); kwAt = Date.now(); }
    for (const l of logs) {
      try {
        await passLog(l, kw, pos, stats);
      } catch (e) {
        (stats[l.name] ||= { entries: 0, hits: 0, gaps: [] }).last_error = `${new Date().toISOString()} ${String(e.message).slice(0, 200)}`;
      }
    }
    writeJson("stats.json", { updated_at: new Date().toISOString(), keywords: kw.keywords.length, logs: stats });
    pruneHits();
    if (ONCE) return;
    await sleep(POLL_MS);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ ct_follow: "fatal", error: String(e.message).slice(0, 300) }));
    process.exit(1);
  });
}

module.exports = { CT_DIR, readHits, pruneHits, loadKeywords, passLog, settings, brandShaped, keep };
