// Token-risk replica (Build 2): the hub accepts only signed, newer, intact tcs6-pi-tokenrisk batches from the Pi,
// serves covered tokens, marks old ones stale, and queues uncovered tokens for the Pi's next run.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbLib = require("../lib/db");
const { applyBatch, query } = require("../lib/tokenrisk");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tokenrisk-batch.json"), "utf8"));
const NOW = new Date(Date.parse(FIX.built_at) + 3600 * 1000);
const A = "ethereum:0x" + "a0".repeat(20);
const B = "base:0x" + "b1".repeat(20);
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-tr-"));
  return { db: dbLib.open({ dataDir: dir }), dir };
};

function nodeBatch(version, rows, { bank = "tcs6-pi-tokenrisk", builtAt = NOW.toISOString(), key } = {}) {
  const rowsJson = JSON.stringify(rows);
  const meta = { bank, version, built_at: builtAt, count: rows.length, rows_sha256: crypto.createHash("sha256").update(rowsJson).digest("hex") };
  const metaJson = JSON.stringify(meta);
  return { meta_json: metaJson, rows_json: rowsJson, signature: crypto.sign(null, Buffer.from(`${metaJson}\n${rowsJson}`), key.privateKey).toString("hex") };
}
const rawPub = (k) => k.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");

test("a batch signed on the Pi (Python Ed25519) is accepted and served; uncovered tokens are queued", () => {
  const { db, dir } = fresh();
  const r = applyBatch(db, FIX.body, { publicKeyHex: FIX.public_key, now: NOW });
  assert.deepEqual([r.accepted, r.count, r.queue], [true, 2, []]);
  const other = "arbitrum:0x" + "cc".repeat(20);
  const q = query(db, { tokens: [{ chain: "ethereum", address: "0x" + "A0".repeat(20) }, { chain: "base", address: "0x" + "b1".repeat(20) }, { chain: "arbitrum", address: "0x" + "cc".repeat(20) }] },
    { now: NOW, openWriter: () => dbLib.open({ dataDir: dir }) });
  assert.equal(q.replica.count, 2);
  assert.deepEqual(q.results.map((x) => [x.asset, x.status, x.verdict]), [[A, "ok", "low"], [B, "ok", "high"], [other, "not_covered", undefined]]);
  // The next push gets the queue back; once the snapshot covers the token, it leaves the queue.
  const key = crypto.generateKeyPairSync("ed25519");
  const pub = rawPub(key);
  const next = applyBatch(db, nodeBatch(2e9, [{ asset: A, verdict: "low", observed_at: NOW.toISOString() }], { key }), { publicKeyHex: pub, now: NOW });
  assert.deepEqual(next.queue.map((x) => [x.chain, x.token, x.count]), [["arbitrum", "0x" + "cc".repeat(20), 1]]);
  const covered = applyBatch(db, nodeBatch(2e9 + 1, [{ asset: other, verdict: "low", observed_at: NOW.toISOString() }], { key }), { publicKeyHex: pub, now: NOW });
  assert.deepEqual(covered.queue, []);
});

test("refusals: bad signature, other batch kinds, older versions, stale batches; last good kept", () => {
  const { db } = fresh();
  const key = crypto.generateKeyPairSync("ed25519");
  const pub = rawPub(key);
  const rows = [{ asset: A, verdict: "low", observed_at: NOW.toISOString() }];
  applyBatch(db, nodeBatch(10, rows, { key }), { publicKeyHex: pub, now: NOW });
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.equal(code(() => applyBatch(db, { ...nodeBatch(11, rows, { key }), signature: "00".repeat(64) }, { publicKeyHex: pub, now: NOW })), "bad_signature");
  assert.equal(code(() => applyBatch(db, nodeBatch(11, rows, { key, bank: "tcs6-pi-pricebank" }), { publicKeyHex: pub, now: NOW })), "wrong_batch");
  assert.equal(code(() => applyBatch(db, nodeBatch(10, rows, { key }), { publicKeyHex: pub, now: NOW })), "not_newer");
  assert.equal(code(() => applyBatch(db, nodeBatch(12, rows, { key, builtAt: "2026-01-01T00:00:00Z" }), { publicKeyHex: pub, now: NOW })), "stale_batch");
  assert.equal(code(() => applyBatch(db, nodeBatch(12, [{ asset: "solana:abc", verdict: "low" }], { key }), { publicKeyHex: pub, now: NOW })), "bad_row");
  assert.equal(code(() => applyBatch(db, nodeBatch(12, rows, { key }), { publicKeyHex: "", now: NOW })), "replica_disabled");
  assert.equal(query(db, { tokens: [{ chain: "ethereum", address: "0x" + "a0".repeat(20) }] }, { now: NOW }).replica.version, 10);
});

test("reads: an old row is stale; bad input is a 400", () => {
  const { db } = fresh();
  const key = crypto.generateKeyPairSync("ed25519");
  applyBatch(db, nodeBatch(1, [{ asset: A, verdict: "elevated", observed_at: "2026-11-13T00:00:00Z" }], { key }), { publicKeyHex: rawPub(key), now: NOW });
  assert.equal(query(db, { tokens: [{ chain: "ethereum", address: "0x" + "a0".repeat(20) }] }, { now: NOW }).results[0].status, "stale");
  for (const bad of [{}, { tokens: [] }, { tokens: Array(11).fill({ chain: "ethereum", address: "0x" + "a0".repeat(20) }) }, { tokens: [{ chain: "solana", address: "x" }] }, { tokens: [{ chain: "ethereum", address: "0x12" }] }]) {
    assert.throws(() => query(db, bad, { now: NOW }), (e) => e.status === 400);
  }
});
