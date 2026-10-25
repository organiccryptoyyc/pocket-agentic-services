// Reads TCS-6's stored snapshots (read-only mount) and keeps this service's pinned dossiers.
//
//   TCS6 data dir (read-only):  reports/<entity_id>.json   scored TCS-6 report (rewritten each pipeline run)
//                               evidence/<entity_id>.json  the evidence bundle that report was scored from
//   own data dir:               pairs/<entity_id>.json     the last report together with the exact bundle it was
//                                                          scored from (see refreshPairs)
//                               dossiers/<dossier_id>.json a copy of one pair, frozen at `plan` time, so every
//                                                          section of one dossier describes the same snapshot;
//                                                          deleted after 24 h.
//
// The collector pushes a new bundle hours before the pipeline rescores it, so evidence/<id>.json is often
// newer than reports/<id>.json. A report and a bundle belong together only when report.as_of equals
// bundle.collected_at; refreshPairs keeps the last such pair so a dossier never mixes two runs.
"use strict";

const fs = require("fs");
const path = require("path");

const TCS6_DIR = path.resolve(process.env.DOSSIER_TCS6_DATA_DIR || "/var/lib/tcs6");
const DATA_DIR = path.resolve(process.env.DOSSIER_DATA_DIR || "/var/lib/dossier");
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOSSIER_ID_RE = /^dos_[0-9a-f]{24}$/;
const TTL_MS = 24 * 60 * 60 * 1000; // owner 2026-10-25: a dossier stays valid for 24 hours

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

const dossiersDir = () => path.join(DATA_DIR, "dossiers");
const pairsDir = () => path.join(DATA_DIR, "pairs");

function ensureDirs() {
  fs.mkdirSync(dossiersDir(), { recursive: true });
  fs.mkdirSync(pairsDir(), { recursive: true });
}

// The live report and bundle of one entity, if the report was scored from that bundle.
function livePair(entityId) {
  const report = readJson(path.join(TCS6_DIR, "reports", `${entityId}.json`));
  const raw = readJson(path.join(TCS6_DIR, "evidence", `${entityId}.json`));
  if (!report || !raw || !report.overall_score) return null;
  const bundle = raw.bundle || raw;
  return report.as_of === bundle.collected_at ? { report, bundle } : null;
}

// Saves every matching live pair; run at start-up and every few minutes (server.js).
function refreshPairs() {
  ensureDirs();
  let saved = 0;
  for (const id of listEntities()) {
    const live = livePair(id);
    if (!live) continue;
    const p = path.join(pairsDir(), `${id}.json`);
    const old = readJson(p);
    if (old && old.report.report_id === live.report.report_id) continue;
    writeJsonAtomic(p, live);
    saved += 1;
  }
  return saved;
}

// The latest scored TCS-6 snapshot of one entity, {report, bundle}, or null if none was seen yet.
function latestSnapshot(entityId) {
  return livePair(entityId) || readJson(path.join(pairsDir(), `${entityId}.json`));
}

function listEntities() {
  let names = [];
  try {
    names = fs.readdirSync(path.join(TCS6_DIR, "reports")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    names = [];
  }
  return names.filter((n) => ENTITY_ID_RE.test(n)).sort();
}

function savePinned(id, obj) {
  ensureDirs();
  writeJsonAtomic(path.join(dossiersDir(), `${id}.json`), obj);
}

function loadPinned(id, nowMs = Date.now()) {
  if (!DOSSIER_ID_RE.test(id)) return null;
  const p = path.join(dossiersDir(), `${id}.json`);
  const d = readJson(p);
  if (!d) return null;
  if (nowMs - Date.parse(d.created_at) > TTL_MS) {
    fs.rmSync(p, { force: true });
    return null;
  }
  return d;
}

// Drops expired dossiers; called on each plan so the folder stays small without a scheduler.
function purgeExpired(nowMs = Date.now()) {
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(dossiersDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = path.join(dossiersDir(), name);
    const d = readJson(p);
    if (!d || nowMs - Date.parse(d.created_at) > TTL_MS) {
      fs.rmSync(p, { force: true });
      n += 1;
    }
  }
  return n;
}

module.exports = { TCS6_DIR, DATA_DIR, ENTITY_ID_RE, DOSSIER_ID_RE, TTL_MS, ensureDirs, latestSnapshot, refreshPairs, listEntities, savePinned, loadPinned, purgeExpired };
