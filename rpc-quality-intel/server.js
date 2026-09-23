// RPC / Gateway Quality Intelligence — a Pocket Network service.
//
// Four endpoints that answer "how well is Pocket actually serving RPC access
// to this chain/service right now?" — a per-service quality lens, distinct
// from pokt-network-intel's network-wide protocol view. Backed live by
// Pocket's GraphQL indexer (relay-mining difficulty state, settled-claim
// history windowed by real block timestamps, distinct-supplier counts,
// slash events). Every query below was interactively verified against
// https://data.pocket.network/graphql before being wired in; see README.md
// "Verification".
"use strict";

const { createServer, ClientError } = require("./lib/http");
const pocket = require("./lib/pocket");

const SERVICE = "rpc-quality-intel";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

function clampInt(value, { min, max, def }) {
  if (value === undefined || value === null || value === "") return def;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ClientError(422, "invalid_input", `expected an integer, got ${JSON.stringify(value)}`);
  }
  if (n < min || n > max) throw new ClientError(422, "invalid_input", `must be between ${min} and ${max}, got ${n}`);
  return n;
}

function requireServiceId(body) {
  const v = body?.service_id;
  if (typeof v !== "string" || v.trim() === "") {
    throw new ClientError(422, "invalid_input", "field 'service_id' is required and must be a non-empty string (e.g. \"eth\")");
  }
  return v.trim();
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

async function assertServiceExists(serviceId) {
  const data = await pocket.graphql(
    `query($id:String!) { service(id:$id) { id name computeUnitsPerRelay } }`,
    { id: serviceId }
  );
  if (!data.service) {
    throw new ClientError(404, "not_found", `no service with id '${serviceId}' on ${pocket.NETWORK}`);
  }
  return data.service;
}

// --- /v1/rpc-pulse: current serving snapshot for one service --------------

async function handlePulse(body) {
  const serviceId = requireServiceId(body);
  const cacheKey = `pulse:${serviceId}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 15_000, async () => {
    const svc = await assertServiceExists(serviceId);
    const since1h = new Date(Date.now() - 3_600_000).toISOString();
    const data = await pocket.graphql(
      `query($sid:String!, $since:Datetime!) {
        activeSuppliers: supplierServiceConfigs(filter:{serviceId:{equalTo:$sid}, supplier:{stakeStatus:{equalTo:Staked}}}) { totalCount }
        activeApplications: applicationServices(filter:{serviceId:{equalTo:$sid}, application:{stakeStatus:{equalTo:Staked}}}) { totalCount }
        difficulty: relayMiningDifficultyUpdatedEvents(filter:{serviceId:{equalTo:$sid}}, first:1, orderBy: BLOCK_ID_DESC) {
          nodes { newNumRelaysEma newTargetHashHexEncoded blockId }
        }
        recentHour: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}}) {
          totalCount
          aggregates { sum { numRelays numEstimatedRelays } distinctCount { supplierId } }
        }
      }`,
      { sid: serviceId, since: since1h }
    );
    const diffNode = data.difficulty.nodes[0] || null;
    const rh = data.recentHour.aggregates?.sum || {};
    return {
      service_id: serviceId,
      service_name: svc.name,
      compute_units_per_relay: svc.computeUnitsPerRelay,
      active_suppliers: data.activeSuppliers.totalCount,
      active_applications: data.activeApplications.totalCount,
      relay_mining_difficulty: diffNode ? {
        relays_ema: diffNode.newNumRelaysEma,
        target_hash: diffNode.newTargetHashHexEncoded,
        as_of_height: diffNode.blockId,
      } : null,
      trailing_1h: {
        settlements: data.recentHour.totalCount,
        claimed_relays: Number(rh.numRelays || 0),
        estimated_relays: Number(rh.numEstimatedRelays || 0),
        distinct_suppliers_serving: Number(data.recentHour.aggregates?.distinctCount?.supplierId || 0),
      },
      note: "relays_ema is the relay-mining difficulty's exponential moving average of request volume for " +
        "this service, Pocket's own live difficulty signal; a falling active_suppliers or distinct_suppliers_serving " +
        "with unchanged demand is an early quality-degradation signal (fewer parties available to serve traffic).",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/rpc-performance: settlement/proof performance over a window ------

async function handlePerformance(body) {
  const serviceId = requireServiceId(body);
  const windowHours = clampInt(body?.window_hours, { min: 1, max: 168, def: 24 });
  const cacheKey = `performance:${serviceId}:${windowHours}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    await assertServiceExists(serviceId);
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const data = await pocket.graphql(
      `query($sid:String!, $since:Datetime!) {
        settlements: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}}) {
          totalCount
          aggregates { sum { numRelays numEstimatedRelays numClaimedComputedUnits } average { numRelays } distinctCount { supplierId } }
        }
        required: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}, proofRequirement:{notEqualTo:NOT_REQUIRED}}) {
          totalCount
        }
        validated: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}, proofRequirement:{notEqualTo:NOT_REQUIRED}, proofValidationStatus:{equalTo:VALIDATED}}) {
          totalCount
        }
        invalid: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}, proofRequirement:{notEqualTo:NOT_REQUIRED}, proofValidationStatus:{equalTo:INVALID}}) {
          totalCount
        }
        slashes: eventSupplierSlasheds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$since}}}) { totalCount }
      }`,
      { sid: serviceId, since }
    );
    const s = data.settlements;
    const sum = s.aggregates?.sum || {};
    const requiredCount = data.required.totalCount;
    const validatedCount = data.validated.totalCount;
    const invalidCount = data.invalid.totalCount;
    const resolvedCount = validatedCount + invalidCount;
    return {
      service_id: serviceId,
      window_hours: windowHours,
      since,
      settlements: s.totalCount,
      distinct_suppliers_serving: Number(s.aggregates?.distinctCount?.supplierId || 0),
      claimed_relays: Number(sum.numRelays || 0),
      estimated_relays: Number(sum.numEstimatedRelays || 0),
      claimed_compute_units: Number(sum.numClaimedComputedUnits || 0),
      average_relays_per_settlement: s.aggregates?.average?.numRelays != null ? Number(s.aggregates.average.numRelays) : null,
      proof: {
        required: requiredCount,
        validated: validatedCount,
        invalid: invalidCount,
        pending_or_unresolved: requiredCount - resolvedCount,
        success_rate: resolvedCount > 0 ? validatedCount / resolvedCount : null,
      },
      slash_events: data.slashes.totalCount,
      note: "success_rate excludes still-pending proofs from the denominator (validated / (validated+invalid)) " +
        "and is null when no proof has resolved in this window; NOT_REQUIRED settlements (small/low-difficulty " +
        "services often settle entirely this way) are excluded from 'required' entirely, which is expected, not missing data.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/rpc-anomaly: recent window vs a longer baseline -------------------

async function handleAnomaly(body) {
  const serviceId = requireServiceId(body);
  const recentHours = clampInt(body?.recent_window_hours, { min: 1, max: 72, def: 24 });
  const baselineHours = clampInt(body?.baseline_window_hours, { min: recentHours * 2, max: 720, def: Math.max(168, recentHours * 7) });
  const cacheKey = `anomaly:${serviceId}:${recentHours}:${baselineHours}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 60_000, async () => {
    await assertServiceExists(serviceId);
    const now = Date.now();
    const recentSince = new Date(now - recentHours * 3_600_000).toISOString();
    const baselineSince = new Date(now - baselineHours * 3_600_000).toISOString();
    const data = await pocket.graphql(
      `query($sid:String!, $recentSince:Datetime!, $baselineSince:Datetime!, $recentSince2:Datetime!) {
        recent: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$recentSince}}}) {
          aggregates { sum { numRelays } distinctCount { supplierId } }
        }
        baseline: eventClaimSettleds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$baselineSince, lessThanOrEqualTo:$recentSince2}}}) {
          aggregates { sum { numRelays } distinctCount { supplierId } }
        }
        recentSlashes: eventSupplierSlasheds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$recentSince}}}) { totalCount }
        baselineSlashes: eventSupplierSlasheds(filter:{serviceId:{equalTo:$sid}, block:{timestamp:{greaterThan:$baselineSince, lessThanOrEqualTo:$recentSince2}}}) { totalCount }
        activeSuppliersNow: supplierServiceConfigs(filter:{serviceId:{equalTo:$sid}, supplier:{stakeStatus:{equalTo:Staked}}}) { totalCount }
      }`,
      { sid: serviceId, recentSince, baselineSince, recentSince2: recentSince }
    );

    const recentRelays = Number(data.recent.aggregates?.sum?.numRelays || 0);
    const baselineRelays = Number(data.baseline.aggregates?.sum?.numRelays || 0);
    const baselineHoursExRecent = baselineHours - recentHours;
    const recentPerHour = recentRelays / recentHours;
    const baselinePerHour = baselineHoursExRecent > 0 ? baselineRelays / baselineHoursExRecent : 0;
    const relayChangePct = baselinePerHour > 0 ? ((recentPerHour - baselinePerHour) / baselinePerHour) * 100 : null;

    const recentSuppliers = Number(data.recent.aggregates?.distinctCount?.supplierId || 0);
    const baselineSuppliers = Number(data.baseline.aggregates?.distinctCount?.supplierId || 0);
    const activeSuppliersNow = data.activeSuppliersNow.totalCount;

    const recentSlashes = data.recentSlashes.totalCount;
    const baselineSlashRatePerHour = baselineHoursExRecent > 0 ? data.baselineSlashes.totalCount / baselineHoursExRecent : 0;
    const recentSlashRatePerHour = recentSlashes / recentHours;

    const flags = [];
    if (relayChangePct !== null && relayChangePct <= -50) {
      flags.push({ signal: "relay_volume_drop", severity: "high", detail: `claimed relays/hour down ${relayChangePct.toFixed(1)}% vs the ${baselineHours}h baseline` });
    } else if (relayChangePct !== null && relayChangePct <= -25) {
      flags.push({ signal: "relay_volume_drop", severity: "moderate", detail: `claimed relays/hour down ${relayChangePct.toFixed(1)}% vs the ${baselineHours}h baseline` });
    }
    if (activeSuppliersNow > 0 && recentSuppliers > 0 && recentSuppliers < activeSuppliersNow * 0.5) {
      flags.push({ signal: "supplier_participation_drop", severity: "moderate", detail: `only ${recentSuppliers} of ${activeSuppliersNow} currently-staked suppliers settled a claim in the last ${recentHours}h` });
    }
    if (recentSlashRatePerHour > 0 && recentSlashRatePerHour > baselineSlashRatePerHour * 3 && recentSlashes >= 2) {
      flags.push({ signal: "slash_rate_spike", severity: "high", detail: `${recentSlashes} slash event(s) in the last ${recentHours}h vs a baseline rate of ${(baselineSlashRatePerHour * recentHours).toFixed(2)} expected` });
    }

    return {
      service_id: serviceId,
      recent_window_hours: recentHours,
      baseline_window_hours: baselineHours,
      recent: { claimed_relays_per_hour: Math.round(recentPerHour * 100) / 100, distinct_suppliers_serving: recentSuppliers, slash_events: recentSlashes },
      baseline: { claimed_relays_per_hour: Math.round(baselinePerHour * 100) / 100, distinct_suppliers_serving: baselineSuppliers, slash_events: data.baselineSlashes.totalCount },
      active_suppliers_now: activeSuppliersNow,
      relay_volume_change_pct: relayChangePct !== null ? Math.round(relayChangePct * 100) / 100 : null,
      anomalies: flags,
      is_anomalous: flags.length > 0,
      note: "Deterministic comparison of two trailing windows of real settlement history; thresholds are fixed " +
        "(>=25%/50% relay-volume drop, <50% of staked suppliers active, >=3x baseline slash rate with >=2 events), " +
        "not a statistical model. No flag is not a guarantee of health, only the absence of these specific signals.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/rpc-forecast: simple linear-trend projection over daily buckets --

function linearRegression(points) {
  // points: [[x, y], ...]. Ordinary least squares. Returns {slope, intercept}.
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: points[0][1] };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const [x, y] of points) {
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

async function handleForecast(body) {
  const serviceId = requireServiceId(body);
  const lookbackDays = clampInt(body?.lookback_days, { min: 3, max: 30, def: 7 });
  const horizonDays = clampInt(body?.horizon_days, { min: 1, max: 7, def: 1 });
  const cacheKey = `forecast:${serviceId}:${lookbackDays}:${horizonDays}`;
  const { value, stale, ageMs } = await pocket.cached(cacheKey, 300_000, async () => {
    await assertServiceExists(serviceId);
    const now = Date.now();
    const dayMs = 86_400_000;
    let aliasParts = "";
    for (let i = 0; i < lookbackDays; i++) {
      const end = new Date(now - i * dayMs).toISOString();
      const start = new Date(now - (i + 1) * dayMs).toISOString();
      aliasParts += `d${i}: eventClaimSettleds(filter:{serviceId:{equalTo:${JSON.stringify(serviceId)}}, block:{timestamp:{greaterThan:${JSON.stringify(start)}, lessThanOrEqualTo:${JSON.stringify(end)}}}}) { aggregates { sum { numRelays } } }\n`;
    }
    const data = await pocket.graphql(`query { ${aliasParts} }`);
    // day_index 0 = oldest bucket .. (lookbackDays-1) = most recent bucket (yesterday..today)
    const dailyRelays = [];
    for (let i = lookbackDays - 1; i >= 0; i--) {
      dailyRelays.push(Number(data[`d${i}`]?.aggregates?.sum?.numRelays || 0));
    }
    const points = dailyRelays.map((y, x) => [x, y]);
    const { slope, intercept } = linearRegression(points);
    const mean = dailyRelays.reduce((a, b) => a + b, 0) / dailyRelays.length;
    const variance = dailyRelays.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRelays.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : null;

    const forecast = [];
    for (let h = 1; h <= horizonDays; h++) {
      const x = lookbackDays - 1 + h;
      forecast.push({ day_offset: h, projected_claimed_relays: Math.max(0, Math.round(intercept + slope * x)) });
    }

    return {
      service_id: serviceId,
      lookback_days: lookbackDays,
      horizon_days: horizonDays,
      daily_claimed_relays_oldest_first: dailyRelays,
      trend: { slope_relays_per_day: Math.round(slope * 100) / 100, mean_daily_relays: Math.round(mean * 100) / 100, coefficient_of_variation: coefficientOfVariation != null ? Math.round(coefficientOfVariation * 1000) / 1000 : null },
      forecast,
      confidence: coefficientOfVariation === null ? "low" : coefficientOfVariation < 0.15 ? "high" : coefficientOfVariation < 0.4 ? "medium" : "low",
      methodology: "Ordinary least-squares linear regression over daily claimed-relay totals from real settled-claim " +
        "history (day index vs. count), projected forward. Deterministic for the same on-chain history and inputs. " +
        "Not a statistical time-series model (no seasonality/ARIMA) — confidence is a coefficient-of-variation heuristic, " +
        "not a prediction interval; treat as a directional signal.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- wiring ------------------------------------------------------------------

const routes = new Map([
  ["POST /v1/rpc-pulse", handlePulse],
  ["POST /v1/rpc-performance", handlePerformance],
  ["POST /v1/rpc-anomaly", handleAnomaly],
  ["POST /v1/rpc-forecast", handleForecast],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT} (network=${pocket.NETWORK})`);
});
