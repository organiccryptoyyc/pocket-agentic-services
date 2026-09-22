// Test-only network stub. Preloaded via `node -r ./test/stub-fetch.js server.js`
// so the backend's own code (pocket.js, server.js) runs completely unmodified —
// only global.fetch is intercepted, with canned bodies copied verbatim from
// live calls made against the real endpoints during development (see
// README.md "Verification"). This lets the backend's routing, validation,
// caching and error-shaping be exercised locally in a sandbox whose outbound
// network does not reach pocket.network, without faking anything about the
// backend's own logic.
"use strict";

const realFetch = global.fetch;

const FIXTURES = {
  "/pokt-network/poktroll/shared/params": {
    params: {
      num_blocks_per_session: "20", grace_period_end_offset_blocks: "10",
      claim_window_open_offset_blocks: "11", claim_window_close_offset_blocks: "10",
      proof_window_open_offset_blocks: "1", proof_window_close_offset_blocks: "10",
      supplier_unbonding_period_sessions: "1429", application_unbonding_period_sessions: "3",
      compute_units_to_tokens_multiplier: "122820", gateway_unbonding_period_sessions: "3",
      compute_unit_cost_granularity: "1000000", session_grid_anchor_height: "831001",
      session_number_at_anchor: "13851",
    },
  },
  "/pokt-network/poktroll/tokenomics/params": {
    params: {
      dao_reward_address: "pokt1dr5jtqaaz4wk8wevl33e7vkxsjlphljnjhyq2l",
      mint_allocation_percentages: { dao: 0.1, proposer: 0, supplier: 0.8, source_owner: 0.1, application: 0 },
      global_inflation_per_claim: 0.000001,
      mint_equals_burn_claim_distribution: { dao: 0.045, proposer: 0.14, supplier: 0.79, source_owner: 0.025, application: 0 },
      mint_ratio: 0.975, overservicing_bonus_multiplier: "2",
    },
  },
  "/status": {
    jsonrpc: "2.0", id: -1,
    result: { sync_info: { latest_block_height: "929052", latest_block_time: "2026-09-19T17:23:19.071105367Z", catching_up: false } },
  },
};

function lcdValidators() {
  return {
    pagination: { next_key: null, total: "22" },
    validators: [
      {
        operator_address: "poktvaloper1pwdns66s4fuas2s4tvfyvftsngek386wj05vcl",
        jailed: false, status: "BOND_STATUS_BONDED", tokens: "3156246582576",
        description: { moniker: "PNF-04" },
        commission: { commission_rates: { rate: "0.500000000000000000" } },
      },
    ],
  };
}

function graphqlResponse(query) {
  if (query.includes("_metadata")) {
    return {
      data: {
        validators: { totalCount: 22 }, suppliers: { totalCount: 4247 },
        applications: { totalCount: 141 }, gateways: { totalCount: 8 },
        services: { totalCount: 180 },
        _metadata: { targetHeight: 929052, lastProcessedHeight: 929052, indexerHealthy: true, lastProcessedTimestamp: "1789838666951" },
      },
    };
  }
  if (query.includes("supplierServiceConfigs") && query.includes("$sid")) {
    return { data: { supplierServiceConfigs: { totalCount: 4037, nodes: [
      { supplierId: "pokt1cr5suvepkkqp22qhz4g6pkt7rwdqspm9rhn0d9", activatedAtId: "912521",
        supplier: { stakeAmount: "100000000000", stakeStatus: "Staked", serviceConfigs: { totalCount: 10 } } },
    ] } } };
  }
  if (query.includes("suppliers(filter")) {
    return { data: { suppliers: { totalCount: 4247, nodes: [
      { operatorId: "pokt1cr5suvepkkqp22qhz4g6pkt7rwdqspm9rhn0d9", stakeAmount: "100000000000", stakeStatus: "Staked", serviceConfigs: { totalCount: 10 } },
    ] } } };
  }
  if (query.includes("blocks(filter")) {
    return { data: { blocks: { totalCount: 1414, aggregates: { sum: {
      totalTxs: "151747", totalRelays: "394254326", totalEstimatedRelays: "1262583149",
      totalComputedUnits: "1100149531143", totalEstimatedComputedUnits: "3816743393863",
    } } } } };
  }
  if (query.includes("applicationServices") && query.includes("$sid")) {
    return { data: { applicationServices: { totalCount: 8, nodes: [
      { applicationId: "pokt18q8l6dk67lk8w0mzxyz", application: { stakeAmount: "32646437128", stakeStatus: "Staked" } },
    ] } } };
  }
  if (query.includes("applications(filter")) {
    return { data: { applications: { totalCount: 141, nodes: [
      { accountId: "pokt185tgfw9lxyuznh9rz89556l4p8dshdkjd5283d", stakeAmount: "32646437128", stakeStatus: "Staked", applicationServices: { totalCount: 1 } },
    ] } } };
  }
  if (query.includes("s0: service(")) {
    return { data: {
      s0: { id: "eth", name: "Ethereum", computeUnitsPerRelay: "1599" }, sup0: { totalCount: 4037 }, app0: { totalCount: 8 },
      s1: { id: "pocket", name: "Pocket Network", computeUnitsPerRelay: "1060" }, sup1: { totalCount: 3006 }, app1: { totalCount: 2 },
    } };
  }
  if (query.includes("eventClaimSettleds(first:100")) {
    return { data: { supplier: {
      id: "pokt1cr5suvepkkqp22qhz4g6pkt7rwdqspm9rhn0d9", operatorId: "pokt1cr5suvepkkqp22qhz4g6pkt7rwdqspm9rhn0d9",
      stakeAmount: "100000000000", stakeStatus: "Staked", unstakingReason: null, unstakingEndHeight: null,
      serviceConfigs: { totalCount: 10 },
      eventClaimSettleds: { nodes: [
        { proofRequirement: "NOT_REQUIRED", proofValidationStatus: null, sessionEndHeight: "928940" },
        { proofRequirement: "THRESHOLD", proofValidationStatus: "VALIDATED", sessionEndHeight: "928600" },
      ] },
      eventSupplierSlasheds: { totalCount: 0 },
    } } };
  }
  if (query.includes("services(first:30)")) {
    return { data: { services: { nodes: [{ id: "eth", name: "Ethereum", computeUnitsPerRelay: "1599" }] } } };
  }
  return { data: {} };
}

global.fetch = async function stubFetch(url, init) {
  const u = new URL(url);
  if (u.hostname.includes("sauron-rpc")) {
    return jsonResponse(FIXTURES["/status"]);
  }
  if (u.hostname.includes("sauron-api")) {
    if (u.pathname.includes("/cosmos/staking/v1beta1/validators")) return jsonResponse(lcdValidators());
    const fx = FIXTURES[u.pathname];
    if (fx) return jsonResponse(fx);
    return jsonResponse({ code: 12, message: "Not Implemented" }, 501);
  }
  if (u.hostname.includes("data.") || u.hostname.includes("data.pocket")) {
    const body = JSON.parse(init.body);
    // SIMULATED_UPSTREAM_FAILURE lets a single test request exercise the
    // stale-cache / cold-failure path without touching real network code.
    if (process.env.SIMULATED_UPSTREAM_FAILURE === "1") {
      throw new Error("stub: simulated network failure");
    }
    return jsonResponse(graphqlResponse(body.query));
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`stub-fetch: no fixture for ${url}`);
};

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}
