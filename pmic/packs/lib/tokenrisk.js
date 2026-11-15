// POST /v1/token-risk (Build 2, 2026-11-15) on pmic-crypto-signals: who controls an established EVM token and what
// selling $10k / $100k / $1M of it costs on chain, from the hub's replica of the Pi's snapshot (refreshed every 12 h).
// Request: {tokens: [{chain, address}]} (1-10, the same shape as pump-check). Chains: ethereum, arbitrum, base,
// optimism, polygon (aliases eth, arb, op, matic). A Solana mint or another chain is out_of_scope with a pointer to
// pump-check, which covers memecoins on Solana, Base and Robinhood Chain. A token we don't track yet is not_covered and
// joins the Pi's queue for its next run. No live chain work happens on this route.
"use strict";

const { ClientError } = require("./http");

const ALIASES = { ethereum: "ethereum", eth: "ethereum", mainnet: "ethereum", arbitrum: "arbitrum", arb: "arbitrum", "arbitrum-one": "arbitrum",
  base: "base", optimism: "optimism", op: "optimism", polygon: "polygon", matic: "polygon", pol: "polygon" };
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SEE = { service: "pump-check", why: "memecoins and new launches on Solana, Base and Robinhood Chain" };

function parse(body) {
  const tokens = body && body.tokens;
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 10) throw new ClientError(400, "invalid_input", "field 'tokens' must be a list of 1-10 {chain, address}");
  return tokens.map((t, i) => {
    if (!t || typeof t !== "object" || typeof t.chain !== "string" || typeof t.address !== "string" || !t.address.trim() || t.address.length > 64) {
      throw new ClientError(400, "invalid_input", `tokens[${i}] must be {chain, address}`);
    }
    const chain = ALIASES[t.chain.trim().toLowerCase()];
    const address = t.address.trim();
    if (!chain || !EVM.test(address)) return { input: { chain: t.chain, address }, scope: "out_of_scope" };
    return { input: { chain: t.chain, address }, scope: "in", chain, address: address.toLowerCase() };
  });
}

async function answer(body, askHub) {
  const items = parse(body);
  const inScope = items.filter((x) => x.scope === "in");
  const hub = inScope.length ? await askHub({ tokens: inScope.map((x) => ({ chain: x.chain, address: x.address })) }) : { replica: null, results: [] };
  const byAsset = new Map((hub.results || []).map((r) => [r.asset, r]));
  const results = items.map((x) => {
    if (x.scope !== "in") {
      return { input: x.input, status: "out_of_scope", note: "this route covers established tokens on Ethereum, Arbitrum, Base, Optimism and Polygon", see: SEE };
    }
    const r = byAsset.get(`${x.chain}:${x.address}`) || { status: "not_covered" };
    if (r.status === "not_covered") {
      return { input: x.input, asset: `${x.chain}:${x.address}`, status: "not_covered",
        note: "not in the watchlist yet: it is queued, and the next 12-hourly run checks it (up to 25 new tokens per run). For a brand-new or meme token, see pump-check.", see: SEE };
    }
    return { input: x.input, ...r };
  });
  return {
    replica: hub.replica,
    count: results.length,
    results,
    verdict_scale: "low | elevated | high | unknown. high: a definitive failure (an upgrade one key can make with no delay, a stablecoin 3%+ off its peg); elevated: any warning or a heuristic failure such as thin on-chain liquidity; unknown: control and exit could not be read. confidence says whether any control or exit check was unknown (gaps lists them).",
    method: "On-chain reads at a pinned block on the Pi through Pocket Network's public RPC: EIP-1967 and ZeppelinOS proxy slots, owner()/admin() and the proxy admin followed one level (EOA, Safe or multisig threshold, timelock delay, governor), privileged functions in the Sourcify-verified ABI, supply change, Ethereum holder concentration (Blockscout), and Uniswap v3 QuoterV2 / Curve sale quotes at $10k, $100k and $1M. Prices from the Pi's price bank or the on-chain quote; no market-data API is called per request.",
    disclaimer: "Facts at the stated block. Not financial advice, and no trading or execution.",
  };
}

module.exports = { answer, parse, ALIASES };
