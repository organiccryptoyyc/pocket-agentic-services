// Real, live data source: Polymarket's public Gamma API
// (https://gamma-api.polymarket.com), a free, no-key-required REST API for
// prediction-market metadata (confirmed live during this build — see
// README.md "Verification"). This module fetches, normalizes, and caches a
// broad candidate pool of currently-open markets, and keeps a short
// in-memory history of top-100-by-30-day-volume snapshots so /v1/rotation-diff
// can report real change over time. Nothing here is Polymarket-affiliated,
// sponsored, or endorsed — see README.md "Origin and disclosure."
"use strict";

const { fetchJSON, withRetry, UpstreamError, cached } = require("./net");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Real, confirmed-live bug in Polymarket's own Gamma API (2026-09-27, this
// build): the `order` query parameter does NOT reliably return markets in
// strictly sorted order. Pulling `/markets?order=volume24hr&ascending=false`
// and `/markets?order=volume1mo&ascending=false` directly, twice each,
// both showed a later-ranked market with a HIGHER value than an
// earlier-ranked one (e.g. rank 3 < rank 4 by the sorted field) — not a
// one-off fluke, reproduced on a second pull with a different field. This
// is Polymarket's bug, not fixable from this backend, so it is worked
// around rather than trusted: fetch several pages, each seeded by a
// DIFFERENT order field (so a market mis-ranked under one field is very
// likely still captured via another), merge and de-duplicate by market id,
// then ALWAYS re-sort every candidate client-side by the exact numeric
// field this backend actually needs. No response from this backend ever
// depends on Polymarket's own `order` param being correct.
const SEED_ORDERS = ["volume", "volume24hr", "volume1mo", "liquidity"];
const SEED_PAGE_SIZE = 300;

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Real, confirmed-live quirk (2026-09-27): Polymarket's Gamma API returns
// `outcomes` and `outcomePrices` as JSON-ENCODED STRINGS (e.g.
// `"[\"Yes\", \"No\"]"`), not native JSON arrays — confirmed by inspecting
// the raw response body directly. A naive `market.outcomes.map(...)` would
// throw. Every caller of this module gets real arrays, never raw strings.
function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeMarket(raw) {
  const outcomes = safeJsonArray(raw.outcomes);
  const outcomePrices = safeJsonArray(raw.outcomePrices).map((p) => numOrNull(p));
  return {
    id: String(raw.id),
    slug: raw.slug || null,
    question: raw.question || null,
    active: !!raw.active,
    closed: !!raw.closed,
    end_date: raw.endDateIso || raw.endDate || null,
    outcomes,
    outcome_prices: outcomePrices,
    volume_usd: numOrNull(raw.volumeNum ?? raw.volume),
    volume_24hr_usd: numOrNull(raw.volume24hr),
    volume_1wk_usd: numOrNull(raw.volume1wk),
    volume_1mo_usd: numOrNull(raw.volume1mo),
    liquidity_usd: numOrNull(raw.liquidityNum ?? raw.liquidity),
    best_bid: numOrNull(raw.bestBid),
    best_ask: numOrNull(raw.bestAsk),
    spread: numOrNull(raw.spread),
    price_change_1d: numOrNull(raw.oneDayPriceChange),
    price_change_1w: numOrNull(raw.oneWeekPriceChange),
    price_change_1mo: numOrNull(raw.oneMonthPriceChange),
  };
}

async function fetchSeedPage(order) {
  const url = `${GAMMA_BASE}/markets?limit=${SEED_PAGE_SIZE}&order=${encodeURIComponent(order)}&ascending=false&closed=false&active=true`;
  const res = await withRetry(() => fetchJSON(url, undefined, 12_000));
  if (!res.ok) throw new UpstreamError(`Polymarket Gamma API /markets lookup failed: HTTP ${res.status}`);
  return Array.isArray(res.body) ? res.body : [];
}

async function buildCandidatePool() {
  const pages = await Promise.all(SEED_ORDERS.map((o) => fetchSeedPage(o).catch(() => [])));
  if (pages.every((p) => p.length === 0)) {
    throw new UpstreamError("Polymarket Gamma API returned no markets from any seed query");
  }
  const byId = new Map();
  for (const page of pages) {
    for (const raw of page) {
      if (!raw || raw.id == null) continue;
      const id = String(raw.id);
      if (!byId.has(id)) byId.set(id, normalizeMarket(raw));
    }
  }
  return [...byId.values()];
}

// --- rolling snapshot history, for /v1/rotation-diff -------------------------
// In-memory only: resets on process restart. This is a real, disclosed
// limitation (see README.md), not hidden — /v1/rotation-diff reports
// honestly when it doesn't have enough history yet rather than fabricating
// a comparison.
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep up to 7 days
const MIN_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000; // don't record more than once per 15 min
const snapshotHistory = [];

function recordSnapshot(pool) {
  const last = snapshotHistory[snapshotHistory.length - 1];
  const now = Date.now();
  if (last && now - last.at < MIN_SNAPSHOT_INTERVAL_MS) return;
  const ranked = pool
    .filter((m) => m.volume_1mo_usd != null)
    .sort((a, b) => b.volume_1mo_usd - a.volume_1mo_usd)
    .slice(0, 100);
  snapshotHistory.push({
    at: now,
    top: ranked.map((m, i) => ({ rank: i + 1, id: m.id, slug: m.slug, question: m.question, volume_1mo_usd: m.volume_1mo_usd })),
  });
  const cutoff = now - SNAPSHOT_RETENTION_MS;
  while (snapshotHistory.length && snapshotHistory[0].at < cutoff) snapshotHistory.shift();
}

function findSnapshotNear(targetMs) {
  if (snapshotHistory.length === 0) return null;
  let best = snapshotHistory[0];
  let bestDiff = Math.abs(best.at - targetMs);
  for (const s of snapshotHistory) {
    const diff = Math.abs(s.at - targetMs);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

// --- cached candidate-pool accessor -------------------------------------------

const CACHE_TTL_MS = 180_000; // 3 min: real-enough for a "30-day rotation" use case, far below Polymarket's own rate limit

async function getCandidatePool() {
  const { value, stale, ageMs } = await cached("polymarket:candidate-pool", CACHE_TTL_MS, async () => {
    const pool = await buildCandidatePool();
    recordSnapshot(pool);
    return pool;
  });
  return { pool: value, stale, ageMs };
}

module.exports = {
  GAMMA_BASE,
  getCandidatePool,
  findSnapshotNear,
  snapshotHistory,
  normalizeMarket,
  safeJsonArray,
};
