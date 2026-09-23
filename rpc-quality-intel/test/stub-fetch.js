// Test-only network stub (see pokt-network-intel/test/stub-fetch.js for the
// full rationale). Canned bodies are copied verbatim from live calls made
// against https://data.pocket.network/graphql during development.
"use strict";

const realFetch = global.fetch;

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function graphqlResponse(query) {
  if (query.includes("service(id:$id)") && query.includes("computeUnitsPerRelay") && !query.includes("activeSuppliers")) {
    return { data: { service: { id: "eth", name: "Ethereum", computeUnitsPerRelay: "1599" } } };
  }
  if (query.includes("activeSuppliers:")) {
    return { data: {
      activeSuppliers: { totalCount: 4037 },
      activeApplications: { totalCount: 8 },
      difficulty: { nodes: [{ newNumRelaysEma: "347012", newTargetHashHexEncoded: "49c5cd5e4bd5180476369c06b75d0a04b12313d23cc258c1e2e8f351e8874b0c", blockId: "929053" }] },
      recentHour: { totalCount: 42, aggregates: { sum: { numRelays: "12345", numEstimatedRelays: "43210" }, distinctCount: { supplierId: "88" } } },
    } };
  }
  if (query.includes("settlements: eventClaimSettleds")) {
    return { data: {
      settlements: { totalCount: 4185, aggregates: { sum: { numRelays: "24627226", numEstimatedRelays: "85679742", numClaimedComputedUnits: "39378934374" }, average: { numRelays: "5884.64" }, distinctCount: { supplierId: "2504" } } },
      required: { totalCount: 7281 },
      validated: { totalCount: 7281 },
      invalid: { totalCount: 0 },
      slashes: { totalCount: 0 },
    } };
  }
  if (query.includes("recent: eventClaimSettleds")) {
    return { data: {
      recent: { aggregates: { sum: { numRelays: "1000000" }, distinctCount: { supplierId: "80" } } },
      baseline: { aggregates: { sum: { numRelays: "6000000" }, distinctCount: { supplierId: "500" } } },
      recentSlashes: { totalCount: 0 },
      baselineSlashes: { totalCount: 1 },
      activeSuppliersNow: { totalCount: 90 },
    } };
  }
  if (query.includes("d0:") && query.includes("eventClaimSettleds")) {
    const out = { data: {} };
    const n = (query.match(/d\d+:/g) || []).length;
    for (let i = 0; i < n; i++) out.data[`d${i}`] = { aggregates: { sum: { numRelays: String(24_000_000 + i * 300_000) } } };
    return out;
  }
  return { data: {} };
}

global.fetch = async function stubFetch(url, init) {
  const u = new URL(url);
  if (u.hostname.includes("data.")) {
    const body = JSON.parse(init.body);
    if (process.env.SIMULATED_UPSTREAM_FAILURE === "1") throw new Error("stub: simulated network failure");
    return jsonResponse(graphqlResponse(body.query));
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`stub-fetch: no fixture for ${url}`);
};
