// Prediction Market Intelligence — a Pocket Network service.
//
// Four endpoints for an autonomous agent that wants strategy/insight signal
// from prediction-market attention and pricing, not just a raw data
// passthrough: a correctly-ranked top-N by trailing volume window
// (/v1/top-markets), biggest consensus shifts (/v1/market-momentum), what
// entered/exited the top 100 over a lookback window (/v1/rotation-diff),
// and a liquidity/spread-based quality signal for the busiest markets
// (/v1/market-quality). Every field is fetched live from Polymarket's free,
// public Gamma API at request time (via a short-TTL cache); nothing is
// bundled or simulated. See README.md "Verification" for two real,
// confirmed-live upstream quirks this backend works around: an unreliable
// `order` query parameter, and `outcomes`/`outcomePrices` arriving as
// JSON-encoded strings rather than native arrays.
//
// Independent, standalone project: not affiliated with, endorsed by, or
// sponsored by Polymarket. See README.md "Origin and disclosure."
"use strict";

const { createServer, ClientError } = require("./lib/http");
const polymarket = require("./lib/polymarket");

const SERVICE = "prediction-market-intel";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

const WINDOW_FIELDS = { "24hr": "volume_24hr_usd", "1wk": "volume_1wk_usd", "1mo": "volume_1mo_usd" };
const MOMENTUM_FIELDS = { "1d": "price_change_1d", "1w": "price_change_1w", "1mo": "price_change_1mo" };

function clampInt(value, { min, max, def }) {
  if (value === undefined || value === null || value === "") return def;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ClientError(422, "invalid_input", `expected an integer, got ${JSON.stringify(value)}`);
  if (n < min || n > max) throw new ClientError(422, "invalid_input", `must be between ${min} and ${max}, got ${n}`);
  return n;
}

function requireEnum(value, allowed, def) {
  const v = value === undefined || value === null || value === "" ? def : value;
  if (!allowed.includes(v)) {
    throw new ClientError(422, "invalid_input", `must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
  }
  return v;
}

function withMeta(payload, cacheInfo) {
  return {
    service: SERVICE,
    fetched_at: new Date().toISOString(),
    cache: { stale: !!cacheInfo.stale, age_ms: cacheInfo.ageMs },
    ...payload,
  };
}

function publicMarket(m, extra = {}) {
  return {
    id: m.id,
    slug: m.slug,
    question: m.question,
    end_date: m.end_date,
    outcomes: m.outcomes,
    outcome_prices: m.outcome_prices,
    volume_24hr_usd: m.volume_24hr_usd,
    volume_1wk_usd: m.volume_1wk_usd,
    volume_1mo_usd: m.volume_1mo_usd,
    liquidity_usd: m.liquidity_usd,
    best_bid: m.best_bid,
    best_ask: m.best_ask,
    spread: m.spread,
    ...extra,
  };
}

// --- /v1/top-markets ----------------------------------------------------------

async function handleTopMarkets(body) {
  const limit = clampInt(body?.limit, { min: 1, max: 100, def: 20 });
  const window = requireEnum(body?.window, ["24hr", "1wk", "1mo"], "1mo");
  const field = WINDOW_FIELDS[window];
  const { pool, stale, ageMs } = await polymarket.getCandidatePool();
  const ranked = pool
    .filter((m) => m[field] != null)
    .sort((a, b) => b[field] - a[field])
    .slice(0, limit);
  const markets = ranked.map((m, i) => publicMarket(m, { rank: i + 1 }));
  return withMeta(
    {
      window,
      ranked_by: field,
      candidate_pool_size: pool.length,
      count: markets.length,
      markets,
      note:
        "Ranked by Polymarket's own reported volume for the requested trailing window (24hr/1wk/1mo), re-sorted " +
        "by this backend rather than trusting Polymarket's own `order` query param, which was found live during " +
        "this build to not always return strictly sorted results. `candidate_pool_size` is the number of distinct " +
        "currently-open markets this backend had in view when it computed this ranking — a broad, multi-seeded " +
        "sample of the most actively-traded markets, not a claim of exhaustively ranking every market Polymarket " +
        "has ever listed.",
    },
    { stale, ageMs }
  );
}

// --- /v1/market-momentum -------------------------------------------------------

async function handleMarketMomentum(body) {
  const limit = clampInt(body?.limit, { min: 1, max: 50, def: 10 });
  const window = requireEnum(body?.window, ["1d", "1w", "1mo"], "1w");
  const direction = requireEnum(body?.direction, ["up", "down", "any"], "any");
  const field = MOMENTUM_FIELDS[window];
  const { pool, stale, ageMs } = await polymarket.getCandidatePool();
  let candidates = pool.filter((m) => m[field] != null && m[field] !== 0);
  if (direction === "up") candidates = candidates.filter((m) => m[field] > 0);
  if (direction === "down") candidates = candidates.filter((m) => m[field] < 0);
  candidates.sort((a, b) => Math.abs(b[field]) - Math.abs(a[field]));
  const top = candidates.slice(0, limit).map((m) =>
    publicMarket(m, {
      price_change: m[field],
      price_change_window: window,
      direction: m[field] > 0 ? "up" : "down",
      moved_outcome: Array.isArray(m.outcomes) && m.outcomes.length > 0 ? m.outcomes[0] : null,
    })
  );
  return withMeta(
    {
      window,
      direction,
      candidate_pool_size: pool.length,
      count: top.length,
      movers: top,
      note:
        "`price_change` is Polymarket's own reported change (in implied-probability points, roughly 0-1 scale) " +
        "for the FIRST listed outcome over the requested window — this is the largest observed consensus shift " +
        "among the candidate pool, not a guarantee it is statistically significant for low-volume markets. For a " +
        "market with more than two outcomes, `moved_outcome` names only the first outcome Polymarket lists, which " +
        "the price_change field itself is scoped to upstream.",
    },
    { stale, ageMs }
  );
}

// --- /v1/rotation-diff ----------------------------------------------------------

async function handleRotationDiff(body) {
  const lookbackHours = clampInt(body?.lookback_hours, { min: 1, max: 168, def: 24 });
  const { stale, ageMs } = await polymarket.getCandidatePool(); // ensures at least one snapshot exists
  const history = polymarket.snapshotHistory;
  if (history.length === 0) {
    // Should not happen right after getCandidatePool() above, but degrade
    // honestly rather than throw a confusing error if it ever does.
    return withMeta(
      { insufficient_history: true, note: "no snapshot recorded yet; try again shortly." },
      { stale, ageMs }
    );
  }
  const now = history[history.length - 1];
  const targetMs = now.at - lookbackHours * 3_600_000;
  const past = polymarket.findSnapshotNear(targetMs);
  const oldestAgeMs = now.at - history[0].at;
  if (!past || past === now || oldestAgeMs < lookbackHours * 3_600_000 * 0.5) {
    return withMeta(
      {
        insufficient_history: true,
        lookback_hours: lookbackHours,
        oldest_snapshot_age_ms: oldestAgeMs,
        note:
          "This backend keeps its own rolling history in memory and it resets on every restart — it does not yet " +
          "have a snapshot far enough back to answer a " + lookbackHours + "h lookback honestly. Try a smaller " +
          "lookback_hours, or ask again once this backend has been running longer.",
      },
      { stale, ageMs }
    );
  }
  const pastIds = new Map(past.top.map((m) => [m.id, m]));
  const nowIds = new Map(now.top.map((m) => [m.id, m]));
  const entered = now.top.filter((m) => !pastIds.has(m.id));
  const exited = past.top.filter((m) => !nowIds.has(m.id));
  const rankChanges = now.top
    .filter((m) => pastIds.has(m.id))
    .map((m) => ({ id: m.id, slug: m.slug, question: m.question, rank_now: m.rank, rank_before: pastIds.get(m.id).rank, rank_delta: pastIds.get(m.id).rank - m.rank }))
    .filter((c) => c.rank_delta !== 0)
    .sort((a, b) => Math.abs(b.rank_delta) - Math.abs(a.rank_delta));
  return withMeta(
    {
      lookback_hours: lookbackHours,
      compared_at: new Date(now.at).toISOString(),
      compared_against: new Date(past.at).toISOString(),
      entered_top_100: entered,
      exited_top_100: exited,
      biggest_rank_moves: rankChanges.slice(0, 20),
      note: "Both snapshots rank the top 100 by trailing 30-day volume (volume_1mo_usd) at their own point in time.",
    },
    { stale, ageMs }
  );
}

// --- /v1/market-quality ---------------------------------------------------------

function scoreMarketQuality(m) {
  const reasons = [];
  let score = 100;
  if (m.spread == null || m.liquidity_usd == null) {
    reasons.push("missing spread or liquidity data from Polymarket for this market; score is a partial estimate");
    score -= 20;
  } else {
    if (m.spread > 0.05) { score -= 30; reasons.push(`wide bid/ask spread (${m.spread.toFixed(3)}) — real slippage risk for a market order`); }
    else if (m.spread > 0.02) { score -= 15; reasons.push(`moderate bid/ask spread (${m.spread.toFixed(3)})`); }
    const vol24 = m.volume_24hr_usd || 0;
    const ratio = vol24 > 0 ? m.liquidity_usd / vol24 : null;
    if (ratio != null) {
      if (ratio < 0.05) { score -= 30; reasons.push(`liquidity is only ${(ratio * 100).toFixed(1)}% of 24h volume — thin order book relative to trading interest, prices can move sharply on a single large order`); }
      else if (ratio < 0.2) { score -= 10; reasons.push(`liquidity is ${(ratio * 100).toFixed(1)}% of 24h volume — moderate depth`); }
    }
  }
  if (reasons.length === 0) reasons.push("no liquidity-quality concerns observed in this backend's checks");
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

async function handleMarketQuality(body) {
  const limit = clampInt(body?.limit, { min: 1, max: 50, def: 20 });
  const window = requireEnum(body?.window, ["24hr", "1wk", "1mo"], "1mo");
  const field = WINDOW_FIELDS[window];
  const { pool, stale, ageMs } = await polymarket.getCandidatePool();
  const ranked = pool
    .filter((m) => m[field] != null)
    .sort((a, b) => b[field] - a[field])
    .slice(0, limit);
  const markets = ranked.map((m, i) => {
    const { score, reasons } = scoreMarketQuality(m);
    return publicMarket(m, { rank: i + 1, liquidity_quality_score: score, liquidity_quality_score_scale: "0-100, higher is deeper/tighter (more favorable to trade)", reasons });
  });
  return withMeta(
    {
      window,
      candidate_pool_size: pool.length,
      count: markets.length,
      markets,
      note:
        "liquidity_quality_score is a heuristic composite of bid/ask spread and liquidity-to-24h-volume ratio, " +
        "computed by this backend from Polymarket's own live fields — not an upstream Polymarket field, and not a " +
        "prediction of where the market resolves.",
    },
    { stale, ageMs }
  );
}

// --- wiring --------------------------------------------------------------------

const routes = new Map([
  ["POST /v1/top-markets", handleTopMarkets],
  ["POST /v1/market-momentum", handleMarketMomentum],
  ["POST /v1/rotation-diff", handleRotationDiff],
  ["POST /v1/market-quality", handleMarketQuality],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`);
});
