// Crypto sources (Pocket public RPC, CFTC) and the crypto bundle's tools, against stubs.
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
const obs = (db, id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time").all(id);

async function run(sources, now = NOW, dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-crypto-")), db = null) {
  db = db || dbLib.open({ dataDir: dir });
  const fetchImpl = makeFetch(catalog, { now });
  const summary = await collectOnce(db, catalog, { now, dataDir: dir, env: {}, fetchImpl, sources, force: true });
  return { db, dir, summary };
}

test("on-chain reads: weekly stablecoin supply with history, snapshots, totals, daily prices and fees", async () => {
  const { db, summary } = await run(["chainrpc", "cftc", "pokt"]);
  for (const s of summary.sources) assert.equal(s.failed.length, 0, `${s.source_id}: ${JSON.stringify(s.failed[0])}`);
  const eth = obs(db, "chainrpc:usdt_supply:eth");
  assert.ok(eth.length >= 55, `weekly history ${eth.length}`);
  assert.ok(eth.every((o) => new Date(`${o.t}T00:00:00Z`).getUTCDay() === 1), "weeks start on Monday");
  assert.ok(eth.every((o) => o.v > 1e11 && o.v < 2e11), "USDT in whole dollars (raw 6-decimal supply scaled)");
  assert.equal(obs(db, "chainrpc:usdt_supply:tron").length, 1, "Tron: this week only (no history through the public RPC)");
  assert.equal(obs(db, "chainrpc:usdc_supply:solana")[0].v, 8156262777, "getTokenSupply with decimals");
  const evm = obs(db, "chainrpc:stablecoins_evm_total");
  assert.equal(evm.length, eth.length);
  assert.equal(obs(db, "chainrpc:stablecoins_total").length, 1, "the 8-chain total starts with the first week every chain has");
  const ethUsd = obs(db, "chainrpc:eth_usd");
  assert.ok(ethUsd.length >= 100 && ethUsd.every((o) => o.v > 2000 && o.v < 3100), "ETH price from slot0, inverted");
  assert.ok(obs(db, "chainrpc:btc_usd").every((o) => o.v > 70000 && o.v < 100000), "BTC price from slot0");
  const fee = obs(db, "chainrpc:base_fee:eth");
  assert.ok(fee.length >= 85 && fee.every((o) => o.v > 0.1 && o.v < 1), "median base fee in gwei");
  assert.ok(obs(db, "chainrpc:block_fullness:eth").every((o) => o.v > 0.3 && o.v < 0.7));
  const am = obs(db, "cftc:btc:asset_mgr_net");
  assert.ok(am.length >= 50 && am.every((o) => o.v > 3000), "asset managers long minus short");
  assert.ok(obs(db, "pokt:supplier_stake").every((o) => o.v > 2e8 && o.v < 3e8), "upokt to POKT");
  assert.ok(obs(db, "pokt:validators").length >= 20);
});

test("a second pass reads only new days and weeks", async () => {
  const first = await run(["chainrpc"]);
  const calls = () => first.db.prepare("SELECT COUNT(*) n FROM fetch_logs WHERE source_id = 'chainrpc'").get().n;
  const before = calls();
  await run(["chainrpc"], new Date(NOW.getTime() + 86400000), first.dir, first.db);
  const added = calls() - before;
  assert.ok(added < 60, `second pass made ${added} calls`);
  assert.equal(obs(first.db, "chainrpc:eth_usd").slice(-1)[0].t, "2026-10-07");
});

test("tools: addresses and units", () => {
  const T = require("../packs/lib/cryptotools");
  assert.equal(T.keccak256(Buffer.from("")).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(T.addressCheck({ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }).valid, true);
  assert.equal(T.addressCheck({ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" }).valid, false, "one case flipped");
  assert.equal(T.addressCheck({ address: "pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw" }).network, "Pocket Network account");
  assert.equal(T.addressCheck({ address: "pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlq" }).valid, false);
  assert.equal(T.addressCheck({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }).valid, true);
  assert.equal(T.addressCheck({ address: "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297" }).valid, true);
  assert.equal(T.unitConvert({ amount: "1.5", from: "eth", to: "gwei" }).result, "1500000000");
  assert.equal(T.unitConvert({ amount: "1", from: "wei", to: "eth" }).result, "0.000000000000000001");
  assert.equal(T.unitConvert({ amount: "123456789", from: "raw", to: "token", decimals: 6 }).result, "123.456789");
  assert.ok(T.unitConvert({ amount: "1", from: "btc", to: "eth" }).error);
  assert.ok(T.unitConvert({ amount: "0.0000000001", from: "btc", to: "sat" }).error, "below one satoshi");
});
