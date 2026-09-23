// Test-only network stub. Canned bodies are copied verbatim (or lightly
// trimmed) from live calls made against api.llama.fi, stablecoins.llama.fi,
// yields.llama.fi, and *.blockscout.com during development.
"use strict";

const realFetch = global.fetch;

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86400;
function tvlSeries() {
  const arr = [];
  for (let i = 40; i >= 0; i--) arr.push({ date: NOW_S - i * DAY, totalLiquidityUSD: 18_000_000_000 + i * 10_000_000 });
  return arr;
}

global.fetch = async function stubFetch(url) {
  const u = new URL(url);
  if (process.env.SIMULATED_UPSTREAM_FAILURE === "1") throw new Error("stub: simulated network failure");

  if (u.hostname === "api.llama.fi" && u.pathname.startsWith("/protocol/")) {
    const slug = u.pathname.split("/").pop();
    if (slug === "doesnotexist") return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({
      name: "Aave", tvl: tvlSeries(), mcap: 2192571631.49,
      currentChainTvls: { Ethereum: 16013445433, "Ethereum-borrowed": 10592937221, Polygon: 158754237 },
      hacks: [{ date: 1773273600, name: "Aave V3", amount: 862000, returnedFunds: 862000 }],
    });
  }
  if (u.hostname === "stablecoins.llama.fi") {
    return jsonResponse({
      peggedAssets: [
        { symbol: "USDT", name: "Tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 0.9996303299322612, circulating: { peggedUSD: 183286202490 }, circulatingPrevWeek: { peggedUSD: 183418674863 } },
        { symbol: "USDC", name: "USD Coin", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1.0001, circulating: { peggedUSD: 40000000000 }, circulatingPrevWeek: { peggedUSD: 39500000000 } },
      ],
    });
  }
  if (u.hostname === "yields.llama.fi" && u.pathname === "/pools") {
    return jsonResponse({
      data: [
        { chain: "Ethereum", project: "lido", symbol: "STETH", tvlUsd: 25783571029, apy: 2.25, apyBase: 2.25, apyReward: null, stablecoin: false, ilRisk: "no", exposure: "single", pool: "747c1d2a", outlier: false },
        { chain: "Ethereum", project: "aave-v3", symbol: "USDC", tvlUsd: 900000000, apy: 5.5, apyBase: 5.5, apyReward: 0, stablecoin: true, ilRisk: "no", exposure: "single", pool: "abcd1234", outlier: false },
        { chain: "Base", project: "aerodrome", symbol: "USDC-WETH", tvlUsd: 5000000, apy: 45.2, apyBase: 10, apyReward: 35.2, stablecoin: false, ilRisk: "yes", exposure: "multi", pool: "efgh5678", outlier: false },
      ],
    });
  }
  if (u.hostname.endsWith(".blockscout.com")) {
    if (u.pathname.includes("0xffffffffffffffffffffffffffffffffffffff") && !u.pathname.endsWith("/counters")) return jsonResponse({ message: "Not found" }, 404);
    if (u.pathname.endsWith("/counters")) return jsonResponse({ transactions_count: "78353", token_transfers_count: "403365" });
    if (u.pathname.endsWith("/token-balances")) {
      return jsonResponse([
        { token: { symbol: "WHITE", name: "WhiteRock", decimals: "18", exchange_rate: "0.00003786", reputation: "scam", type: "ERC-20" }, value: "10000000000000000000000000000" },
        { token: { symbol: "USDC", name: "USD Coin", decimals: "6", exchange_rate: "1.0", reputation: "ok", type: "ERC-20" }, value: "5000000000" },
      ]);
    }
    if (u.pathname.endsWith("/nft/collections")) {
      return jsonResponse({ items: [
        { amount: "1", token: { name: "Wei Name Service", symbol: "WEI", address_hash: "0xabc", type: "ERC-721", holders_count: "774", reputation: "ok" }, token_instances: [{}] },
      ] });
    }
    return jsonResponse({ is_contract: true, is_verified: true, is_scam: false, reputation: "ok", ens_domain_name: "vitalik.eth", coin_balance: "6712597953701629485" });
  }
  if (realFetch) return realFetch(url);
  throw new Error(`stub-fetch: no fixture for ${url}`);
};
