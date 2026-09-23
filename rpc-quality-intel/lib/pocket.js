// Minimal Pocket Network (Shannon) read client. Node builtins only (global fetch,
// stable since Node 18) — no npm dependencies, so the backend image stays tiny.
//
// Every value this module returns is fetched live from Pocket's own public
// endpoints at call time. Nothing here is a cached-forever constant: governance
// params, stake minimums, session geometry, participant counts and relay
// throughput all change on their own schedule, and this client re-fetches on
// every cache expiry rather than baking any of it in as a literal. That
// discipline follows the pocket-engineering skill's Rule 1 (never hardcode a
// value that lives on-chain) and its caching guidance (governance params ~1h,
// participant counts short TTL, tip data never cached as final).
//
// Endpoints (network selected by POCKET_NETWORK=main|beta, default main):
//   LCD (Cosmos REST)   - source of truth for governance params, validator
//                         total-bonded tokens, raw tx data.
//   GraphQL indexer      - PoktScan/Pocketdex, PostGraphile. Indexed/aggregated
//                         data: counts, lists, history, throughput.
//   Tendermint RPC        - block headers / consensus tip.
"use strict";

const NETWORK = (process.env.POCKET_NETWORK || "main").toLowerCase();

const LCD = {
  beta: "https://sauron-api.beta.infra.pocket.network",
  main: "https://sauron-api.infra.pocket.network",
};
const RPC = {
  beta: "https://sauron-rpc.beta.infra.pocket.network",
  main: "https://sauron-rpc.infra.pocket.network",
};
const INDEXER = {
  beta: "https://data.beta.pocket.network/graphql",
  main: "https://data.pocket.network/graphql",
};

if (!LCD[NETWORK]) {
  throw new Error(`POCKET_NETWORK must be "main" or "beta", got ${JSON.stringify(NETWORK)}`);
}

const FETCH_TIMEOUT_MS = Number(process.env.POCKET_FETCH_TIMEOUT_MS || 8000);

class UpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "UpstreamError";
    this.cause = cause;
  }
}

async function fetchJSON(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...(init && init.headers) } });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new UpstreamError(`non-JSON response from ${url}`);
    }
    if (!res.ok) {
      throw new UpstreamError(`HTTP ${res.status} from ${url}: ${body?.message || text.slice(0, 200)}`);
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new UpstreamError(`timeout after ${timeoutMs}ms calling ${url}`);
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(`${e.name || "Error"} calling ${url}: ${e.message}`, e);
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function lcdBase() {
  return LCD[NETWORK];
}

async function lcdGet(path) {
  return withRetry(() => fetchJSON(`${lcdBase()}${path}`));
}

async function rpcGet(path) {
  return withRetry(() => fetchJSON(`${RPC[NETWORK]}${path}`));
}

async function graphql(query, variables) {
  const body = JSON.stringify({ query, variables: variables || {} });
  const data = await withRetry(() =>
    fetchJSON(INDEXER[NETWORK], { method: "POST", headers: { "Content-Type": "application/json" }, body })
  );
  if (data.errors) {
    throw new UpstreamError("graphql errors: " + data.errors.map((e) => e.message).join("; "));
  }
  return data.data || {};
}

/** Fetch one module's params block from the LCD. Never cache the *value*
 *  across a governance change window longer than the caller's own TTL. */
async function moduleParams(module) {
  const data = await lcdGet(`/pokt-network/poktroll/${module}/params`);
  return data.params || {};
}

// --- tiny in-memory TTL cache with stale-on-error fallback --------------
// A cold backend with a network hiccup must still answer with a JSON 2xx
// (5xx is unpaid and penalized per the gateway design rules) so a failed
// live fetch falls back to the last good value when one exists, tagged
// `stale: true`, rather than surfacing an error status to the caller.
const _cache = new Map(); // key -> { value, fetchedAt, ttlMs }

async function cached(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.fetchedAt < ttlMs) {
    return { value: hit.value, stale: false, ageMs: now - hit.fetchedAt };
  }
  try {
    const value = await fetcher();
    _cache.set(key, { value, fetchedAt: now });
    return { value, stale: false, ageMs: 0 };
  } catch (e) {
    if (hit) {
      return { value: hit.value, stale: true, ageMs: now - hit.fetchedAt, error: e.message };
    }
    throw e;
  }
}

function upoktToPokt(amount) {
  if (amount === undefined || amount === null) return null;
  // amounts arrive as strings; keep precision via BigInt for the integer part.
  const n = BigInt(amount);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  return Number(`${whole}.${frac.toString().padStart(6, "0")}`);
}

module.exports = {
  NETWORK,
  LCD,
  RPC,
  INDEXER,
  UpstreamError,
  fetchJSON,
  lcdGet,
  rpcGet,
  graphql,
  moduleParams,
  cached,
  upoktToPokt,
};
