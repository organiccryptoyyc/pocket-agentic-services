// OFAC SDN digital-currency addresses, for /v1/preflight's `sanctions_address` check.
//
// The Consolidated Screening List API (lib/checks.js screeningSearch) searches names,
// not wallet addresses. OFAC itself lists sanctioned wallet addresses as
// "Digital Currency Address - <coin>" ids on SDN entries, so we read the official SDN
// list (U.S. Treasury, public domain) once a day and match addresses exactly.
// About 30 MB, about 1,100 addresses on 2026-11-14. The last good copy is kept if a
// refresh fails.
"use strict";

const SDN_URL = process.env.OFAC_SDN_URL || "https://www.treasury.gov/ofac/downloads/sdn.xml";
const REFRESH_MS = 24 * 3_600_000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.OFAC_SDN_TIMEOUT_MS || 120_000);
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

let state = { addresses: null, publish_date: null, loaded_at: null, entries: 0, error: null };
let inFlight = null;

const tag = (block, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m ? decode(m[1].trim()) : null;
};
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const key = (address) => (EVM_RE.test(address) ? address.toLowerCase() : address.trim());

// Parses SDN XML text into Map<address key, [{uid, name, sdn_type, currency, programs}]>.
function parseSdn(xml) {
  const addresses = new Map();
  const pd = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(xml);
  let entries = 0;
  const parts = xml.split("<sdnEntry>");
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].split("</sdnEntry>")[0];
    if (!block.includes("Digital Currency Address")) continue;
    const name = [tag(block, "firstName"), tag(block, "lastName")].filter(Boolean).join(" ");
    const programs = [...block.matchAll(/<program>([^<]*)<\/program>/g)].map((m) => m[1]);
    const base = { uid: tag(block, "uid"), name, sdn_type: tag(block, "sdnType"), programs };
    for (const m of block.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(m[1], "idType") || "";
      const number = tag(m[1], "idNumber");
      if (!type.startsWith("Digital Currency Address") || !number) continue;
      const k = key(number);
      if (!addresses.has(k)) addresses.set(k, []);
      addresses.get(k).push({ ...base, currency: type.replace(/^Digital Currency Address -\s*/, "") });
      entries++;
    }
  }
  // OFAC writes MM/DD/YYYY.
  const d = pd && /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(pd[1].trim());
  return { addresses, entries, publish_date: d ? `${d[3]}-${d[1]}-${d[2]}` : null };
}

async function download() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(SDN_URL, { signal: controller.signal, headers: { "User-Agent": "agent-trust/1.4 (+https://github.com/organiccryptoyyc/pocket-agentic-services)" } });
    if (!res.ok) throw new Error(`OFAC SDN download failed: HTTP ${res.status}`);
    const parsed = parseSdn(await res.text());
    if (!parsed.entries) throw new Error("OFAC SDN list has no digital currency addresses; refusing to replace the last good copy");
    state = { ...parsed, loaded_at: new Date().toISOString(), error: null };
  } catch (e) {
    state = { ...state, error: e.name === "AbortError" ? "OFAC SDN download timed out" : String(e.message).slice(0, 200) };
  } finally {
    clearTimeout(t);
    inFlight = null;
  }
}

function fresh(now = Date.now()) {
  return state.addresses && now - Date.parse(state.loaded_at) < REFRESH_MS;
}

// Starts a refresh when the copy is missing or a day old; waits at most waitMs.
async function ensure(waitMs = 0) {
  if (fresh()) return state;
  if (!inFlight) inFlight = download();
  if (waitMs > 0) await Promise.race([inFlight, new Promise((r) => setTimeout(r, waitMs))]);
  return state;
}

// {loaded:false} when no copy has ever loaded; otherwise exact matches for the address.
function lookup(address) {
  if (!state.addresses) return { loaded: false, error: state.error };
  return {
    loaded: true,
    publish_date: state.publish_date,
    loaded_at: state.loaded_at,
    listed_addresses: state.entries,
    refresh_error: state.error,
    matches: state.addresses.get(key(String(address))) || [],
  };
}

function _reset() {
  state = { addresses: null, publish_date: null, loaded_at: null, entries: 0, error: null };
  inFlight = null;
}

module.exports = { SDN_URL, parseSdn, ensure, lookup, _reset };
