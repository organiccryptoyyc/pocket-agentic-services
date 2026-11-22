// Public screening lists for counterparty-screen (Service 3). The queue downloads the official
// files, keeps only what matching needs, and hands the same bundle to the Liskov job for every
// customer. Customer items never come here: the job matches them inside itself.
//
//   U.S. Consolidated Screening List (International Trade Administration, public domain):
//     names and alternate names from OFAC SDN and 10+ other U.S. lists.
//   OFAC SDN list (U.S. Treasury, public domain): "Digital Currency Address" and "Website" ids,
//     which the Consolidated Screening List does not carry.
//
// Refreshed every 12 hours; the last good bundle is kept (in memory and on disk) if a refresh fails.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = "pocket-confidential-lists/0.1";
const CSL_URL = process.env.CQ_CSL_URL || "https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json";
const SDN_URL = process.env.CQ_SDN_URL || "https://www.treasury.gov/ofac/downloads/sdn.xml";
const REFRESH_MS = 12 * 3600_000;
const RETRY_MS = 30 * 60_000;
const UA = "pocket-confidential-queue (+https://github.com/organiccryptoyyc/pocket-agentic-services)";
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const tag = (block, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block); return m ? decode(m[1].trim()) : null; };
const listCode = (source) => { const m = /\(([^)]+)\)/.exec(String(source || "")); return m ? m[1] : String(source || "?").slice(0, 20); };
const normDomain = (s) => {
  const d = String(s).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
};

// CSL JSON -> entries [id, list code, name, alt names, country, programs] and the newest update.
function parseCsl(text) {
  const d = JSON.parse(text);
  const rows = Array.isArray(d.results) ? d.results : [];
  const entries = [];
  for (const r of rows) {
    const name = String(r.name || "").trim();
    if (!name) continue;
    const alts = (Array.isArray(r.alt_names) ? r.alt_names : []).map((a) => String(a).trim()).filter(Boolean);
    entries.push([String(r.id || ""), listCode(r.source), name, alts, r.country || null, (r.programs || []).join("; ")]);
  }
  const updated = (d.sources_used || []).map((s) => s.source_last_updated).filter(Boolean).sort().pop() || null;
  return { entries, last_updated: updated ? updated.slice(0, 10) : null };
}

// SDN XML -> wallet addresses and websites, keyed for exact matching.
function parseSdn(xml) {
  const addresses = {};
  const websites = {};
  let count = 0;
  const pd = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(xml);
  const parts = xml.split("<sdnEntry>");
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].split("</sdnEntry>")[0];
    if (!block.includes("Digital Currency Address") && !block.includes("<idType>Website")) continue;
    const name = [tag(block, "firstName"), tag(block, "lastName")].filter(Boolean).join(" ");
    const uid = tag(block, "uid") || "";
    for (const m of block.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(m[1], "idType") || "";
      const number = tag(m[1], "idNumber");
      if (!number) continue;
      if (type.startsWith("Digital Currency Address")) {
        const k = EVM_RE.test(number) ? number.toLowerCase() : number.trim();
        (addresses[k] = addresses[k] || []).push([uid, name, type.replace(/^Digital Currency Address -\s*/, "")]);
        count++;
      } else if (type === "Website") {
        const dom = normDomain(number);
        if (dom) { (websites[dom] = websites[dom] || []).push([uid, name]); count++; }
      }
    }
  }
  const d = pd && /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(pd[1].trim());
  return { addresses, websites, count, publish_date: d ? `${d[3]}-${d[1]}-${d[2]}` : null };
}

// Accepts the raw texts, or already-parsed parts ({ parsed, sha256 }) so a refresh can drop each
// large file as soon as it is parsed (the two files are about 34 MB and 30 MB).
function buildBundle(cslIn, sdnIn, now) {
  const cslPart = typeof cslIn === "string" ? { parsed: parseCsl(cslIn), sha256: sha256(cslIn) } : cslIn;
  const sdnPart = typeof sdnIn === "string" ? { parsed: parseSdn(sdnIn), sha256: sha256(sdnIn) } : sdnIn;
  const csl = cslPart.parsed;
  const sdn = sdnPart.parsed;
  if (csl.entries.length < 1000) throw new Error("screening list has too few entries; keeping the last good copy");
  if (sdn.count < 100) throw new Error("SDN list has too few addresses and websites; keeping the last good copy");
  const body = {
    schema: SCHEMA,
    built_at: new Date(now).toISOString(),
    sources: [
      { id: "csl", title: "U.S. Consolidated Screening List (OFAC SDN and 10+ other U.S. lists), International Trade Administration", url: CSL_URL, last_updated: csl.last_updated, sha256: cslPart.sha256, count: csl.entries.length },
      { id: "ofac-sdn", title: "OFAC SDN list: digital currency addresses and websites, U.S. Treasury", url: SDN_URL, last_updated: sdn.publish_date, sha256: sdnPart.sha256, count: sdn.count },
    ],
    entries: csl.entries,
    addresses: sdn.addresses,
    websites: sdn.websites,
  };
  // The bundle's own fingerprint: sha256 of its JSON without this field.
  return { ...body, sha256: sha256(JSON.stringify(body)) };
}

function createLists({ dataDir, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 180_000 } = {}) {
  const file = dataDir ? path.join(dataDir, "screening-lists.json") : null;
  let bundle = null;
  let lastTry = 0;
  let refreshing = null;
  try { if (file) bundle = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }

  async function download(url) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: c.signal, headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      return await r.text();
    } finally { clearTimeout(t); }
  }

  async function refresh() {
    lastTry = now();
    // One file at a time, each dropped once parsed, to keep the container's memory low.
    let text = await download(CSL_URL);
    const cslPart = { parsed: parseCsl(text), sha256: sha256(text) };
    text = await download(SDN_URL);
    const sdnPart = { parsed: parseSdn(text), sha256: sha256(text) };
    text = null;
    const b = buildBundle(cslPart, sdnPart, now());
    bundle = b;
    if (file) {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(b));
      fs.renameSync(tmp, file);
    }
    return b;
  }

  return {
    // The current bundle; refreshed in the background when older than 12 hours (a failed refresh
    // is retried after 30 minutes). Waits only when there is no bundle at all.
    async get() {
      const age = bundle ? now() - Date.parse(bundle.built_at) : Infinity;
      if (age >= REFRESH_MS && now() - lastTry >= RETRY_MS && !refreshing) {
        refreshing = refresh().catch((e) => { console.error(JSON.stringify({ event: "lists.refresh_failed", error: String(e.message).slice(0, 200) })); return null; }).finally(() => { refreshing = null; });
      }
      if (!bundle && refreshing) await refreshing;
      return bundle;
    },
    peek() { return bundle ? { built_at: bundle.built_at, sha256: bundle.sha256, entries: bundle.entries.length, sources: bundle.sources.map((s) => ({ id: s.id, last_updated: s.last_updated, count: s.count })) } : null; },
  };
}

module.exports = { createLists, buildBundle, parseCsl, parseSdn, SCHEMA };
