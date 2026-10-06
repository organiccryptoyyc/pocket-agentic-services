// On-chain reads through Pocket Network's public RPC endpoints (https://<chain>.api.pocket.network,
// free and keyless; the data is public chain state, so no third-party data terms apply). One
// series kind per params.kind:
//   erc20_supply   token totalSupply() at the first block of each week (Monday 00:00 UTC); EVM
//                  chains are archive-capable, so past weeks are backfilled
//   snapshot_supply  the same for chains without history through the public endpoint (Tron
//                  totalSupply, Solana getTokenSupply): read at the first pass of each week
//   supply_total   the sum of member supply series, for weeks where every member has a value
//   univ3_price    a Uniswap v3 pool's price (slot0) at 00:00 UTC each day
//   base_fee       median base fee (gwei) of the 256 blocks before 00:00 UTC each day
//   block_fullness mean gas used / gas limit of the same blocks
// Values already read are kept between passes (kv), so a pass only reads new days and weeks.
"use strict";

const { SchemaError, ymd, weekStart } = require("./common");

const DAY = 86400000;
const rpcUrl = (chain) => `https://${chain}.api.pocket.network`;
const CITE = { eth: "https://etherscan.io", base: "https://basescan.org", "arb-one": "https://arbiscan.io", poly: "https://polygonscan.com", avax: "https://snowtrace.io", op: "https://optimistic.etherscan.io", bsc: "https://bscscan.com", tron: "https://tronscan.org", solana: "https://explorer.solana.com" };
const cite = (chain, addr) => (addr ? `${CITE[chain] || rpcUrl(chain)}/${chain === "solana" ? "address" : chain === "tron" ? "#/token20" : "address"}/${addr}` : CITE[chain] || rpcUrl(chain));

let nextId = 1;
// Public endpoints route each call to one of many nodes, and some nodes are not archive nodes or
// lack a method: an error answer is retried (a different node usually answers).
async function rpc(ctx, chain, method, params, { attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const r = await ctx.get(`chainrpc:${chain}:${method}`, rpcUrl(chain), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
    let body;
    try { body = JSON.parse(r.text); } catch { throw new SchemaError(`${chain} ${method}: answer is not JSON`); }
    if (!body.error) return { result: body.result, sha: r.sha256 };
    last = body.error;
  }
  throw new SchemaError(`${chain} ${method}: ${last && last.message ? last.message : "error"}`);
}

const hex = (n) => `0x${n.toString(16)}`;
const big = (h) => BigInt(h && h !== "0x" ? h : "0x0");
// A raw integer with `decimals` into a JS number (enough precision for USD totals).
const scaled = (raw, decimals) => Number(raw / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);

async function blockInfo(ctx, chain, tag) {
  const { result } = await rpc(ctx, chain, "eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]);
  if (!result) throw new SchemaError(`${chain}: no block ${tag}`);
  return { n: Number(big(result.number)), ts: Number(big(result.timestamp)) };
}

// A block within a minute (or two block intervals) of unix time `target`: interpolate between the
// nearest known blocks on each side (all known points are cached per chain for the pass), so most
// dates take two or three calls. Exactness to the block does not matter for daily or weekly reads.
async function blockAt(ctx, chain, target, cache) {
  const key = `${chain}:${target}`;
  if (cache.has(key)) return cache.get(key);
  const pts = cache.get(`${chain}:pts`) || [];
  cache.set(`${chain}:pts`, pts);
  const remember = (b) => { pts.push(b); pts.sort((a, c) => a.ts - c.ts); return b; };
  if (!pts.length) {
    const latest = remember(await blockInfo(ctx, chain, "latest"));
    remember(await blockInfo(ctx, chain, Math.max(1, latest.n - 200000)));
  }
  if (target >= pts[pts.length - 1].ts) {
    const latest = remember(await blockInfo(ctx, chain, "latest"));
    if (target >= latest.ts) return null; // not reached yet
  }
  for (let i = 0; i < 12; i++) {
    const hiIdx = pts.findIndex((p) => p.ts >= target);
    const lo = hiIdx > 0 ? pts[hiIdx - 1] : null;
    const hi = hiIdx >= 0 ? pts[hiIdx] : pts[pts.length - 1];
    const near = !lo ? hi : Math.abs(hi.ts - target) <= Math.abs(target - lo.ts) ? hi : lo;
    const rate = lo && hi.n !== lo.n ? (hi.ts - lo.ts) / (hi.n - lo.n) : 2;
    if (Math.abs(near.ts - target) <= Math.max(60, 2 * rate) || (lo && hi.n - lo.n <= 1)) {
      cache.set(key, near.n);
      return near.n;
    }
    let guess;
    if (lo) guess = Math.round(lo.n + (target - lo.ts) / rate);
    else guess = Math.round(hi.n - (hi.ts - target) / ((pts[1].ts - pts[0].ts) / (pts[1].n - pts[0].n) || 2));
    if (lo) guess = Math.min(hi.n - 1, Math.max(lo.n + 1, guess));
    remember(await blockInfo(ctx, chain, Math.max(1, guess)));
  }
  throw new SchemaError(`${chain}: could not find the block for ${new Date(target * 1000).toISOString()}`);
}

async function call(ctx, chain, to, data, block) {
  const { result, sha } = await rpc(ctx, chain, "eth_call", [{ to, data }, typeof block === "number" ? hex(block) : block]);
  if (typeof result !== "string" || !/^0x[0-9a-f]*$/i.test(result)) throw new SchemaError(`${chain} eth_call: bad result`);
  return { result, sha };
}

// Mondays (week starts) from `since` up to this week's Monday, or days (00:00 UTC) up to today.
function weekDates(since, now) {
  const out = [];
  let w = weekStart(since);
  const last = weekStart(ymd(now));
  while (w <= last) { out.push(w); w = ymd(new Date(Date.parse(`${w}T00:00:00Z`) + 7 * DAY)); }
  return out;
}
function dayDates(since, now) {
  const out = [];
  let d = since;
  const last = ymd(now);
  while (d <= last) { out.push(d); d = ymd(new Date(Date.parse(`${d}T00:00:00Z`) + DAY)); }
  return out;
}
const unix = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const backfillStart = (s, ctx, days) => {
  const a = ctx.since(s);
  const b = ymd(new Date(ctx.now.getTime() - days * DAY));
  return a > b ? a : b;
};

async function readValue(ctx, s, date, cache) {
  const p = s.params;
  if (p.kind === "erc20_supply") {
    const n = await blockAt(ctx, p.chain, unix(date), cache);
    if (n === null) return null;
    const { result, sha } = await call(ctx, p.chain, p.contract, "0x18160ddd", n);
    return { value: Math.round(scaled(big(result), p.decimals)), sha, block: n };
  }
  if (p.kind === "univ3_price") {
    const n = await blockAt(ctx, p.chain, unix(date), cache);
    if (n === null) return null;
    const { result, sha } = await call(ctx, p.chain, p.pool, "0x3850c7bd", n);
    const sqrt = big(result.slice(0, 66));
    if (sqrt === 0n) throw new SchemaError(`${p.chain} ${p.pool}: empty slot0`);
    // price of token0 in token1 = (sqrtPriceX96 / 2^96)^2, adjusted for decimals
    const ratio = Number((sqrt * sqrt * 10n ** 40n) >> 192n) / 1e40;
    const p01 = ratio * 10 ** (p.decimals0 - p.decimals1);
    const price = p.price_of === "token1" ? 1 / p01 : p01;
    return { value: Math.round(price * 100) / 100, sha, block: n };
  }
  if (p.kind === "base_fee" || p.kind === "block_fullness") {
    const n = await blockAt(ctx, p.chain, unix(date), cache);
    if (n === null) return null;
    const { result, sha } = await rpc(ctx, p.chain, "eth_feeHistory", [hex(256), hex(Math.max(1, n - 1)), []]);
    if (!result || !Array.isArray(result.baseFeePerGas) || !Array.isArray(result.gasUsedRatio)) throw new SchemaError(`${p.chain} eth_feeHistory: bad result`);
    if (p.kind === "base_fee") {
      const fees = result.baseFeePerGas.slice(0, -1).map((h) => Number(big(h)) / 1e9).sort((a, b) => a - b);
      return { value: Math.round(fees[Math.floor(fees.length / 2)] * 10000) / 10000, sha, block: n };
    }
    const r = result.gasUsedRatio.filter((x) => typeof x === "number");
    return { value: Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10000) / 10000, sha, block: n };
  }
  throw new SchemaError(`chainrpc: unknown kind '${p.kind}'`);
}

async function snapshotValue(ctx, p) {
  if (p.chain === "solana") {
    const { result, sha } = await rpc(ctx, "solana", "getTokenSupply", [p.mint], { attempts: 3 });
    const v = result && result.value;
    if (!v || v.amount === undefined) throw new SchemaError("solana getTokenSupply: no value");
    return { value: Math.round(scaled(BigInt(v.amount), Number(v.decimals))), sha };
  }
  // Tron's JSON-RPC answers eth_call at "latest" only, and not every node supports it: retry.
  const { result, sha } = await rpc(ctx, p.chain, "eth_call", [{ to: p.contract, data: "0x18160ddd" }, "latest"], { attempts: 8 });
  return { value: Math.round(scaled(big(result), p.decimals)), sha };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const cache = new Map();
  const values = new Map(); // series_id -> Map(date -> value)
  for (const s of series.filter((x) => x.params.kind !== "supply_total")) {
    try {
      const p = s.params;
      const store = ctx.kvGet(`v:${s.series_id}`) || {};
      const weekly = p.kind === "erc20_supply" || p.kind === "snapshot_supply";
      if (p.kind === "snapshot_supply") {
        const w = weekStart(ymd(ctx.now));
        if (!(w in store)) {
          const v = await snapshotValue(ctx, p);
          store[w] = { value: v.value, sha: v.sha };
        }
      } else {
        const dates = weekly ? weekDates(backfillStart(s, ctx, p.backfill_days || 420), ctx.now) : dayDates(backfillStart(s, ctx, p.backfill_days || 120), ctx.now);
        for (const d of dates) {
          if (d in store) continue;
          const v = await readValue(ctx, s, d, cache);
          if (v === null) continue;
          store[d] = { value: v.value, sha: v.sha, block: v.block };
          ctx.kvSet(`v:${s.series_id}`, store);
        }
      }
      ctx.kvSet(`v:${s.series_id}`, store);
      const since = ctx.since(s);
      const m = new Map();
      for (const [d, v] of Object.entries(store)) {
        if (d < since || !Number.isFinite(v.value)) continue;
        m.set(d, v.value);
        out.observations.push({ series_id: s.series_id, observation_time: d, period: weekly ? `week of ${d}` : d, value: v.value, source_url: cite(p.chain, p.contract || p.pool || p.mint), raw_sha256: v.sha });
      }
      values.set(s.series_id, m);
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  // Totals from member series read in this pass (members are always in the same source).
  for (const s of series.filter((x) => x.params.kind === "supply_total")) {
    try {
      const members = s.params.members.map((id) => values.get(id));
      if (members.some((m) => !m)) throw new SchemaError(`chainrpc ${s.series_id}: a member series failed`);
      const dates = [...members[0].keys()].filter((d) => members.every((m) => m.has(d))).sort();
      for (const d of dates) {
        out.observations.push({ series_id: s.series_id, observation_time: d, period: `week of ${d}`, value: members.reduce((a, m) => a + m.get(d), 0), source_url: rpcUrl("eth"), raw_sha256: null });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, blockAt, scaled, weekDates, dayDates };
