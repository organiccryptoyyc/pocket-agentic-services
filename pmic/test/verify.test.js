// Verified layer 1.5: crypto cross-checks into the confirmations table, against stubs.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");
const { makeFetch } = require("./stub-upstream");

const NOW = new Date("2026-10-06T06:00:00Z");
const catalog = catalogLib.load();
const rows = (db) => db.prepare("SELECT field, entity_id, upstream_service, agreement, delta_pct, upstream_value_hash, our_value FROM confirmations ORDER BY id").all();

async function run({ now = NOW, db = null, env = {}, wrap = (f) => f } = {}) {
  db = db || dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-verify-")) });
  const fetchImpl = wrap(makeFetch(catalog, { now }));
  const summary = await collectOnce(db, catalog, { now, dataDir: os.tmpdir(), env, fetchImpl, sources: ["chainrpc"], force: true });
  return { db, summary };
}

// Rewrite the answer of one host/call so a check can be made to disagree or fail.
const tamper = (match, edit) => (f) => async (url, init, opts) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (match(new URL(url).host, body)) return edit(await f(url, init, opts), body);
  return f(url, init, opts);
};

test("prices agree with Chainlink at the same block; supply agrees across the two RPCs", async () => {
  const { db, summary } = await run();
  assert.ok(summary.verify, "verify ran");
  const r = rows(db);
  const prices = r.filter((x) => x.field.startsWith("series:"));
  assert.deepEqual([...new Set(prices.map((x) => x.field))].sort(), ["series:chainrpc:btc_usd", "series:chainrpc:eth_usd"]);
  assert.ok(prices.every((x) => x.upstream_service === "chainlink" && x.agreement === "agree"), JSON.stringify(prices[0]));
  assert.ok(prices.every((x) => Math.abs(x.delta_pct - 0.1996) < 0.01), "stub Chainlink is 0.2% off");
  assert.ok(prices.length >= 2 && prices.length <= 8, `only the last 3 days, not the 120-day backfill (${prices.length})`);
  assert.ok(prices.every((x) => JSON.parse(x.our_value).block > 0), "our value carries the block that was compared");
  const supply = r.filter((x) => x.field.startsWith("rpc.total_supply:"));
  assert.deepEqual(supply.map((x) => x.field.split(":")[1]).sort(), ["arb-one", "base", "eth", "poly"]);
  assert.ok(supply.every((x) => x.agreement === "agree" && x.upstream_service.endsWith("publicnode.com")));
  assert.ok(r.every((x) => x.agreement === "unavailable" || /^[0-9a-f]{64}$/.test(x.upstream_value_hash)), "only a hash of the other reading");
  const q = Object.fromEntries(db.prepare("SELECT service_id, calls, errors, disagreements FROM upstream_quality").all().map((x) => [x.service_id, x]));
  assert.equal(q.chainlink.calls, prices.length);
});

test("a second pass the same day adds nothing; a new day checks only the new date", async () => {
  const { db } = await run();
  const n = rows(db).length;
  await run({ db });
  assert.equal(rows(db).length, n, "same day: prices already checked, supply already sampled");
  await run({ db, now: new Date(NOW.getTime() + 86400000) });
  const added = rows(db).slice(n);
  assert.equal(added.filter((x) => x.field.startsWith("series:")).length, 2, "one new date for each of ETH and BTC");
  assert.equal(added.filter((x) => x.field.startsWith("rpc.total_supply:")).length, 4, "supply re-sampled on the new day");
});

test("disagreements and failures are recorded, not hidden", async () => {
  const off = (r) => {
    const j = JSON.parse(r.text);
    return { ...r, text: JSON.stringify({ ...j, result: `0x${(BigInt(j.result) + 1n).toString(16)}` }) };
  };
  const { db } = await run({ wrap: (f) => tamper((h, b) => h === "ethereum-rpc.publicnode.com" && b && b.method === "eth_call", off)(
    tamper((h, b) => h === "base-rpc.publicnode.com", () => ({ status: 503, ok: false, text: "" }))(
      tamper((h, b) => b && b.params && b.params[0] && b.params[0].data === "0xfeaf968c", (r) => {
        const j = JSON.parse(r.text);
        const ans = BigInt(`0x${j.result.slice(66, 130)}`) * 105n / 100n; // Chainlink 5% higher
        return { ...r, text: JSON.stringify({ ...j, result: j.result.slice(0, 66) + ans.toString(16).padStart(64, "0") + j.result.slice(130) }) };
      })(f))) });
  const by = Object.fromEntries(rows(db).filter((x) => x.field.startsWith("rpc.")).map((x) => [x.field.split(":")[1], x.agreement]));
  assert.equal(by.eth, "disagree");
  assert.equal(by.base, "unavailable");
  assert.equal(by["arb-one"], "agree");
  assert.ok(rows(db).filter((x) => x.field.startsWith("series:")).every((x) => x.agreement === "disagree" && x.delta_pct > 4));
  const q = Object.fromEntries(db.prepare("SELECT service_id, errors, disagreements FROM upstream_quality").all().map((x) => [x.service_id, x]));
  assert.equal(q["rpc:base-rpc.publicnode.com"].errors, 1);
  assert.equal(q["rpc:ethereum-rpc.publicnode.com"].disagreements, 1);
});

test("verification never changes series or scores, and PMIC_VERIFY=0 turns it off", async () => {
  const snap = (db) => JSON.stringify(db.prepare(`SELECT series_id, as_of, current_value, transformed_value, zscore FROM scores ORDER BY series_id`).all())
    + JSON.stringify(db.prepare("SELECT series_id, observation_time, metric_value FROM observations ORDER BY series_id, observation_time").all());
  const on = await run();
  const off = await run({ env: { PMIC_VERIFY: "0" } });
  assert.equal(off.summary.verify, undefined);
  assert.equal(rows(off.db).length, 0);
  assert.ok(rows(on.db).length > 0);
  assert.equal(snap(on.db), snap(off.db));
});

test("FRED vs BLS cross_check groups are recorded once per observation, with disagreements", async () => {
  const { verify } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-xcheck-")) });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: {}, fetchImpl: makeFetch(catalog, { now: NOW, blsMirrorsFred: true }), sources: ["fred", "bls"], force: true });
  const x = () => rows(db).filter((r) => r.upstream_service === "bls");
  assert.deepEqual(x().map((r) => r.field).sort(), ["series:fred:JTSJOL", "series:fred:PAYEMS", "series:fred:UNRATE"]);
  assert.ok(x().every((r) => r.agreement === "agree" && r.delta_pct < 0.5), JSON.stringify(x()[0]));
  await verify(db, catalog, { now: NOW, fetchImpl: makeFetch(catalog, { now: NOW }) });
  assert.equal(x().length, 3, "the same observation is not recorded twice");
  // BLS revises the latest payrolls number by 2%: the next check of that observation disagrees
  const last = db.prepare("SELECT MAX(observation_time) t FROM observations WHERE series_id = 'bls:CES0000000001'").get().t;
  db.prepare("UPDATE observations SET metric_value = metric_value * 1.02 WHERE series_id = 'bls:CES0000000001' AND observation_time = ?").run(last);
  db.prepare("DELETE FROM kv WHERE k = 'verified:xcheck:us_payrolls:bls:CES0000000001'").run();
  await verify(db, catalog, { now: NOW, fetchImpl: makeFetch(catalog, { now: NOW }) });
  const pay = x().filter((r) => r.field === "series:fred:PAYEMS");
  assert.equal(pay.length, 2);
  assert.equal(pay[1].agreement, "disagree");
  assert.ok(Math.abs(pay[1].delta_pct - 1.9608) < 0.001, String(pay[1].delta_pct));
  const q = db.prepare("SELECT calls, disagreements FROM upstream_quality WHERE service_id = 'bls'").get();
  assert.deepEqual({ ...q }, { calls: 4, disagreements: 1 });
});
