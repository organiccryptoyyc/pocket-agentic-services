// Immutable raw payload store. Each fetched body is one JSON line, gzipped as its own member and
// appended to <PMIC_DATA_DIR>/raw/<source_id>/<YYYY-MM-DD>.jsonl.gz. Concatenated gzip members
// are one valid gzip stream, so `zcat file | jq` reads a whole day. Files are never rewritten;
// retention deletes whole day files older than the raw class (380 days).
//
// A body whose sha256 already sits in a raw file that still exists is not stored again: the
// fetch log and every row parsed from it point at the earlier copy.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function dayFile(dataDir, sourceId, iso) {
  return path.join(dataDir, "raw", sourceId, `${iso.slice(0, 10)}.jsonl.gz`);
}

function store(db, dataDir, { source_id, job_key, url, fetched_at, status, content_type, body }) {
  const hash = sha256(body);
  const prior = db.prepare("SELECT raw_file FROM fetch_logs WHERE raw_sha256 = ? AND raw_file IS NOT NULL ORDER BY id DESC LIMIT 1").get(hash);
  if (prior && fs.existsSync(path.join(dataDir, prior.raw_file))) return { sha256: hash, raw_file: prior.raw_file, reused: true };
  const file = dayFile(dataDir, source_id, fetched_at);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ sha256: hash, source_id, job_key, url, fetched_at, status, content_type, body }) + "\n";
  fs.appendFileSync(file, zlib.gzipSync(line), { mode: 0o600 });
  return { sha256: hash, raw_file: path.relative(dataDir, file), reused: false };
}

// Find one payload again (provenance lookups). Reads the day file it was logged under.
function read(dataDir, rawFile, hash) {
  const file = path.join(dataDir, rawFile);
  if (!fs.existsSync(file)) return null;
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  for (const line of text.split("\n")) {
    if (line && line.includes(hash)) {
      const rec = JSON.parse(line);
      if (rec.sha256 === hash) return rec;
    }
  }
  return null;
}

function prune(dataDir, keepDays, now = new Date()) {
  const root = path.join(dataDir, "raw");
  if (!fs.existsSync(root)) return 0;
  const cutoff = new Date(now.getTime() - keepDays * 86400000).toISOString().slice(0, 10);
  let removed = 0;
  for (const src of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, src))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f);
      if (m && m[1] < cutoff) {
        fs.rmSync(path.join(root, src, f));
        removed++;
      }
    }
  }
  return removed;
}

module.exports = { store, read, prune, sha256 };
