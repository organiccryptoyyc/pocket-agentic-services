// Public, market-wide signals for the confidential job. The queue fetches scored briefs from our
// own PMIC services on the internal Docker network and attaches the same bundle to every batch
// of sealed requests, so the signals reveal nothing about any customer. Cached for 30 minutes;
// a failed source is reported as "unavailable", never guessed.
"use strict";

const crypto = require("crypto");

const DEFAULT_TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 8_000;

// sources: [{ service: "pmic-macro-signals", base: "http://pmic-macro-signals-backend:8080", verticals: [...] }]
function createSignals({ sources = [], fetchImpl = fetch, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  let bundle = null;
  let refreshing = null;

  async function fetchBrief(service, base, vertical) {
    const id = `${service}:${vertical}`;
    const fetched_at = new Date(now()).toISOString();
    const empty = { id, service, vertical, score: null, label: null, trend: null, confidence: null, as_of: null, fetched_at, brief_sha256: null };
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const r = await fetchImpl(`${base}/v1/brief`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vertical }), signal: ctl.signal });
      clearTimeout(t);
      const text = await r.text();
      if (!r.ok) return { ...empty, status: "unavailable" };
      const b = JSON.parse(text);
      return {
        id, service, vertical,
        status: String(b.status || "unavailable"),
        score: typeof b.score === "number" ? b.score : null,
        label: b.label ?? null,
        trend: b.trend ?? null,
        confidence: b.confidence && b.confidence.label ? String(b.confidence.label) : null,
        as_of: (b.verified && b.verified.as_of) || null,
        fetched_at,
        brief_sha256: crypto.createHash("sha256").update(text).digest("hex"),
      };
    } catch {
      return { ...empty, status: "unavailable" };
    }
  }

  async function refresh() {
    const jobs = [];
    for (const s of sources) for (const v of s.verticals) jobs.push(fetchBrief(s.service, s.base, v));
    const items = await Promise.all(jobs);
    bundle = { fetched_at: new Date(now()).toISOString(), items };
    return bundle;
  }

  return {
    // The current bundle; refreshed when older than ttlMs. Concurrent callers share one refresh.
    async get() {
      if (!sources.length) return null;
      if (bundle && now() - Date.parse(bundle.fetched_at) < ttlMs) return bundle;
      if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
      return refreshing;
    },
    peek() { return bundle; },
  };
}

// The standard source set for a network ("main" or "beta"), from env or defaults.
function defaultSources(network) {
  const suffix = network === "beta" ? "-beta" : "";
  return [
    { service: "pmic-macro-signals", base: process.env.CQ_SIGNAL_MACRO_URL || `http://pmic-macro-signals${suffix}-backend:8080`, verticals: ["macro-regime", "credit-stress"] },
    { service: "pmic-crypto-signals", base: process.env.CQ_SIGNAL_CRYPTO_URL || `http://pmic-crypto-signals${suffix}-backend:8080`, verticals: ["crypto-liquidity", "stablecoin-supply", "crypto-prices"] },
  ];
}

module.exports = { createSignals, defaultSources };
