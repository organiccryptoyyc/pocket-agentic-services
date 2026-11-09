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
const VERSION = "1.1.0";
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

// --- indexer helpers (2026-11 schema) --------------------------------------
// Pocket's indexer dropped the nested relations (supplier.serviceConfigs,
// application.applicationServices, relation filters, blocks.aggregates.sum,
// eventClaimSettleds) and caps query depth at 4. Counts and window totals now
// come from its own report functions (get*List), each one flat query.

const SHANNON_START = "2025-01-01T00:00:00Z"; // before MainNet genesis: "all time" for penalty history
const TRUST_PROOF_WINDOW_DAYS = 30;

const toNum = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Live service-config count per supplier, for up to 200 supplier ids. */
async function supplierServiceCounts(ids) {
  if (!ids.length) return new Map();
  const data = await pocket.graphql(
    `query($ids:[String!]) { getSupplierFleetList(suppliers:$ids, bySupplier:true, rowLimit:200) { supplierId serviceCount } }`,
    { ids }
  );
  return new Map((data.getSupplierFleetList || []).map((r) => [r.supplierId, toNum(r.serviceCount)]));
}

/** Live service count per application, for up to 200 application ids. */
async function applicationServiceCounts(ids) {
  if (!ids.length) return new Map();
  const data = await pocket.graphql(
    `query($ids:[String!]) { getApplicationFleetList(applications:$ids, byApplication:true, rowLimit:200) { applicationId serviceCount } }`,
    { ids }
  );
  return new Map((data.getApplicationFleetList || []).map((r) => [r.applicationId, toNum(r.serviceCount)]));
}

/** Staked supplier and application counts per service, now. */
async function serviceSummary(ids) {
  const data = await pocket.graphql(
    `query($ids:[String!]) { getServiceSummaryList(services:$ids) { serviceId stakedSuppliers stakedApplications } }`,
    { ids }
  );
  return new Map((data.getServiceSummaryList || []).map((r) => [r.serviceId, r]));
}

// --- /v1/suppliers: indexer suppliers, network-wide or per-service --------

async function handleSuppliers(body) {
  const serviceId = body?.service_id ? requireString(body.service_id, "service_id") : null;
  const limit = clampInt(body?.limit, { min: 1, max: 100, def: 25 });
  const offset = clampInt(body?.offset, { min: 0, max: 100_000, def: 0 });

  const cacheKey = `suppliers:${serviceId || "*"}:${limit}:${offset}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 30_000, async () => {
    if (serviceId) {
      // One row per Staked supplier with a live config for the service, ordered by supplier id.
      // The function pages by key (at most 1,000 rows a call), so walk to offset+limit.
      const summary = await serviceSummary([serviceId]);
      const want = offset + limit;
      const rows = [];
      let after = null;
      while (rows.length < want) {
        const n = Math.min(1000, want - rows.length);
        const data = await pocket.graphql(
          `query($sid:[String!], $n:Int!, $after:String, $afterSvc:String) {
            getStakedSupplierServicesList(services:$sid, rowLimit:$n, afterSupplierId:$after, afterServiceId:$afterSvc) {
              supplierId serviceId stakeUpokt activatedAtHeight
            }
          }`,
          { sid: [serviceId], n, after: after?.supplierId ?? null, afterSvc: after?.serviceId ?? null }
        );
        const page = data.getStakedSupplierServicesList || [];
        rows.push(...page);
        if (page.length < n) break;
        after = page[page.length - 1];
      }
      const slice = rows.slice(offset, offset + limit);
      const counts = await supplierServiceCounts(slice.map((r) => r.supplierId));
      return {
        service_id: serviceId,
        total_count: toNum(summary.get(serviceId)?.stakedSuppliers),
        limit,
        offset,
        suppliers: slice.map((r) => ({
          operator_id: r.supplierId,
          activated_at_height: r.activatedAtHeight,
          stake_upokt: r.stakeUpokt,
          stake_pokt: pocket.upoktToPokt(r.stakeUpokt),
          stake_status: "Staked",
          active_service_configs: counts.get(r.supplierId) ?? null,
        })),
      };
    }
    const data = await pocket.graphql(
      `query($first:Int!, $off:Int!) {
        suppliers(filter:{stakeStatus:{equalTo:Staked}}, first:$first, offset:$off, orderBy: STAKE_AMOUNT_DESC) {
          totalCount
          nodes { operatorId stakeAmount stakeStatus }
        }
      }`,
      { first: limit, off: offset }
    );
    const c = data.suppliers;
    const counts = await supplierServiceCounts(c.nodes.map((n) => n.operatorId));
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
        active_service_configs: counts.get(n.operatorId) ?? null,
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
    const now = new Date();
    const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
    // The indexer clips the buckets to [since, now], so the sum covers exactly the window.
    const data = await pocket.graphql(
      `query($since: Datetime!, $until: Datetime!, $bucket: String!) {
        getBlockStatsList(rangeStart:$since, rangeEnd:$until, bucket:$bucket) {
          blocks totalTxs relays estimatedRelays computeUnits estimatedComputeUnits
        }
      }`,
      { since, until: now.toISOString(), bucket: windowHours > 48 ? "day" : "hour" }
    );
    const sum = { blocks: 0, totalTxs: 0, relays: 0, estimatedRelays: 0, computeUnits: 0, estimatedComputeUnits: 0 };
    for (const b of data.getBlockStatsList || []) for (const k of Object.keys(sum)) sum[k] += toNum(b[k]);
    return {
      window_hours: windowHours,
      since,
      blocks_observed: sum.blocks,
      claimed: {
        relays: sum.relays,
        compute_units: sum.computeUnits,
      },
      estimated_true_throughput: {
        relays: sum.estimatedRelays,
        compute_units: sum.estimatedComputeUnits,
      },
      transactions: sum.totalTxs,
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
      const [summary, data] = await Promise.all([
        serviceSummary([serviceId]),
        pocket.graphql(
          `query($sid:[String!], $n:Int!, $off:Int!) {
            getApplicationFleetList(services:$sid, rowLimit:$n, rowOffset:$off) { applicationId stakeStatus stakeUpokt }
          }`,
          { sid: [serviceId], n: limit, off: offset }
        ),
      ]);
      return {
        service_id: serviceId,
        total_count: toNum(summary.get(serviceId)?.stakedApplications),
        limit,
        offset,
        applications: (data.getApplicationFleetList || []).map((n) => ({
          account_id: n.applicationId,
          stake_upokt: n.stakeUpokt,
          stake_pokt: pocket.upoktToPokt(n.stakeUpokt),
          stake_status: n.stakeStatus,
        })),
      };
    }
    const data = await pocket.graphql(
      `query($first:Int!, $off:Int!) {
        applications(filter:{stakeStatus:{equalTo:Staked}}, first:$first, offset:$off, orderBy: STAKE_AMOUNT_DESC) {
          totalCount
          nodes { accountId stakeAmount stakeStatus }
        }
      }`,
      { first: limit, off: offset }
    );
    const c = data.applications;
    const counts = await applicationServiceCounts(c.nodes.map((n) => n.accountId));
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
        subscribed_services: counts.get(n.accountId) ?? null,
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
      // No services named: rank the first page of registered services by active supplier count.
      const listing = await pocket.graphql(`query { services(first:30) { nodes { id } } }`);
      ids = listing.services.nodes.map((s) => s.id);
    }
    const [summary, named] = await Promise.all([
      serviceSummary(ids),
      pocket.graphql(
        `query($ids:[String!]) { services(filter:{id:{in:$ids}}) { nodes { id name computeUnitsPerRelay } } }`,
        { ids }
      ),
    ]);
    const meta = new Map((named.services?.nodes || []).map((s) => [s.id, s]));
    const rows = ids.map((id) => ({
      service_id: id,
      name: meta.get(id)?.name ?? null,
      compute_units_per_relay: meta.get(id)?.computeUnitsPerRelay ?? null,
      active_suppliers: toNum(summary.get(id)?.stakedSuppliers),
      active_applications: toNum(summary.get(id)?.stakedApplications),
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

function scoreSupplier(supplier, activeServiceConfigs, proofs, slashes) {
  const stakeUpokt = Number(supplier.stakeAmount || 0);
  const isStaked = supplier.stakeStatus === "Staked";
  const isUnstaking = supplier.stakeStatus === "Unstaking" || !!supplier.unstakingEndHeight;

  // A proof still awaiting validation counts as neither a pass nor a fail.
  const resolvedProofs = proofs.validated + proofs.invalid;
  const proofSuccessRate = resolvedProofs > 0 ? proofs.validated / resolvedProofs : null;

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
      settlements_observed: proofs.settled,
      proof_required_settlements_observed: proofs.submitted,
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
    const now = new Date();
    const proofSince = new Date(now.getTime() - TRUST_PROOF_WINDOW_DAYS * 86_400_000).toISOString();
    const data = await pocket.graphql(
      `query($id:String!, $ids:[String!], $proofSince:Datetime!, $allSince:Datetime!, $until:Datetime!) {
        supplier(id:$id) { id operatorId stakeAmount stakeStatus unstakingReason unstakingEndHeight }
        getSupplierFleetList(suppliers:$ids, bySupplier:true) { supplierId serviceCount }
        getSupplierProofsList(suppliers:$ids, rangeStart:$proofSince, rangeEnd:$until, bucket:"month") {
          claimsSettledWithProof claimsSettledWithoutProof proofsSubmitted proofsValidated proofsInvalid
        }
        getSupplierPenaltiesList(suppliers:$ids, rangeStart:$allSince, rangeEnd:$until, bucket:"year") { kind events }
      }`,
      { id: operatorId, ids: [operatorId], proofSince, allSince: SHANNON_START, until: now.toISOString() }
    );
    if (!data.supplier) {
      throw new ClientError(404, "not_found", `no supplier with operator id '${operatorId}' on ${pocket.NETWORK}`);
    }
    const proofs = { settled: 0, submitted: 0, validated: 0, invalid: 0 };
    for (const p of data.getSupplierProofsList || []) {
      proofs.settled += toNum(p.claimsSettledWithProof) + toNum(p.claimsSettledWithoutProof);
      proofs.submitted += toNum(p.proofsSubmitted);
      proofs.validated += toNum(p.proofsValidated);
      proofs.invalid += toNum(p.proofsInvalid);
    }
    const slashes = (data.getSupplierPenaltiesList || [])
      .filter((r) => r.kind === "slashed").reduce((s, r) => s + toNum(r.events), 0);
    const services = toNum((data.getSupplierFleetList || [])[0]?.serviceCount);
    const { score, signals } = scoreSupplier(data.supplier, services, proofs, slashes);
    return {
      operator_id: operatorId,
      trust_score: score,
      trust_score_scale: "0-100, higher is more trustworthy",
      ...signals,
      methodology: "40pt staked-and-active baseline + log-scaled stake size (<=20pt) + service-config " +
        `breadth (<=15pt) + required-proof success rate over the trailing ${TRUST_PROOF_WINDOW_DAYS} days ` +
        "(<=15pt, neutral if no resolved proof in the window) - slash-event penalty (<=30pt, all slashes " +
        "since genesis) - unstaking penalty (15pt). Computed fresh from on-chain state each cache window; " +
        "identical for every supplier serving this backend.",
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

// /v1/version reports the network the backend reads, so a Beta card's healthcheck can reject a
// backend left on the MainNet default (PNF issue #6).
const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes,
  info: { network: pocket.NETWORK, max_stale_ms: pocket.MAX_STALE_MS } });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT} (network=${pocket.NETWORK})`);
});
