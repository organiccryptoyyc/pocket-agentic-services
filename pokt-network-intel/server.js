// POKT Network Intelligence — a Pocket Network service.
//
// Eight read-only endpoints over Pocket Network's own Shannon-protocol chain
// state (validators, suppliers, applications, services, tokenomics params,
// throughput, and a per-supplier trust signal), each backed by a live query
// against Pocket's public GraphQL indexer and/or Cosmos LCD — never a
// hardcoded value. Every query below was interactively verified against the
// real endpoints (https://data.pocket.network/graphql and
// https://sauron-api.infra.pocket.network) before being wired in here; see
// README.md "Verification" for how and when.
//
// No dependencies beyond Node's http/fetch. Mount at "/" behind a RelayMiner
// per the card's serving.backend_hint.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const pocket = require("./lib/pocket");

const SERVICE = "pokt-network-intel";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

// --- small shared input helpers -----------------------------------------

function clampInt(value, { min, max, def }) {
  if (value === undefined || value === null || value === "") return def;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ClientError(422, "invalid_input", `expected an integer, got ${JSON.stringify(value)}`);
  }
  if (n < min || n > max) {
    throw new ClientError(422, "invalid_input", `must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ClientError(422, "invalid_input", `field '${field}' is required and must be a non-empty string`);
  }
  return value.trim();
}

function withMeta(payload, cacheInfo) {
  return {
    service: SERVICE,
    network: pocket.NETWORK,
    fetched_at: new Date().toISOString(),
    cache: { stale: !!cacheInfo.stale, age_ms: cacheInfo.ageMs },
    ...payload,
  };
}

// --- /v1/pulse: network-wide snapshot ------------------------------------

async function handlePulse() {
  const { value, stale, ageMs } = await pocket.cached("pulse", 15_000, async () => {
    const [status, counts] = await Promise.all([
      pocket.rpcGet("/status"),
      pocket.graphql(`query {
        validators(filter:{stakeStatus:{equalTo:Staked}}) { totalCount }
        suppliers(filter:{stakeStatus:{equalTo:Staked}}) { totalCount }
        applications(filter:{stakeStatus:{equalTo:Staked}}) { totalCount }
        gateways(filter:{stakeStatus:{equalTo:Staked}}) { totalCount }
        services(filter:{id:{isNull:false}}) { totalCount }
        _metadata { targetHeight lastProcessedHeight indexerHealthy lastProcessedTimestamp }
      }`),
    ]);
    const sync = status.result?.sync_info || {};
    const meta = counts._metadata || {};
    return {
      chain_tip: {
        height: Number(sync.latest_block_height),
        time: sync.latest_block_time,
        catching_up: !!sync.catching_up,
      },
      indexer: {
        target_height: meta.targetHeight,
        last_processed_height: meta.lastProcessedHeight,
        lag_blocks: meta.targetHeight != null && meta.lastProcessedHeight != null
          ? meta.targetHeight - meta.lastProcessedHeight : null,
        healthy: !!meta.indexerHealthy,
      },
      staked: {
        validators: counts.validators.totalCount,
        suppliers: counts.suppliers.totalCount,
        applications: counts.applications.totalCount,
        gateways: counts.gateways.totalCount,
      },
      services_registered: counts.services.totalCount,
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/tokenomics: governance params, fetched live ---------------------

async function handleTokenomics() {
  const { value, stale, ageMs } = await pocket.cached("tokenomics", 3_600_000, async () => {
    const [shared, tokenomics] = await Promise.all([
      pocket.moduleParams("shared"),
      pocket.moduleParams("tokenomics"),
    ]);
    return {
      compute_units_to_tokens_multiplier: shared.compute_units_to_tokens_multiplier,
      compute_unit_cost_granularity: shared.compute_unit_cost_granularity,
      mint_ratio: tokenomics.mint_ratio,
      global_inflation_per_claim: tokenomics.global_inflation_per_claim,
      mint_equals_burn_claim_distribution: tokenomics.mint_equals_burn_claim_distribution,
      mint_allocation_percentages: tokenomics.mint_allocation_percentages,
      dao_reward_address: tokenomics.dao_reward_address,
      overservicing_bonus_multiplier: tokenomics.overservicing_bonus_multiplier,
      notes: "mint_equals_burn_claim_distribution is the PIP-41 burn-equals-mint settlement split. " +
        "mint_allocation_percentages only feeds GlobalMintTLM and is legacy/conditional on " +
        "global_inflation_per_claim; both are reported live rather than assumed.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/validators: LCD staking validator set, live ----------------------

const BOND_STATUS = {
  bonded: "BOND_STATUS_BONDED",
  unbonding: "BOND_STATUS_UNBONDING",
  unbonded: "BOND_STATUS_UNBONDED",
};

async function handleValidators(body) {
  const status = (body?.status || "bonded").toLowerCase();
  if (!BOND_STATUS[status]) {
    throw new ClientError(422, "invalid_input", `status must be one of ${Object.keys(BOND_STATUS).join(", ")}`);
  }
  const limit = clampInt(body?.limit, { min: 1, max: 100, def: 25 });
  const offset = clampInt(body?.offset, { min: 0, max: 100_000, def: 0 });

  const cacheKey = `validators:${status}:${limit}:${offset}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    const qs = new URLSearchParams({
      status: BOND_STATUS[status],
      "pagination.limit": String(limit),
      "pagination.offset": String(offset),
      "pagination.count_total": "true",
    });
    const data = await pocket.lcdGet(`/cosmos/staking/v1beta1/validators?${qs}`);
    const validators = (data.validators || []).map((v) => ({
      operator_address: v.operator_address,
      moniker: v.description?.moniker || null,
      tokens_upokt: v.tokens,
      tokens_pokt: pocket.upoktToPokt(v.tokens),
      commission_rate_pct: v.commission?.commission_rates?.rate != null
        ? Number(v.commission.commission_rates.rate) * 100 : null,
      jailed: !!v.jailed,
      status: v.status,
    }));
    return {
      status,
      total_count: data.pagination?.total != null ? Number(data.pagination.total) : null,
      limit,
      offset,
      validators,
      note: "tokens_* is TOTAL BONDED (self-stake + delegations) from the LCD staking module, " +
        "the true voting-power figure — not the indexer's stakeAmount, which is self-stake only.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/suppliers: indexer suppliers, network-wide or per-service --------

async function handleSuppliers(body) {
  const serviceId = body?.service_id ? requireString(body.service_id, "service_id") : null;
  const limit = clampInt(body?.limit, { min: 1, max: 100, def: 25 });
  const offset = clampInt(body?.offset, { min: 0, max: 100_000, def: 0 });

  const cacheKey = `suppliers:${serviceId || "*"}:${limit}:${offset}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 30_000, async () => {
    if (serviceId) {
      const data = await pocket.graphql(
        `query($sid:String!, $first:Int!, $off:Int!) {
          supplierServiceConfigs(
            filter:{ serviceId:{equalTo:$sid}, supplier:{stakeStatus:{equalTo:Staked}} }
            first:$first offset:$off
          ) {
            totalCount
            nodes { supplierId activatedAtId supplier { stakeAmount stakeStatus serviceConfigs { totalCount } } }
          }
        }`,
        { sid: serviceId, first: limit, off: offset }
      );
      const c = data.supplierServiceConfigs;
      return {
        service_id: serviceId,
        total_count: c.totalCount,
        limit,
        offset,
        suppliers: c.nodes.map((n) => ({
          operator_id: n.supplierId,
          activated_at_height: n.activatedAtId,
          stake_upokt: n.supplier?.stakeAmount,
          stake_pokt: pocket.upoktToPokt(n.supplier?.stakeAmount),
          stake_status: n.supplier?.stakeStatus,
          active_service_configs: n.supplier?.serviceConfigs?.totalCount,
        })),
      };
    }
    const data = await pocket.graphql(
      `query($first:Int!, $off:Int!) {
        suppliers(filter:{stakeStatus:{equalTo:Staked}}, first:$first, offset:$off, orderBy: STAKE_AMOUNT_DESC) {
          totalCount
          nodes { operatorId stakeAmount stakeStatus serviceConfigs { totalCount } }
        }
      }`,
      { first: limit, off: offset }
    );
    const c = data.suppliers;
    return {
      service_id: null,
      total_count: c.totalCount,
      limit,
      offset,
      suppliers: c.nodes.map((n) => ({
        operator_id: n.operatorId,
        stake_upokt: n.stakeAmount,
        stake_pokt: pocket.upoktToPokt(n.stakeAmount),
        stake_status: n.stakeStatus,
        active_service_configs: n.serviceConfigs?.totalCount,
      })),
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/throughput: relay/compute-unit volume over a trailing window -----

async function handleThroughput(body) {
  const windowHours = clampInt(body?.window_hours, { min: 1, max: 168, def: 24 });
  const cacheKey = `throughput:${windowHours}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const data = await pocket.graphql(
      `query($since: Datetime!) {
        blocks(filter: { timestamp: { greaterThan: $since } }) {
          totalCount
          aggregates { sum { totalTxs totalRelays totalEstimatedRelays totalComputedUnits totalEstimatedComputedUnits } }
        }
      }`,
      { since }
    );
    const b = data.blocks;
    const sum = b.aggregates?.sum || {};
    return {
      window_hours: windowHours,
      since,
      blocks_observed: b.totalCount,
      claimed: {
        relays: Number(sum.totalRelays || 0),
        compute_units: Number(sum.totalComputedUnits || 0),
      },
      estimated_true_throughput: {
        relays: Number(sum.totalEstimatedRelays || 0),
        compute_units: Number(sum.totalEstimatedComputedUnits || 0),
      },
      transactions: Number(sum.totalTxs || 0),
      note: "claimed = on-chain volume-applicable relays that beat the per-service relay-mining " +
        "difficulty target; estimated_true_throughput scales that back up by the difficulty EMA " +
        "and approximates actual off-chain request volume (what the ecosystem usually quotes).",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/applications: indexer applications, network-wide or per-service --

async function handleApplications(body) {
  const serviceId = body?.service_id ? requireString(body.service_id, "service_id") : null;
  const limit = clampInt(body?.limit, { min: 1, max: 100, def: 25 });
  const offset = clampInt(body?.offset, { min: 0, max: 100_000, def: 0 });

  const cacheKey = `applications:${serviceId || "*"}:${limit}:${offset}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 30_000, async () => {
    if (serviceId) {
      const data = await pocket.graphql(
        `query($sid:String!, $first:Int!, $off:Int!) {
          applicationServices(
            filter:{ serviceId:{equalTo:$sid}, application:{stakeStatus:{equalTo:Staked}} }
            first:$first offset:$off
          ) {
            totalCount
            nodes { applicationId application { stakeAmount stakeStatus } }
          }
        }`,
        { sid: serviceId, first: limit, off: offset }
      );
      const c = data.applicationServices;
      return {
        service_id: serviceId,
        total_count: c.totalCount,
        limit,
        offset,
        applications: c.nodes.map((n) => ({
          account_id: n.applicationId,
          stake_upokt: n.application?.stakeAmount,
          stake_pokt: pocket.upoktToPokt(n.application?.stakeAmount),
          stake_status: n.application?.stakeStatus,
        })),
      };
    }
    const data = await pocket.graphql(
      `query($first:Int!, $off:Int!) {
        applications(filter:{stakeStatus:{equalTo:Staked}}, first:$first, offset:$off, orderBy: STAKE_AMOUNT_DESC) {
          totalCount
          nodes { accountId stakeAmount stakeStatus applicationServices { totalCount } }
        }
      }`,
      { first: limit, off: offset }
    );
    const c = data.applications;
    return {
      service_id: null,
      total_count: c.totalCount,
      limit,
      offset,
      applications: c.nodes.map((n) => ({
        account_id: n.accountId,
        stake_upokt: n.stakeAmount,
        stake_pokt: pocket.upoktToPokt(n.stakeAmount),
        stake_status: n.stakeStatus,
        subscribed_services: n.applicationServices?.totalCount,
      })),
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/service-demand: per-service supply/demand signal -----------------

async function handleServiceDemand(body) {
  let serviceIds = body?.service_ids;
  if (serviceIds !== undefined) {
    if (!Array.isArray(serviceIds) || serviceIds.length === 0 || serviceIds.length > 20 ||
        !serviceIds.every((s) => typeof s === "string" && s.trim())) {
      throw new ClientError(422, "invalid_input", "service_ids must be a non-empty array of up to 20 strings");
    }
    serviceIds = serviceIds.map((s) => s.trim());
  }

  const cacheKey = `service-demand:${serviceIds ? serviceIds.join(",") : "*top*"}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    let ids = serviceIds;
    if (!ids) {
      // No services named: rank by active supplier count using the same
      // aliased-batch pattern, over the first page of registered services.
      const listing = await pocket.graphql(`query {
        services(first:30) { nodes { id name computeUnitsPerRelay } }
      }`);
      ids = listing.services.nodes.map((s) => s.id);
    }
    const aliasParts = ids.map((id, i) => `
      s${i}: service(id:${JSON.stringify(id)}) { id name computeUnitsPerRelay }
      sup${i}: supplierServiceConfigs(filter:{serviceId:{equalTo:${JSON.stringify(id)}}, supplier:{stakeStatus:{equalTo:Staked}}}) { totalCount }
      app${i}: applicationServices(filter:{serviceId:{equalTo:${JSON.stringify(id)}}, application:{stakeStatus:{equalTo:Staked}}}) { totalCount }
    `).join("\n");
    const data = await pocket.graphql(`query { ${aliasParts} }`);
    const rows = ids.map((id, i) => ({
      service_id: id,
      name: data[`s${i}`]?.name ?? null,
      compute_units_per_relay: data[`s${i}`]?.computeUnitsPerRelay ?? null,
      active_suppliers: data[`sup${i}`]?.totalCount ?? 0,
      active_applications: data[`app${i}`]?.totalCount ?? 0,
    }));
    rows.sort((a, b) => (b.active_suppliers - a.active_suppliers) || (b.active_applications - a.active_applications));
    return {
      requested: !!serviceIds,
      services: rows,
      note: "active_suppliers/active_applications are current Staked-actor counts for the service " +
        "(a live supply/demand proxy), not settled relay volume; combine with /v1/throughput for a " +
        "volume view of specific services if needed.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/supplier-trust: composite, deterministic trust signal ------------

function scoreSupplier(supplier) {
  const stakeUpokt = Number(supplier.stakeAmount || 0);
  const isStaked = supplier.stakeStatus === "Staked";
  const isUnstaking = supplier.stakeStatus === "Unstaking" || !!supplier.unstakingEndHeight;
  const activeServiceConfigs = supplier.serviceConfigs?.totalCount || 0;
  const settlements = supplier.eventClaimSettleds?.nodes || [];
  const slashes = supplier.eventSupplierSlasheds?.totalCount || 0;

  const requiredProofs = settlements.filter((s) => s.proofRequirement && s.proofRequirement !== "NOT_REQUIRED");
  // ClaimProofStatus is PENDING_VALIDATION | VALIDATED | INVALID. A still-pending
  // proof is excluded from the rate (neither a pass nor a fail yet) rather than
  // counted against the supplier.
  const validatedProofs = requiredProofs.filter((s) => s.proofValidationStatus === "VALIDATED");
  const invalidProofs = requiredProofs.filter((s) => s.proofValidationStatus === "INVALID");
  const resolvedProofs = validatedProofs.length + invalidProofs.length;
  const proofSuccessRate = resolvedProofs > 0 ? validatedProofs.length / resolvedProofs : null;

  // Deterministic 0-100 composite. Same on-chain inputs -> same output on
  // every supplier that serves this backend, per the card's "deterministic"
  // results field.
  let score = 0;
  score += isStaked ? 40 : 0;
  score += Math.min(20, Math.log10(1 + stakeUpokt / 1_000_000) * 4); // stake size, log-scaled, capped
  score += Math.min(15, activeServiceConfigs * 1.5); // breadth of service commitment
  score += proofSuccessRate === null ? 10 : proofSuccessRate * 15; // neutral credit if no sample yet
  score -= Math.min(30, slashes * 10); // slash history is a hard negative signal
  score -= isUnstaking ? 15 : 0;
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  return {
    score,
    signals: {
      stake_status: supplier.stakeStatus,
      stake_upokt: supplier.stakeAmount,
      stake_pokt: pocket.upoktToPokt(supplier.stakeAmount),
      active_service_configs: activeServiceConfigs,
      unstaking: isUnstaking,
      unstaking_end_height: supplier.unstakingEndHeight || null,
      settlements_observed: settlements.length,
      proof_required_settlements_observed: requiredProofs.length,
      proof_resolved_settlements_observed: resolvedProofs,
      proof_success_rate: proofSuccessRate,
      slash_events_total: slashes,
    },
  };
}

async function handleSupplierTrust(body) {
  const operatorId = requireString(body?.operator_id, "operator_id");
  const cacheKey = `supplier-trust:${operatorId}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    const data = await pocket.graphql(
      `query($id:String!) {
        supplier(id:$id) {
          id operatorId stakeAmount stakeStatus unstakingReason unstakingEndHeight
          serviceConfigs { totalCount }
          eventClaimSettleds(first:100, orderBy: SESSION_END_HEIGHT_DESC) {
            nodes { proofRequirement proofValidationStatus sessionEndHeight }
          }
          eventSupplierSlasheds { totalCount }
        }
      }`,
      { id: operatorId }
    );
    if (!data.supplier) {
      throw new ClientError(404, "not_found", `no supplier with operator id '${operatorId}' on ${pocket.NETWORK}`);
    }
    const { score, signals } = scoreSupplier(data.supplier);
    return {
      operator_id: operatorId,
      trust_score: score,
      trust_score_scale: "0-100, higher is more trustworthy",
      ...signals,
      methodology: "40pt staked-and-active baseline + log-scaled stake size (<=20pt) + service-config " +
        "breadth (<=15pt) + recent required-proof success rate (<=15pt, neutral if no required-proof " +
        "sample yet) - slash-event penalty (<=30pt) - unstaking penalty (15pt). Computed fresh from " +
        "on-chain state each cache window; identical for every supplier serving this backend.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- wiring ----------------------------------------------------------------

const routes = new Map([
  ["POST /v1/pulse", handlePulse],
  ["POST /v1/tokenomics", handleTokenomics],
  ["POST /v1/validators", handleValidators],
  ["POST /v1/suppliers", handleSuppliers],
  ["POST /v1/throughput", handleThroughput],
  ["POST /v1/applications", handleApplications],
  ["POST /v1/service-demand", handleServiceDemand],
  ["POST /v1/supplier-trust", handleSupplierTrust],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT} (network=${pocket.NETWORK})`);
});
