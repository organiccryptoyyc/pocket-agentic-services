// Real, live data sources for wallet/DeFi checks. No fabricated data: every
// signal comes from a live call to DefiLlama's free public API or a public
// Blockscout explorer instance, both interactively confirmed against their
// real endpoints during this build (see README.md "Verification").
"use strict";

const { fetchJSON, withRetry, UpstreamError, cached } = require("./net");

const BLOCKSCOUT_HOSTS = {
  eth: "eth.blockscout.com",
  base: "base.blockscout.com",
  arbitrum: "arbitrum.blockscout.com",
  polygon: "polygon.blockscout.com",
};
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function requireEvmChain(chain) {
  const host = BLOCKSCOUT_HOSTS[chain];
  if (!host) {
    const e = new UpstreamError(`unsupported chain '${chain}'; supported: ${Object.keys(BLOCKSCOUT_HOSTS).join(", ")}`);
    e.isClientError = true;
    throw e;
  }
  return host;
}

function requireEvmAddress(address) {
  if (!EVM_ADDRESS_RE.test(address)) {
    const e = new UpstreamError(`'${address}' is not a well-formed EVM address`);
    e.isClientError = true;
    throw e;
  }
}

async function blockscoutAddress(chain, address) {
  const host = requireEvmChain(chain);
  requireEvmAddress(address);
  const res = await withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}`));
  if (!res.ok) {
    if (res.status === 404) return { found: false };
    throw new UpstreamError(`Blockscout (${host}) address lookup failed: HTTP ${res.status}`);
  }
  return { found: true, ...res.body };
}

async function blockscoutCounters(chain, address) {
  const host = requireEvmChain(chain);
  const res = await withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}/counters`));
  return res.ok ? res.body : {};
}

async function blockscoutTokenBalances(chain, address) {
  const host = requireEvmChain(chain);
  const res = await withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}/token-balances`));
  return res.ok && Array.isArray(res.body) ? res.body : [];
}

async function blockscoutNftCollections(chain, address) {
  const host = requireEvmChain(chain);
  const res = await withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}/nft/collections`));
  return res.ok ? (res.body.items || []) : [];
}

// --- DefiLlama ---------------------------------------------------------------

async function llamaProtocol(slug) {
  const res = await withRetry(() => fetchJSON(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`));
  if (!res.ok) {
    if (res.status === 404) return { found: false };
    throw new UpstreamError(`DefiLlama protocol lookup failed: HTTP ${res.status}`);
  }
  return { found: true, ...res.body };
}

async function llamaStablecoins() {
  // Cached network-wide: this is a ~1-2MB response covering all 400+ tracked
  // stablecoins; fetch once per TTL window and filter per request rather
  // than re-downloading it for every /v1/depeg-check call.
  const { value } = await cached("llama:stablecoins", 900_000, async () => {
    const res = await withRetry(() => fetchJSON("https://stablecoins.llama.fi/stablecoins?includePrices=true"));
    if (!res.ok) throw new UpstreamError(`DefiLlama stablecoins lookup failed: HTTP ${res.status}`);
    return res.body.peggedAssets || [];
  });
  return value;
}

async function llamaPools() {
  // ~11MB, ~17k pools. Cached: APY data doesn't need per-request freshness.
  const { value } = await cached("llama:pools", 900_000, async () => {
    const res = await withRetry(() => fetchJSON("https://yields.llama.fi/pools", undefined, 15_000));
    if (!res.ok) throw new UpstreamError(`DefiLlama pools lookup failed: HTTP ${res.status}`);
    return res.body.data || [];
  });
  return value;
}

module.exports = {
  BLOCKSCOUT_HOSTS, EVM_ADDRESS_RE,
  requireEvmChain, requireEvmAddress,
  blockscoutAddress, blockscoutCounters, blockscoutTokenBalances, blockscoutNftCollections,
  llamaProtocol, llamaStablecoins, llamaPools,
};
