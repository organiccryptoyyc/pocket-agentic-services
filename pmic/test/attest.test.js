// Verified layer, Phase 3: per-series signed attestations (collector), storage and query (hub).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const attest = require("../lib/attest");
const { canonicalJson } = require("../lib/canonical");

const catalog = catalogLib.load();
const NOW = new Date("2026-10-18T12:00:00Z");

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-attest-"));
  const db = dbLib.open({ dataDir: dir });
  dbLib.syncCatalog(db, catalog);
  return { db, dir };
}

const COLS = ["run_id", "field", "entity_id", "our_value", "upstream_service", "upstream_value_hash", "agreement", "delta_pct", "tolerance_pct", "observed_at"];
function row(db, r) {
  db.prepare(`INSERT INTO confirmations (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`).run(...COLS.map((c) => (r[c] === undefined ? null : r[c])));
}
function seed(db) {
  row(db, { run_id: "r1", field: "series:chainrpc:eth_usd", entity_id: "crypto-markets", our_value: JSON.stringify({ date: "2026-10-17", usd: 3000, block: 1 }),
    upstream_service: "chainlink", upstream_value_hash: "ab".repeat(32), agreement: "agree", delta_pct: 0.2, tolerance_pct: 1, observed_at: "2026-10-17T00:00:00Z" });
  // a later row for the same check replaces the earlier one
  row(db, { run_id: "r2", field: "series:chainrpc:eth_usd", entity_id: "crypto-markets", our_value: JSON.stringify({ date: "2026-10-18", usd: 3010, block: 2 }),
    upstream_service: "chainlink", upstream_value_hash: "cd".repeat(32), agreement: "disagree", delta_pct: 3.1, tolerance_pct: 1, observed_at: "2026-10-18T00:00:00Z" });
  row(db, { run_id: "r2", field: "rpc.total_supply:eth:0xa0b8", entity_id: "crypto-stablecoins", our_value: JSON.stringify({ raw: "1", block: 5, series_id: "chainrpc:usdc_supply:eth" }),
    upstream_service: "rpc:ethereum-rpc.publicnode.com", upstream_value_hash: "ef".repeat(32), agreement: "agree", delta_pct: 0, tolerance_pct: 0, observed_at: "2026-10-18T00:00:00Z" });
  row(db, { run_id: "r2", field: "pokt.live:gateways", entity_id: "us-pocket", our_value: JSON.stringify({ block: 9, count: 8 }),
    upstream_service: "pokt-lcd", agreement: "unavailable", tolerance_pct: 0, observed_at: "2026-10-18T00:00:00Z" });
  row(db, { run_id: "r2", field: "record:irs990:123:2024", entity_id: "us-nonprofits", our_value: JSON.stringify({ revenue: 1 }),
    upstream_service: "propublica", agreement: "agree", tolerance_pct: 0.5, observed_at: "2026-10-18T00:00:00Z" });
  row(db, { run_id: "r2", field: "series:fred:UNRATE", entity_id: "us", our_value: JSON.stringify({ date: "2026-09-01", value: 4.2 }),
    upstream_service: "propublica", agreement: "agree", tolerance_pct: 0.5, observed_at: "2026-10-18T00:00:00Z" }); // internal-only source
}

test("payloads: one per series, latest result per check, classes, counters, internal-only sources excluded", () => {
  const { db } = fresh();
  seed(db);
  const p = attest.buildPayloads(db, catalog, { internalOnly: new Set(["propublica"]) });
  assert.deepEqual([...p.keys()].sort(), ["chainrpc:eth_usd", "chainrpc:usdc_supply:eth", "pokt:gateways"]);
  const eth = p.get("chainrpc:eth_usd");
  assert.equal(eth.checks.length, 1);
  assert.equal(eth.checks[0].status, "conflicted", "the later disagreeing row is the one that counts");
  assert.equal(eth.checks[0].independence, "partially_independent");
  assert.deepEqual(eth.review_items.conflicted_check_ids, ["series:chainrpc:eth_usd|chainlink"]);
  assert.equal(eth.review_required, true);
  assert.match(eth.statement, /Conflicted: chainlink/);
  assert.equal(eth.checks[0].checked_at, "2026-10-18T00:00:00Z", "no time in the run id: falls back to observed_at");
  assert.match(eth.statement, /One check was completed: 0 passed, 0 were within the wider tolerance, 1 conflicted, and 0 were unavailable\./);
  assert.match(eth.statement, /does not by itself permit the reading to be independently reconstructed/);
  assert.match(eth.statement, /the result, and the source-independence classification\./);
  assert.match(eth.statement, /value, score, or brief\./);
  assert.equal(eth.checks[0].comparison_source, "chainlink");
  assert.equal(eth.checks[0].primary_source, "pmic");
  assert.equal(eth.checks[0].comparison_reading_disclosed, false);
  assert.match(eth.statement, /does not change any PMIC value, score, or brief/);
  assert.match(eth.evidence_manifest_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(p.get("chainrpc:usdc_supply:eth").checks[0].independence, "transport_corroboration");
  const g = p.get("pokt:gateways").counters;
  assert.deepEqual(g, { attempted: 1, passed: 0, partial: 0, conflicted: 0, unavailable: 1, completed: 0, requiring_review: 0 });
});

test("the window uses when the checks ran, not the date of the data they compared", () => {
  const { db } = fresh();
  row(db, { run_id: "pmic/2026-10-13T03:23:05.123Z", field: "series:fred:CPIAUCSL", entity_id: "us", our_value: JSON.stringify({ date: "2026-09-01", value: 1 }),
    upstream_service: "bls", upstream_value_hash: "ab".repeat(32), agreement: "agree", delta_pct: 0, tolerance_pct: 0.05, observed_at: "2026-09-01T00:00:00Z" });
  const p = attest.buildPayloads(db, catalog).get("fred:CPIAUCSL");
  assert.equal(p.checks[0].checked_at, "2026-10-13T03:23:05Z");
  assert.equal(p.checks[0].observed_at, "2026-09-01T00:00:00Z");
  assert.match(p.statement, /performed at 2026-10-13T03:23:05Z under/);
});

test("keygen once, sign, verify; every tamper and mismatch is labelled", () => {
  const { db, dir } = fresh();
  seed(db);
  const k = attest.keygen(dir);
  assert.match(k.key_id, /^pmic-attest-[0-9a-f]{16}$/);
  assert.equal(k.created, true);
  assert.equal(attest.keygen(dir).created, false, "never overwritten");
  assert.equal(fs.statSync(path.join(dir, "attest_ed25519.pem")).isFile(), true);
  const keys = attest.keysFrom([k]);
  const r = attest.signDue(db, catalog, dir, { now: NOW, internalOnly: new Set(["propublica"]) });
  assert.equal(r.signed.length, 3);
  assert.equal(attest.signDue(db, catalog, dir, { now: new Date(NOW.getTime() + 3600e3), internalOnly: new Set(["propublica"]) }).signed.length, 0, "unchanged and fresh: not re-signed");
  assert.equal(attest.signDue(db, catalog, dir, { now: new Date(NOW.getTime() + 25 * 3600e3), internalOnly: new Set(["propublica"]) }).signed.length, 3, "re-signed daily");
  const env = attest.pending(db).find(([id]) => id === "chainrpc:eth_usd")[1].envelope;
  const v = (e, sid = "chainrpc:eth_usd", now = new Date(Date.parse(e.signature.signed_at) + 60e3)) => attest.verifyEnvelope(e, sid, keys, now);
  assert.equal(v(env).status, "valid");
  const clone = () => JSON.parse(JSON.stringify(env));
  let e = clone(); e.payload.checks[0].status = "passed";
  assert.match(v(e).detail, /payload hash mismatch/);
  e = clone(); e.signature.signed_at = "2026-10-19T00:00:00Z";
  assert.match(v(e, undefined, new Date("2026-10-19T00:01:00Z")).detail, /bad signature/);
  assert.match(v(env, "chainrpc:btc_usd").detail, /another series/);
  e = clone(); e.signature.key_id = "pmic-attest-0000000000000000";
  assert.match(v(e).detail, /unknown key/);
  assert.equal(v(env, undefined, new Date(Date.parse(env.signature.signed_at) + 73 * 3600e3)).status, "stale");
  assert.equal(attest.verifyEnvelope(null, "x", keys).status, "invalid");
  assert.equal(Object.keys(attest.keysFrom([{ ...k, key_id: "pmic-attest-ffffffffffffffff" }])).length, 0, "a key id that doesn't match its key is ignored");
});

test("hub: stores only valid envelopes, keeps the newest, answers queries", () => {
  const src = fresh();
  seed(src.db);
  const k = attest.keygen(src.dir);
  attest.signDue(src.db, catalog, src.dir, { now: NOW });
  const envs = attest.pending(src.db).map(([, v]) => v.envelope);
  const hub = fresh().db;
  const keys = attest.keysFrom([k]);
  const bad = JSON.parse(JSON.stringify(envs[0]));
  bad.payload.counters.passed = 99;
  const r = attest.storeEnvelopes(hub, [...envs, bad], keys, new Date(NOW.getTime() + 60e3));
  assert.equal(r.accepted, envs.length);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /payload hash mismatch/);
  const q = attest.query(hub, { series_ids: ["chainrpc:eth_usd", "nope"] });
  assert.deepEqual(Object.keys(q.attestations), ["chainrpc:eth_usd"]);
  assert.equal(canonicalJson(q.attestations["chainrpc:eth_usd"]), canonicalJson(envs.find((x) => x.payload.subject.series_id === "chainrpc:eth_usd")), "stored and served unchanged");
  assert.throws(() => attest.query(hub, {}), /series_ids/);
});
