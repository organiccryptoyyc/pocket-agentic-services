// Phase 3: what the collector signs, the pack verifies; the brief's attestation block.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const attest = require("../lib/attest");
const A = require("../packs/lib/attestation");

test("the pack verifies collector envelopes and builds the block; missing and tampered are labelled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-attest-pack-"));
  const db = dbLib.open({ dataDir: dir });
  const catalog = catalogLib.load();
  dbLib.syncCatalog(db, catalog);
  db.prepare("INSERT INTO confirmations (run_id, field, entity_id, our_value, upstream_service, upstream_value_hash, agreement, delta_pct, tolerance_pct, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("r", "series:chainrpc:eth_usd", "crypto-markets", JSON.stringify({ usd: 3000 }), "chainlink", "ab".repeat(32), "agree", 0.1, 1, "2026-10-18T00:00:00Z");
  const k = attest.keygen(dir);
  const now = new Date("2026-10-18T12:00:00Z");
  attest.signDue(db, catalog, dir, { now });
  const env = attest.pending(db)[0][1].envelope;
  const keysFile = path.join(dir, "keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ keys: [k] }));
  const keys = A.loadKeys(keysFile);
  assert.equal(A.keyIdOf(Buffer.from(k.public_key_b64url, "base64url")), k.key_id, "same key id scheme on both sides");
  const out = { citations: [{ series_id: "chainrpc:eth_usd" }, { series_id: "chainrpc:btc_usd" }], drivers: [{ series_id: "chainrpc:eth_usd" }] };
  const ids = A.seriesOf(out);
  assert.deepEqual(ids, ["chainrpc:btc_usd", "chainrpc:eth_usd"]);
  const later = new Date("2026-10-18T13:00:00Z");
  const b = A.block(ids, { "chainrpc:eth_usd": env }, keys, later);
  assert.deepEqual(b.summary, { series: 2, valid: 1, stale: 0, invalid: 0, missing: 1 });
  assert.equal(b.series.find((s) => s.series_id === "chainrpc:eth_usd").envelope, env, "passed through unchanged");
  assert.match(b.statement, /do not change any score/);
  const bad = JSON.parse(JSON.stringify(env));
  bad.payload.counters.passed = 0;
  const b2 = A.block(["chainrpc:eth_usd"], { "chainrpc:eth_usd": bad }, keys, later);
  assert.equal(b2.series[0].verification_status, "invalid");
  assert.equal(b2.series[0].envelope, null, "an invalid envelope is not passed on");
  assert.equal(A.block(["chainrpc:eth_usd"], { "chainrpc:eth_usd": env }, keys, new Date("2026-10-22T13:00:00Z")).series[0].verification_status, "stale");
  assert.equal(A.block(["chainrpc:eth_usd"], { "chainrpc:eth_usd": env }, {}, later).series[0].verification_status, "invalid", "unknown key");
});

test("country tables get an explicit aggregate block, never a silent gap", () => {
  const b = A.aggregateBlock();
  assert.deepEqual(b.summary, { series: 0, valid: 0, stale: 0, invalid: 0, missing: 0 });
  assert.deepEqual(b.series, []);
  assert.match(b.statement, /POST \/v1\/signal/);
});

test("hub and pack key files stay identical", () => {
  const a = fs.readFileSync(path.join(__dirname, "..", "config", "attestation_keys.json"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "..", "packs", "config", "attestation_keys.json"), "utf8");
  assert.equal(a, b);
});
