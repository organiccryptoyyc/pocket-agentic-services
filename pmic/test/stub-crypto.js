// Test-only stub for the crypto sources: Pocket public RPC (JSON-RPC per chain, synthetic chains
// with fixed block times), and the CFTC Socrata dataset. Shapes as seen live on 2026-10-06.
"use strict";

const BLOCK_TIME = { eth: 12, base: 2, "arb-one": 0.25, poly: 2, avax: 2, op: 2, bsc: 3, tron: 3 };
const GENESIS = Date.parse("2020-01-01T00:00:00Z") / 1000;
const hex = (n) => `0x${BigInt(Math.round(n)).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
let tronCalls = 0;

function crypto(u, init, now, json) {
  const t = Math.floor(now.getTime() / 1000);
  const m = /^([a-z-]+)\.api\.pocket\.network$/.exec(u.host);
  if (m) {
    const chain = m[1];
    const req = JSON.parse(init.body);
    const ok = (result) => json({ jsonrpc: "2.0", id: req.id, result });
    const bt = BLOCK_TIME[chain] || 2;
    const latest = Math.floor((t - GENESIS) / bt);
    const tsOf = (n) => GENESIS + Math.floor(n * bt);
    const blockOf = (tag) => (tag === "latest" ? latest : Number(BigInt(tag)));
    if (chain === "solana") {
      if (req.method !== "getTokenSupply") return json({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
      return ok({ context: { slot: 1 }, value: { amount: req.params[0].startsWith("EP") ? "8156262777046396" : "3839903300000000", decimals: 6, uiAmount: 0 } });
    }
    if (req.method === "eth_getBlockByNumber") {
      const n = blockOf(req.params[0]);
      if (n > latest) return ok(null);
      return ok({ number: hex(n), timestamp: hex(tsOf(n)), baseFeePerGas: hex(1e8) });
    }
    if (req.method === "eth_feeHistory") {
      const newest = blockOf(req.params[1]);
      const k = Math.floor(tsOf(newest) / 86400);
      return ok({ oldestBlock: hex(newest - 255), baseFeePerGas: Array.from({ length: 257 }, (_, i) => hex((0.5 + 0.3 * Math.sin(k / 5) + (i % 7) * 0.01) * 1e9)), gasUsedRatio: Array.from({ length: 256 }, (_, i) => 0.5 + 0.1 * Math.sin(i + k)) });
    }
    if (req.method === "eth_call") {
      const tag = req.params[1];
      if (chain === "tron") {
        if (tag !== "latest") return json({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "QUANTITY not supported, just support TAG as latest" } });
        if (tronCalls++ % 3 !== 2) return json({ jsonrpc: "2.0", id: req.id, error: { code: -32600, message: "this node does not support constant" } });
      }
      const n = blockOf(tag);
      const days = (tsOf(n) - GENESIS) / 86400;
      const { to, data } = req.params[0];
      if (data === "0x18160ddd") {
        const base = { eth: 50e9, base: 4e9, "arb-one": 3e9, poly: 1e9, avax: 1.5e9, op: 0.5e9, tron: 9e10 }[chain] || 1e9;
        const v = base * (1 + days / 4000 + 0.02 * Math.sin(days / 30)) * (to.toLowerCase().startsWith("0xdac") ? 1.7 : 1);
        return ok(`0x${word(BigInt(Math.round(v)) * 1000000n)}`);
      }
      if (data === "0x3850c7bd") {
        // sqrtPriceX96 for ETH ~ 2600 (USDC/WETH pool) or BTC ~ 85000 (WBTC/USDC pool), drifting
        const isEth = to.toLowerCase().startsWith("0x88e6");
        const usd = (isEth ? 2600 : 85000) * (1 + 0.15 * Math.sin(days / 20));
        const p01 = isEth ? (1 / usd) * 1e12 : usd * 1e-2; // raw token1 per raw token0
        const sqrt = BigInt(Math.round(Math.sqrt(p01) * 2 ** 48)) * 2n ** 48n;
        return ok(`0x${word(sqrt)}${word(1)}${word(1)}${word(1)}${word(1)}${word(1)}${word(1)}`);
      }
      return json({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "execution reverted" } });
    }
    return json({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
  }
  if (u.host === "publicreporting.cftc.gov") {
    const where = u.searchParams.get("$where") || "";
    const code = (/'(\d+)'/.exec(where) || [])[1];
    const rows = [];
    for (let k = 120; k >= 1; k--) {
      const d = new Date(now.getTime() - (k * 7 + 5) * 86400000).toISOString().slice(0, 10);
      const s = code === "133741" ? 1 : 0.6;
      rows.push({ report_date_as_yyyy_mm_dd: `${d}T00:00:00.000`, cftc_contract_market_code: code, open_interest_all: String(Math.round(20000 * s * (1 + 0.2 * Math.sin(k / 6)))), asset_mgr_positions_long: String(Math.round(5000 * s + 400 * Math.sin(k / 4))), asset_mgr_positions_short: String(Math.round(1500 * s)), lev_money_positions_long: String(Math.round(5000 * s)), lev_money_positions_short: String(Math.round(11000 * s + 900 * Math.cos(k / 5))) });
    }
    return json(rows);
  }
  return null;
}

module.exports = { crypto };
