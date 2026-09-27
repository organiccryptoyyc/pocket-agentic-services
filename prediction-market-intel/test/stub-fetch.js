// Test-only network stub. Fixture shapes (including outcomes/outcomePrices
// arriving as JSON-encoded STRINGS, not native arrays, and the null
// price-change/volume fields a brand-new market legitimately has) are
// copied from real gamma-api.polymarket.com responses pulled live during
// this build — see README.md "Verification".
"use strict";

const realFetch = global.fetch;

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function market(overrides) {
  return {
    id: "1",
    slug: "example-market",
    question: "Example market?",
    active: true,
    closed: false,
    endDateIso: "2026-12-31T00:00:00Z",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.5", "0.5"]',
    volumeNum: 100000,
    volume24hr: 5000,
    volume1wk: 20000,
    volume1mo: 60000,
    liquidityNum: 30000,
    bestBid: 0.49,
    bestAsk: 0.5,
    spread: 0.01,
    oneDayPriceChange: 0.01,
    oneWeekPriceChange: 0.02,
    oneMonthPriceChange: 0.05,
    ...overrides,
  };
}

// A deliberately non-monotonic set under any single sort field, mirroring
// the real upstream `order`-param bug this backend works around: rank 3
// (by whatever field a caller sorts on) is NOT guaranteed >= rank 4.
const FIXTURE_MARKETS = [
  market({ id: "1", slug: "election-2026", question: "Will Party X win the election?", volume24hr: 3_767_841, volume1wk: 10_000_000, volume1mo: 39_761_553, liquidityNum: 3_024_959, spread: 0.01, bestBid: 0.6, bestAsk: 0.61 }),
  market({ id: "2", slug: "party-y-election", question: "Will Party Y win the election?", volume24hr: 1_773_056, volume1wk: 5_000_000, volume1mo: 16_028_823, liquidityNum: 474_718, spread: 0.02 }),
  market({ id: "3", slug: "clarity-act", question: "Clarity Act signed into law in 2026?", volume24hr: 578_632, volume1wk: 2_000_000, volume1mo: 22_481_744, liquidityNum: 390_164, spread: 0.001, bestBid: 0.004, bestAsk: 0.005 }),
  market({ id: "4", slug: "lsu-ole-miss", question: "LSU vs. Ole Miss", volume24hr: 1_260_556, volume1wk: 1_300_000, volume1mo: 1_361_285, liquidityNum: 226_829, spread: 0.01 }),
  market({ id: "5", slug: "brand-new-market", question: "Brand-new market with no history yet", volume24hr: 500, volume1wk: null, volume1mo: null, liquidityNum: 1000, bestBid: null, bestAsk: 0.5, spread: null, oneDayPriceChange: null, oneWeekPriceChange: null, oneMonthPriceChange: null }),
  market({ id: "6", slug: "thin-liquidity-mover", question: "Thin-liquidity market with a big swing", volume24hr: 900_000, volume1wk: 950_000, volume1mo: 1_000_000, liquidityNum: 8_000, spread: 0.09, bestBid: 0.2, bestAsk: 0.29, oneDayPriceChange: -0.4, oneWeekPriceChange: -0.35, oneMonthPriceChange: -0.3 }),
  market({ id: "7", slug: "three-outcome-market", question: "Who wins the tournament?", outcomes: '["Team A", "Team B", "Team C"]', outcomePrices: '["0.5", "0.3", "0.2"]', volume24hr: 300_000, volume1wk: 900_000, volume1mo: 2_000_000, liquidityNum: 150_000, oneDayPriceChange: 0.08 }),
];

global.fetch = async function stubFetch(url) {
  const u = new URL(url);
  if (process.env.SIMULATED_UPSTREAM_FAILURE === "1") throw new Error("stub: simulated network failure");

  if (u.hostname === "gamma-api.polymarket.com" && u.pathname === "/markets") {
    // Every seed order returns the same fixture set in this stub (order
    // doesn't matter for tests — the real backend never trusts it either).
    return jsonResponse(FIXTURE_MARKETS);
  }
  if (realFetch) return realFetch(url);
  throw new Error(`stub-fetch: no fixture for ${url}`);
};
