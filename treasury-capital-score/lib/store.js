// File-backed state shared by the API server, the pipeline, and the ingest
// listener. Layout under TCS6_DATA_DIR (default ./var):
//   evidence/<entity_id>.json   latest evidence bundle pushed by the Pi collector
//   reports/<entity_id>.json    latest schema-validated report (pipeline output)
//   pipeline-state.json         last run summary, surfaced by /v1/health
// Every write is temp-file + rename so a reader never sees a partial file.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.resolve(process.env.TCS6_DATA_DIR || path.join(ROOT, "var"));
const REGISTRY_PATH = path.resolve(process.env.TCS6_REGISTRY || path.join(ROOT, "data", "registry.json"));
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function ensureDirs() {
  for (const d of ["evidence", "reports"]) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// mtime-keyed read cache so the relay path does not re-parse unchanged files.
const _cache = new Map();
function readJsonCached(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
  const value = readJson(file);
  if (value !== null) _cache.set(file, { mtimeMs: st.mtimeMs, value });
  return value;
}

const paths = {
  evidence: (id) => path.join(DATA_DIR, "evidence", `${id}.json`),
  report: (id) => path.join(DATA_DIR, "reports", `${id}.json`),
  state: () => path.join(DATA_DIR, "pipeline-state.json"),
};

function loadRegistry() {
  const reg = readJsonCached(REGISTRY_PATH);
  if (!reg || !Array.isArray(reg.entities)) throw new Error(`registry not readable at ${REGISTRY_PATH}`);
  return reg.entities;
}

module.exports = { DATA_DIR, REGISTRY_PATH, ENTITY_ID_RE, ensureDirs, writeJsonAtomic, readJson, readJsonCached, paths, loadRegistry };
