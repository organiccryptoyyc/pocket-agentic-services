// Verified layer 1.5: independent cross-checks of the crypto series, written to the confirmations
// table (migration 006). Nothing here changes a series, a score or what is pushed to the hub.
//
//   price    the Uniswap v3 ETH and BTC prices (chainrpc:eth_usd, chainrpc:btc_usd) against the
//            Chainlink ETH/USD and BTC/USD feeds read at the same block, through the same free Pocket
//            RPC. A DEX pool and an oracle are different methods. Tolerance PRICE_TOLERANCE_PCT. Only
//            the last PRICE_DAYS days are checked, each date once.
//   supply   USDC/USDT totalSupply() on each EVM chain with a second public RPC (publicnode), read at
//            the same recent block from both: two independent nodes must return the same number.
//            One token per chain per day.
//
// A failed second read is an "unavailable" row; a failure of the whole step is returned to the
// caller and never stops the collect pass.
"use strict";

const crypto = require("crypto");
const { fetchText } = require("./net");
const { kvGet, kvSet, tx } = require("./db");
const { canonicalJson } = require("./canonical");

const DAY = 86400000;
const PRICE_TOLERANCE_PCT = 1.0;
const PRICE_DAYS = 3;
const BLOCK_LAG = 5;
const CHAINLINK = { // Ethereum mainnet aggregator proxies, 8 decimals
  "chainrpc:eth_usd": { feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", pair: "ETH/USD" },
  "chainrpc:btc_usd": { feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", pair: "BTC/USD" },
};
const FALLBACK_RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  "arb-one": "https://arbitrum-one-rpc.publicnode.com",
  poly: "https://polygon-bor-rpc.publicnode.com",
};
const AGREEMENTS = new Set(["agree", "disagree", "partial", "unavailable"]);
const COLUMNS = ["run_id", "field", "entity_id", "our_value", "upstream_service", "upstream_supplier", "upstream_value_hash",
  "agreement", "delta_pct", "tolerance_pct", "observed_at", "app_address", "cu_spent", "session_height"];

const primaryRpc = (chain) => `https://${chain}.api.pocket.network`;
const hostOf = (url) => new URL(url).host;
const hex = (n) => `0x${n.toString(16)}`;
const ymd = (d) => d.toISOString().slice(0, 10);
const valueHash = (v) => crypto.createHash("sha256").update(canonicalJson(v), "utf8").digest("hex");

let nextId = 1;
async function rpc(fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${hostOf(url)} ${method}: HTTP ${r.status}`);
  let body;
  try { body = JSON.parse(r.text); } catch { throw new Error(`${hostOf(url)} ${method}: answer is not JSON`); }
  if (body.error || body.result === undefined || body.result === null) throw new Error(`${hostOf(url)} ${method}: ${(body.error && body.error.message) || "no result"}`);
  return body.result;
}

function addConfirmations(db, rows) {
  const stmt = db.prepare(`INSERT INTO confirmations (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`);
  for (const r of rows) {
    if (!AGREEMENTS.has(r.agreement)) throw new Error(`bad agreement ${r.agreement}`);
    const rec = { ...r };
    if ("upstream_value" in rec) {
      rec.upstream_value_hash = rec.upstream_value === null ? null : valueHash(rec.upstream_value);
      delete rec.upstream_value;
    }
    rec.our_value = rec.our_value === undefined || rec.our_value === null ? null : JSON.stringify(rec.our_value);
    rec.cu_spent = rec.cu_spent || 0;
    stmt.run(...COLUMNS.map((c) => (rec[c] === undefined ? null : rec[c])));
  }
}

function recordUpstream(db, service, { ok = true, disagreed = false, latencyMs = null, seenAt }) {
  db.prepare("INSERT OR IGNORE INTO upstream_quality (service_id, supplier) VALUES (?, '')").run(service);
  db.prepare(`UPDATE upstream_quality SET calls = calls + 1, errors = errors + ?, disagreements = disagreements + ?, last_seen = ?,
      median_latency_ms = CASE WHEN ? IS NULL THEN median_latency_ms WHEN median_latency_ms IS NULL THEN ? ELSE (median_latency_ms + ?) / 2.0 END
      WHERE service_id = ? AND supplier = ''`).run(ok ? 0 : 1, disagreed ? 1 : 0, seenAt, latencyMs, latencyMs, latencyMs, service);
}

// Chainlink latestRoundData() at a block: answer (8 decimals) and updatedAt.
async function chainlinkAt(fetchImpl, feed, block) {
  const out = await rpc(fetchImpl, primaryRpc("eth"), "eth_call", [{ to: feed, data: "0xfeaf968c" }, hex(block)]);
  if (typeof out !== "string" || out.length < 2 + 64 * 4) throw new Error("chainlink: short answer");
  const word = (i) => BigInt(`0x${out.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  let answer = word(1);
  if (answer >= 1n << 255n) answer -= 1n << 256n;
  return { usd: Number(answer) / 1e8, updatedAt: Number(word(3)) };
}

async function checkPrices(db, catalog, ctx) {
  const since = ymd(new Date(ctx.now.getTime() - PRICE_DAYS * DAY));
  for (const s of catalog.series.filter((x) => CHAINLINK[x.series_id])) {
    const store = kvGet(db, `${s.source_id}:v:${s.series_id}`) || {}; // the adapter's per-date values, with block
    const done = kvGet(db, `verified:${s.series_id}`) || {};
    for (const date of Object.keys(store).filter((d) => d >= since && !(d in done)).sort()) {
      const ours = store[date];
      if (!Number.isFinite(ours.value) || !Number.isInteger(ours.block)) continue;
      const { feed, pair } = CHAINLINK[s.series_id];
      const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id,
        our_value: { date, usd: ours.value, block: ours.block }, upstream_service: "chainlink",
        tolerance_pct: PRICE_TOLERANCE_PCT, observed_at: `${date}T00:00:00Z` };
      const t0 = Date.now();
      try {
        const cl = await chainlinkAt(ctx.fetchImpl, feed, ours.block);
        const delta = Math.round((Math.abs(ours.value - cl.usd) / cl.usd) * 100 * 10000) / 10000;
        const agreement = delta <= PRICE_TOLERANCE_PCT ? "agree" : "disagree";
        ctx.rows.push({ ...row, upstream_value: { pair, usd: cl.usd, updated_at: cl.updatedAt }, agreement, delta_pct: delta });
        ctx.calls.push(["chainlink", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
      } catch (e) {
        ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
        ctx.calls.push(["chainlink", { ok: false }]);
        ctx.notes.push(`${s.series_id} ${date}: ${String(e.message).slice(0, 120)}`);
      }
      done[date] = ctx.nowIso;
      kvSet(db, `verified:${s.series_id}`, done);
    }
  }
}

async function checkSupplyNodes(db, catalog, ctx) {
  const today = ymd(ctx.now);
  const doneKey = "verified:supply_nodes";
  const done = kvGet(db, doneKey) || {};
  const seen = new Set();
  for (const s of catalog.series.filter((x) => x.params && x.params.kind === "erc20_supply")) {
    const chain = s.params.chain;
    const fallback = FALLBACK_RPC[chain];
    if (!fallback || seen.has(chain) || done[chain] === today) continue;
    seen.add(chain);
    const service = `rpc:${hostOf(fallback)}`;
    const call = (url, block) => rpc(ctx.fetchImpl, url, "eth_call", [{ to: s.params.contract, data: "0x18160ddd" }, hex(block)]);
    try {
      const block = Number(BigInt(await rpc(ctx.fetchImpl, primaryRpc(chain), "eth_blockNumber", []))) - BLOCK_LAG;
      const ours = BigInt(await call(primaryRpc(chain), block));
      const row = { run_id: ctx.runId, field: `rpc.total_supply:${chain}:${s.params.contract.toLowerCase()}`, entity_id: s.entity_id,
        our_value: { raw: ours.toString(), block, series_id: s.series_id }, upstream_service: service, tolerance_pct: 0,
        observed_at: ctx.nowIso };
      const t0 = Date.now();
      try {
        const theirs = BigInt(await call(fallback, block));
        const agreement = theirs === ours ? "agree" : "disagree";
        ctx.rows.push({ ...row, upstream_value: theirs.toString(), agreement, delta_pct: theirs === ours ? 0 : null });
        ctx.calls.push([service, { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
      } catch (e) {
        ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
        ctx.calls.push([service, { ok: false }]);
        ctx.notes.push(`${service}: ${String(e.message).slice(0, 120)}`);
      }
      done[chain] = today;
      kvSet(db, doneKey, done);
    } catch (e) { // the primary itself failed: nothing to compare, retry next pass
      ctx.notes.push(`${chain} primary: ${String(e.message).slice(0, 120)}`);
    }
  }
}

async function verifyCrypto(db, catalog, { now = new Date(), fetchImpl = null } = {}) {
  const ctx = { now, nowIso: now.toISOString().replace(/\.\d{3}Z$/, "Z"), runId: `pmic/${now.toISOString()}`,
    fetchImpl: fetchImpl || fetchText, rows: [], calls: [], notes: [] };
  await checkPrices(db, catalog, ctx);
  await checkSupplyNodes(db, catalog, ctx);
  if (ctx.rows.length || ctx.calls.length) {
    tx(db, () => {
      addConfirmations(db, ctx.rows);
      for (const [service, o] of ctx.calls) recordUpstream(db, service, { ...o, seenAt: ctx.nowIso });
    });
  }
  const by = {};
  for (const r of ctx.rows) by[r.agreement] = (by[r.agreement] || 0) + 1;
  return { rows: ctx.rows.length, by_agreement: by, notes: ctx.notes.slice(0, 5) };
}

module.exports = { verifyCrypto, CHAINLINK, FALLBACK_RPC, PRICE_TOLERANCE_PCT };
