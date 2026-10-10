// Read-only replica of the shared price bank (TCS-6 Build B). The Pi is the canonical owner; it
// pushes signed, versioned batches here and nothing on the hub can edit a price.
//
// Push (ingest listener, POST /ingest/pricebank, no bearer: the signature is the credential):
//   {meta_json, rows_json, signature}  Ed25519 over meta_json + "\n" + rows_json, checked with
//   PRICEBANK_PUBLIC_KEY (hex, the Pi's public key). Refused: no key configured (503), bad
//   signature (401), checksum or count mismatch (422), batch older than MAX_BATCH_AGE_S (422),
//   version not newer than the one held (409, with current_version). An accepted batch replaces
//   the replica in one transaction; a refused one leaves the last good version in place.
//
// Read (query API, POST /v1/prices): {assets: ["ethereum:0x...", ...], max_age_s?}
//   Prices older than max_age_s (default 6h) are refused and listed as gaps, never served stale.
//   When the replica itself is older than max_age_s it is flagged stale and readers get the last
//   good version's still-fresh rows only (explicit failover, no silent mixing).
"use strict";

const crypto = require("crypto");
const { ClientError } = require("./http");
const { tx, kvGet, kvSet } = require("./db");

const MAX_BATCH_AGE_S = 48 * 3600;
const DEFAULT_MAX_AGE_S = 6 * 3600;
const MAX_ASSETS = 500;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ASSET_RE = /^[a-z0-9_-]{2,20}:(native|0x[0-9a-f]{40})$/;

function verifySignature(publicKeyHex, message, signatureHex) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex || "") || !/^[0-9a-f]{128}$/i.test(signatureHex || "")) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

function applyBatch(db, body, { publicKeyHex = process.env.PRICEBANK_PUBLIC_KEY, now = new Date() } = {}) {
  if (!publicKeyHex) throw new ClientError(403, "replica_disabled", "PRICEBANK_PUBLIC_KEY is not set on the hub");
  if (!body || typeof body.meta_json !== "string" || typeof body.rows_json !== "string" || typeof body.signature !== "string") {
    throw new ClientError(400, "invalid_input", "body needs meta_json, rows_json and signature strings");
  }
  if (!verifySignature(publicKeyHex, `${body.meta_json}\n${body.rows_json}`, body.signature)) {
    throw new ClientError(401, "bad_signature", "signature does not verify with the configured price bank key");
  }
  let meta, rows;
  try {
    meta = JSON.parse(body.meta_json);
    rows = JSON.parse(body.rows_json);
  } catch {
    throw new ClientError(400, "invalid_input", "meta_json and rows_json must be JSON");
  }
  if (!Number.isInteger(meta.version) || !Array.isArray(rows)) throw new ClientError(400, "invalid_input", "meta.version must be an integer and rows an array");
  const sha = crypto.createHash("sha256").update(body.rows_json, "utf8").digest("hex");
  if (sha !== meta.rows_sha256 || rows.length !== meta.count) throw new ClientError(422, "checksum_mismatch", "rows_json does not match meta.rows_sha256 / meta.count");
  const builtMs = Date.parse(meta.built_at);
  if (!Number.isFinite(builtMs) || (now.getTime() - builtMs) / 1000 > MAX_BATCH_AGE_S) throw new ClientError(422, "stale_batch", `batch built_at is missing or older than ${MAX_BATCH_AGE_S}s`);
  const current = kvGet(db, "pricebank_replica");
  if (current && meta.version <= current.version) {
    const e = new ClientError(409, "not_newer", `version ${meta.version} is not newer than the replica's ${current.version}`);
    e.extra = { current_version: current.version };
    throw e;
  }
  for (const r of rows) {
    if (!r || typeof r.asset !== "string" || !ASSET_RE.test(r.asset) || typeof r.status !== "string") throw new ClientError(422, "bad_row", "every row needs an asset key and a status");
  }
  tx(db, () => {
    db.prepare("DELETE FROM pricebank_rows").run();
    const ins = db.prepare("INSERT INTO pricebank_rows (asset, usd, status, observed_at, row_json) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(r.asset, typeof r.usd === "number" ? r.usd : null, r.status, r.observed_at || null, JSON.stringify(r));
    kvSet(db, "pricebank_replica", { version: meta.version, built_at: meta.built_at, received_at: now.toISOString(), count: rows.length, rows_sha256: sha, bank: meta.bank });
  });
  return { accepted: true, version: meta.version, count: rows.length };
}

function query(db, body, now = new Date()) {
  const assets = body.assets;
  if (!Array.isArray(assets) || !assets.length || assets.length > MAX_ASSETS || assets.some((a) => typeof a !== "string" || !ASSET_RE.test(a.toLowerCase()))) {
    throw new ClientError(400, "invalid_input", `assets must be 1-${MAX_ASSETS} keys like "ethereum:0x..." or "base:native"`);
  }
  const maxAge = body.max_age_s === undefined ? DEFAULT_MAX_AGE_S : body.max_age_s;
  if (typeof maxAge !== "number" || !(maxAge > 0)) throw new ClientError(400, "invalid_input", "max_age_s must be a positive number");
  const rep = kvGet(db, "pricebank_replica");
  if (!rep) return { replica: null, prices: [], gaps: assets.map((a) => ({ asset: a.toLowerCase(), reason: "no price bank replica received yet" })) };
  const repAge = (now.getTime() - Date.parse(rep.built_at)) / 1000;
  const get = db.prepare("SELECT row_json FROM pricebank_rows WHERE asset = ?");
  const prices = [];
  const gaps = [];
  for (const a of assets.map((x) => x.toLowerCase())) {
    const r = get.get(a);
    if (!r) { gaps.push({ asset: a, reason: "not in the price bank replica" }); continue; }
    const row = JSON.parse(r.row_json);
    if (row.status === "missing" || typeof row.usd !== "number") { gaps.push({ asset: a, reason: "the price bank has no price for it" }); continue; }
    const age = (now.getTime() - Date.parse(row.observed_at)) / 1000;
    if (!Number.isFinite(age) || age > maxAge) { gaps.push({ asset: a, reason: `price older than max_age_s (${Math.round(age)}s)` }); continue; }
    prices.push({ ...row, age_s: Math.round(age) });
  }
  return {
    replica: { version: rep.version, built_at: rep.built_at, received_at: rep.received_at, age_s: Math.round(repAge), stale: repAge > maxAge,
      ...(repAge > maxAge ? { failover: "last_good_version" } : {}), canonical: "pi" },
    prices,
    gaps,
  };
}

module.exports = { applyBatch, query, verifySignature, MAX_BATCH_AGE_S };
