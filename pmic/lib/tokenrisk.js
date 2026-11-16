// Read-only replica of the Pi's token-risk snapshot (Build 2, 2026-11-15): who controls an established EVM token and
// what selling $10k / $100k / $1M of it costs on chain. The Pi computes it on its own timer and is the canonical owner.
//
// Push (ingest listener, POST /ingest/tokenrisk, no bearer: the signature is the credential):
//   {meta_json, rows_json, signature}, Ed25519 over meta_json + "\n" + rows_json with the price bank's key
//   (PRICEBANK_PUBLIC_KEY: same Pi, same trust). Same refusals as the price bank replica (bad signature, checksum,
//   stale batch, version not newer). The reply carries `queue`: tokens agents asked for that the replica doesn't
//   cover, oldest first, so the Pi adds them to its next run (owner D2.3: up to 25 per run).
//
// Read (query API, POST /v1/token-risk): {tokens: [{chain, address}], max_age_s?}
//   Covered tokens come back as stored; a token older than max_age_s (default 30 h, the timer runs every 12 h) is
//   marked stale. Uncovered tokens are `not_covered` and recorded in tokenrisk_requests (at most MAX_QUEUE rows) by a
//   small writable connection; the rest of the API stays read-only.
"use strict";

const crypto = require("crypto");
const { ClientError } = require("./http");
const { tx, kvGet, kvSet } = require("./db");
const { verifySignature, MAX_BATCH_AGE_S } = require("./pricebank");

const CHAINS = ["ethereum", "arbitrum", "base", "optimism", "polygon"];
const ASSET_RE = /^(ethereum|arbitrum|base|optimism|polygon):0x[0-9a-f]{40}$/;
const DEFAULT_MAX_AGE_S = 30 * 3600;
const MAX_TOKENS = 10;
const MAX_QUEUE = 500;
const QUEUE_REPLY = 100;

function applyBatch(db, body, { publicKeyHex = process.env.PRICEBANK_PUBLIC_KEY, now = new Date() } = {}) {
  if (!publicKeyHex) throw new ClientError(403, "replica_disabled", "PRICEBANK_PUBLIC_KEY is not set on the hub");
  if (!body || typeof body.meta_json !== "string" || typeof body.rows_json !== "string" || typeof body.signature !== "string") {
    throw new ClientError(400, "invalid_input", "body needs meta_json, rows_json and signature strings");
  }
  if (!verifySignature(publicKeyHex, `${body.meta_json}\n${body.rows_json}`, body.signature)) {
    throw new ClientError(401, "bad_signature", "signature does not verify with the configured key");
  }
  let meta, rows;
  try {
    meta = JSON.parse(body.meta_json);
    rows = JSON.parse(body.rows_json);
  } catch {
    throw new ClientError(400, "invalid_input", "meta_json and rows_json must be JSON");
  }
  if (meta.bank !== "tcs6-pi-tokenrisk") throw new ClientError(422, "wrong_batch", "this route takes tcs6-pi-tokenrisk batches only");
  if (!Number.isInteger(meta.version) || !Array.isArray(rows)) throw new ClientError(400, "invalid_input", "meta.version must be an integer and rows an array");
  const sha = crypto.createHash("sha256").update(body.rows_json, "utf8").digest("hex");
  if (sha !== meta.rows_sha256 || rows.length !== meta.count) throw new ClientError(422, "checksum_mismatch", "rows_json does not match meta.rows_sha256 / meta.count");
  const builtMs = Date.parse(meta.built_at);
  if (!Number.isFinite(builtMs) || (now.getTime() - builtMs) / 1000 > MAX_BATCH_AGE_S) throw new ClientError(422, "stale_batch", `batch built_at is missing or older than ${MAX_BATCH_AGE_S}s`);
  const current = kvGet(db, "tokenrisk_replica");
  if (current && meta.version <= current.version) {
    const e = new ClientError(409, "not_newer", `version ${meta.version} is not newer than the replica's ${current.version}`);
    e.extra = { current_version: current.version };
    throw e;
  }
  for (const r of rows) {
    if (!r || typeof r.asset !== "string" || !ASSET_RE.test(r.asset) || typeof r.verdict !== "string") throw new ClientError(422, "bad_row", "every row needs an asset key (chain:0x...) and a verdict");
  }
  tx(db, () => {
    db.prepare("DELETE FROM tokenrisk_rows").run();
    const ins = db.prepare("INSERT INTO tokenrisk_rows (asset, verdict, row_json) VALUES (?, ?, ?)");
    for (const r of rows) ins.run(r.asset, r.verdict, JSON.stringify(r));
    // Requests the new snapshot now covers leave the queue.
    db.prepare("DELETE FROM tokenrisk_requests WHERE asset IN (SELECT asset FROM tokenrisk_rows)").run();
    kvSet(db, "tokenrisk_replica", { version: meta.version, built_at: meta.built_at, received_at: now.toISOString(), count: rows.length, rows_sha256: sha });
  });
  return { accepted: true, version: meta.version, count: rows.length, queue: readQueue(db) };
}

function readQueue(db) {
  return db.prepare("SELECT asset, first_requested_at, count FROM tokenrisk_requests ORDER BY first_requested_at, asset LIMIT ?").all(QUEUE_REPLY)
    .map((q) => ({ chain: q.asset.split(":")[0], token: q.asset.split(":")[1], first_requested_at: q.first_requested_at, count: q.count }));
}

// The Pi asks for the queue when a run starts (2026-11-16), so a token asked for since the last push is checked in
// this run, not the one after. Same key as the batches: {request_json, signature}, request_json =
// {"kind":"tcs6-pi-tokenrisk-queue","at":ISO}, Ed25519 over request_json, at most QUEUE_REQUEST_MAX_AGE_S old.
const QUEUE_REQUEST_MAX_AGE_S = 600;
function queueFor(db, body, { publicKeyHex = process.env.PRICEBANK_PUBLIC_KEY, now = new Date() } = {}) {
  if (!publicKeyHex) throw new ClientError(403, "replica_disabled", "PRICEBANK_PUBLIC_KEY is not set on the hub");
  if (!body || typeof body.request_json !== "string" || typeof body.signature !== "string") {
    throw new ClientError(400, "invalid_input", "body needs request_json and signature strings");
  }
  if (!verifySignature(publicKeyHex, body.request_json, body.signature)) {
    throw new ClientError(401, "bad_signature", "signature does not verify with the configured key");
  }
  let req;
  try { req = JSON.parse(body.request_json); } catch { throw new ClientError(400, "invalid_input", "request_json must be JSON"); }
  if (!req || req.kind !== "tcs6-pi-tokenrisk-queue") throw new ClientError(422, "wrong_request", "request_json.kind must be tcs6-pi-tokenrisk-queue");
  const atMs = Date.parse(req.at);
  if (!Number.isFinite(atMs) || Math.abs(now.getTime() - atMs) / 1000 > QUEUE_REQUEST_MAX_AGE_S) {
    throw new ClientError(422, "stale_request", `request_json.at is missing or more than ${QUEUE_REQUEST_MAX_AGE_S}s from the hub's clock`);
  }
  const rep = kvGet(db, "tokenrisk_replica");
  return { queue: readQueue(db), replica_version: rep ? rep.version : null };
}

// The query API's only write: remember an uncovered token (bounded, deduplicated).
let writer = null;
function recordRequests(assets, now, openWriter) {
  if (!assets.length || !openWriter) return;
  try {
    if (!writer) {
      writer = openWriter();
      writer.exec("PRAGMA busy_timeout = 5000");
    }
    const n = writer.prepare("SELECT COUNT(*) n FROM tokenrisk_requests").get().n;
    const up = writer.prepare(`INSERT INTO tokenrisk_requests (asset, first_requested_at, last_requested_at, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(asset) DO UPDATE SET last_requested_at = excluded.last_requested_at, count = count + 1`);
    const have = writer.prepare("SELECT 1 FROM tokenrisk_requests WHERE asset = ?");
    let room = MAX_QUEUE - n;
    for (const a of assets) {
      if (have.get(a)) up.run(a, now, now);
      else if (room > 0) { up.run(a, now, now); room--; }
    }
  } catch (e) {
    console.error(JSON.stringify({ tokenrisk_queue_error: String(e && e.message).slice(0, 200) }));
  }
}

function query(db, body, { now = new Date(), openWriter = null } = {}) {
  const tokens = body.tokens;
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > MAX_TOKENS) throw new ClientError(400, "invalid_input", `tokens must be a list of 1-${MAX_TOKENS} {chain, address}`);
  const maxAge = body.max_age_s === undefined ? DEFAULT_MAX_AGE_S : body.max_age_s;
  if (typeof maxAge !== "number" || !(maxAge > 0)) throw new ClientError(400, "invalid_input", "max_age_s must be a positive number");
  const assets = tokens.map((t, i) => {
    const a = `${String((t && t.chain) || "").toLowerCase()}:${String((t && t.address) || "").toLowerCase()}`;
    if (!ASSET_RE.test(a)) throw new ClientError(400, "invalid_input", `tokens[${i}] must be {chain: ${CHAINS.join("|")}, address: 0x...}`);
    return a;
  });
  const rep = kvGet(db, "tokenrisk_replica");
  const get = db.prepare("SELECT row_json FROM tokenrisk_rows WHERE asset = ?");
  const results = [];
  const missing = [];
  for (const a of assets) {
    const r = rep ? get.get(a) : null;
    if (!r) { missing.push(a); results.push({ asset: a, status: "not_covered" }); continue; }
    const row = JSON.parse(r.row_json);
    const age = (now.getTime() - Date.parse(row.observed_at)) / 1000;
    results.push({ ...row, status: Number.isFinite(age) && age <= maxAge ? "ok" : "stale", age_s: Number.isFinite(age) ? Math.round(age) : null });
  }
  recordRequests(missing, now.toISOString(), openWriter);
  return {
    replica: rep ? { version: rep.version, built_at: rep.built_at, received_at: rep.received_at, count: rep.count, canonical: "pi" } : null,
    results,
  };
}

module.exports = { applyBatch, queueFor, query, CHAINS, MAX_TOKENS };
