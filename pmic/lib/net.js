// Outbound HTTP for the collector: timeout-bounded fetch with one retry on network errors and
// 429/5xx, per-host spacing (SEC fair access asks for <= 10 requests/second), and API keys
// redacted from anything that is logged or cited. Adapted from the vendored lib/net.js in the
// other packages; this one returns text because several sources answer CSV.
"use strict";

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const RETRY_DELAY_MS = Number(process.env.PMIC_RETRY_DELAY_MS || 2000);
const MIN_SPACING_MS = {
  "data.sec.gov": 150, "www.sec.gov": 150, "api.fda.gov": 300, "api.bls.gov": 500,
  "clinicaltrials.gov": 1300, "lda.senate.gov": 4000, "lda.gov": 4000, "api.open.fec.gov": 1000,
  "wikimedia.org": 100, "data.transportation.gov": 500, "api.usaspending.gov": 300, "www.saferproducts.gov": 500,
  "echodata.epa.gov": 5000, "sdmx.oecd.org": 3000, "api.congress.gov": 750,
};
const SECRET_PARAMS = ["api_key", "UserID", "registrationkey", "registrationKey"];

class FetchError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "FetchError";
    this.status = status;
  }
}

function redact(url) {
  try {
    const u = new URL(url);
    for (const p of SECRET_PARAMS) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
    return u.toString();
  } catch {
    return String(url);
  }
}

const lastHit = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function space(host) {
  const gap = MIN_SPACING_MS[host] || 0;
  if (!gap) return;
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function once(url, init, timeoutMs) {
  await space(new URL(url).host);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // init.binary: the body is returned base64-encoded (xlsx workbooks), so it can be stored as text.
    const { binary, ...rest } = init;
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = binary ? Buffer.from(await res.arrayBuffer()).toString("base64") : await res.text();
    return { status: res.status, ok: res.ok, text, contentType: (res.headers && res.headers.get && res.headers.get("content-type")) || null };
  } catch (e) {
    if (e.name === "AbortError") throw new FetchError(`no response within ${timeoutMs}ms from ${redact(url)}`);
    // Node's fetch says only "fetch failed"; the reason (DNS, refused, reset, TLS) is in e.cause.
    const c = e.cause;
    const why = c ? ` (${[c.code, c.message].filter(Boolean).join(": ")})` : "";
    throw new FetchError(`${e.name || "Error"} calling ${redact(url)}: ${e.message}${why}`);
  } finally {
    clearTimeout(t);
  }
}

// Resolves with {status, ok, text, contentType} for any HTTP answer; retries once on a network
// error, 429 or 5xx. Throws FetchError only when no HTTP answer came back at all.
async function fetchText(url, init = {}, { timeoutMs = FETCH_TIMEOUT_MS, attempts = 2 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await once(url, init, timeoutMs);
      if ((r.status === 429 || r.status >= 500) && i < attempts - 1) {
        last = r;
        await sleep(RETRY_DELAY_MS * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

module.exports = { fetchText, FetchError, redact, FETCH_TIMEOUT_MS };
