// Generic network helpers: timeout-bounded fetch, retry, and a stale-on-error
// TTL cache. Same pattern as pokt-network-intel/lib/pocket.js's cache/retry
// machinery, extracted here without the Pocket-chain-specific parts since
// this backend reads external web/compliance data sources (RDAP, TLS
// certificates, DNS, the U.S. Consolidated Screening List, EVM block
// explorers), not Pocket chain state.
"use strict";

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 8000);

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
      throw new UpstreamError(`non-JSON response from ${url} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body };
    }
    return { ok: true, status: res.status, body };
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

const _cache = new Map();

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
    if (hit) return { value: hit.value, stale: true, ageMs: now - hit.fetchedAt, error: e.message };
    throw e;
  }
}

module.exports = { UpstreamError, fetchJSON, withRetry, cached, FETCH_TIMEOUT_MS };
