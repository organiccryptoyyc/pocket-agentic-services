// Price bank replica (TCS-6 Build B): the hub accepts only signed, newer, intact batches from the
// Pi, keeps the last good version otherwise, and refuses to serve stale prices.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbLib = require("../lib/db");
const { applyBatch, query } = require("../lib/pricebank");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pricebank-batch.json"), "utf8"));
const NOW = new Date("2026-10-10T22:10:00Z");
const USDC = "ethereum:0x" + "a0".repeat(20);
const VAULT = "ethereum:0x" + "11".repeat(20);
const hub = () => dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-pb-")) });

function nodeBatch(version, rows, { builtAt = NOW.toISOString(), key } = {}) {
  const rowsJson = JSON.stringify(rows);
  const meta = { bank: "test", version, built_at: builtAt, count: rows.length, rows_sha256: crypto.createHash("sha256").update(rowsJson).digest("hex") };
  const metaJson = JSON.stringify(meta);
  const sig = crypto.sign(null, Buffer.from(`${metaJson}\n${rowsJson}`), key.privateKey).toString("hex");
  return { meta_json: metaJson, rows_json: rowsJson, signature: sig };
}
const rawPub = (k) => k.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");

test("a batch signed on the Pi (Python Ed25519) verifies in Node and is served", () => {
  const db = hub();
  const r = applyBatch(db, FIX.body, { publicKeyHex: FIX.public_key, now: NOW });
  assert.deepEqual(r, { accepted: true, version: 3, count: 2 });
  const q = query(db, { assets: [USDC, VAULT, "ethereum:0x" + "99".repeat(20)] }, NOW);
  assert.equal(q.replica.version, 3);
  assert.equal(q.replica.stale, false);
  assert.deepEqual(q.prices.map((p) => p.asset), [USDC, VAULT]);
  assert.equal(q.prices[1].usd, 1.0523456789012345);
  assert.deepEqual(q.prices[1].flags, ["single_price_source_onchain"]);
  assert.equal(q.gaps[0].reason, "not in the price bank replica");
});

test("bad signature, tampered rows, wrong key, no key: refused, last good version kept", () => {
  const db = hub();
  applyBatch(db, FIX.body, { publicKeyHex: FIX.public_key, now: NOW });
  const tampered = { ...FIX.body, rows_json: FIX.body.rows_json.replace("1.0004", "9.0004") };
  assert.throws(() => applyBatch(db, tampered, { publicKeyHex: FIX.public_key, now: NOW }), { status: 401 });
  const other = crypto.generateKeyPairSync("ed25519");
  assert.throws(() => applyBatch(db, FIX.body, { publicKeyHex: rawPub(other), now: NOW }), { status: 401 });
  assert.throws(() => applyBatch(db, FIX.body, { publicKeyHex: "", now: NOW }), { status: 403 });
  assert.equal(query(db, { assets: [USDC] }, NOW).prices[0].usd, 1.0);
});

test("checksum mismatch, old version and stale batch are refused", () => {
  const key = crypto.generateKeyPairSync("ed25519");
  const pub = rawPub(key);
  const db = hub();
  const rows = [{ asset: USDC, usd: 1, status: "single_source", observed_at: NOW.toISOString(), sources: [] }];
  assert.equal(applyBatch(db, nodeBatch(5, rows, { key }), { publicKeyHex: pub, now: NOW }).version, 5);
  assert.throws(() => applyBatch(db, nodeBatch(5, rows, { key }), { publicKeyHex: pub, now: NOW }), (e) => e.status === 409 && e.extra.current_version === 5);
  assert.throws(() => applyBatch(db, nodeBatch(6, rows, { key, builtAt: "2026-10-01T00:00:00Z" }), { publicKeyHex: pub, now: NOW }), { status: 422 });
  // a correctly signed meta whose checksum doesn't match its rows
  const rowsJson = JSON.stringify(rows);
  const metaJson = JSON.stringify({ version: 7, built_at: NOW.toISOString(), count: 1, rows_sha256: "00".repeat(32) });
  const sig = crypto.sign(null, Buffer.from(`${metaJson}\n${rowsJson}`), key.privateKey).toString("hex");
  assert.throws(() => applyBatch(db, { meta_json: metaJson, rows_json: rowsJson, signature: sig }, { publicKeyHex: pub, now: NOW }), { status: 422 });
  assert.equal(dbLib.kvGet(db, "pricebank_replica").version, 5);
});

test("stale prices are refused and a stale replica is flagged as failover", () => {
  const db = hub();
  applyBatch(db, FIX.body, { publicKeyHex: FIX.public_key, now: NOW });
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000);
  const q = query(db, { assets: [USDC] }, later);
  assert.equal(q.prices.length, 0);
  assert.match(q.gaps[0].reason, /older than max_age_s/);
  assert.equal(q.replica.stale, true);
  assert.equal(q.replica.failover, "last_good_version");
  assert.equal(query(db, { assets: [USDC], max_age_s: 86400 }, later).prices.length, 1);
  assert.throws(() => query(db, { assets: ["mars:0x12"] }, NOW), { status: 400 });
});

test("no replica yet: every asset is a gap", () => {
  const q = query(hub(), { assets: [USDC] }, NOW);
  assert.equal(q.replica, null);
  assert.equal(q.gaps[0].reason, "no price bank replica received yet");
});
