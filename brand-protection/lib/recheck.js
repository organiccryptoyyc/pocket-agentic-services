// Live re-check of one domain: the engine under a paid evidence pack.
//
// A scan answers "which lookalikes of this brand exist?". A re-check answers
// "what does this one domain look like right now, and what can we show for it?".
// It reuses the scan's checks and the same bp-risk score, and adds what a record
// someone relies on needs: which checks really completed, retries for passing
// network failures, whether the signals corroborate each other, what changed
// since an earlier record, and a hash over the whole record.
//
// Library only: no route calls this yet. Raw page bytes are never kept, only
// derived fields and hashes, the same as the scan.
"use strict";

const { domainToASCII, domainToUnicode } = require("url");
const checks = require("./checks");
const fingerprint = require("./fingerprint");
const { splitDomain, brandKeywords } = require("./permute");
const { riskScore, titleTermsAreCommon, METHOD } = require("./score");
const { officialFingerprint } = require("./scan");

const SCHEMA = "bp-recheck/1";
const DEFAULT_DEADLINE_MS = 40_000;
const NETWORK_TRIES = 2;
const SECRET_TERM_RE = /seed|recovery|secret|private/i;
const SOURCE_ORDER = ["dns", "rdap", "tls", "http"];

// --- canonical hash ------------------------------------------------------------

// Sorted keys at every level, so the hash doesn't depend on key order.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function recordHash(record) {
  const { integrity, ...body } = record;
  return checks.sha256(canonicalJson(body));
}

// True when the record still matches its hash. This shows the record wasn't
// edited after hashing; it doesn't show who made it or that a page's claims are true.
function verifyRecord(record) {
  return !!record && !!record.integrity && record.integrity.record_sha256 === recordHash(record);
}

// --- running one check ----------------------------------------------------------

function withDeadline(promise, deadlineAt, label) {
  const left = deadlineAt - Date.now();
  if (left <= 0) return Promise.reject(new Error(`${label}: deadline passed before it started`));
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: did not finish before the deadline`)), left);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Runs one check, retrying once, and records how it went. The SSRF guard is never
// retried or swallowed: a private address must stop the probe.
async function runCheck(sources, kind, url, deadlineAt, fn, tries = NETWORK_TRIES) {
  const started_at = new Date().toISOString();
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const value = await withDeadline(Promise.resolve().then(fn), deadlineAt, kind);
      sources.push({ kind, url, fetched_at: started_at, finished_at: new Date().toISOString(), ok: true, tries: attempt });
      return value;
    } catch (e) {
      if (e.isSsrfGuard) throw e;
      lastError = e;
      if (Date.now() >= deadlineAt) {
        sources.push({ kind, url, fetched_at: started_at, finished_at: new Date().toISOString(), ok: false, tries: attempt, error: String(e.message).slice(0, 200) });
        return null;
      }
    }
  }
  sources.push({ kind, url, fetched_at: started_at, finished_at: new Date().toISOString(), ok: false, tries, error: String(lastError.message).slice(0, 200) });
  return null;
}

// --- what completed -------------------------------------------------------------

function sourceState(sources, kind) {
  const s = sources.find((x) => x.kind === kind);
  if (!s) return "not_attempted";
  return s.ok ? "ok" : "failed";
}

function completeness({ sources, probe, ips, rdap, page, refused }) {
  const state = {
    dns: sourceState(sources, "dns"),
    rdap: sourceState(sources, "rdap"),
    tls: sourceState(sources, "tls"),
    http: sourceState(sources, "http"),
  };
  if (state.rdap === "ok" && rdap && rdap.available === false) state.rdap = "no_rdap_server";
  if (page && page.skipped === "robots_txt") state.http = "skipped_robots_txt";
  else if (state.http === "ok" && page && !page.reachable) state.http = "unreachable";

  const missing = [];
  if (state.dns !== "ok") missing.push("dns");
  if (state.rdap !== "ok") missing.push("rdap");
  if (probe && probe.exists && ips.length > 0 && state.http !== "ok") missing.push("http");
  // A closed port 443 is a real answer when the page was read over HTTP, so TLS alone doesn't count as missing.
  if (refused) missing.push("refused_private_address");
  return { ...state, complete: missing.length === 0, missing };
}

// --- do the signals back each other up? ------------------------------------------

// A brand that is an ordinary word (curve, pocket) puts its name on unrelated
// pages. The name alone is weak; the score stays as it is, and this says what
// the score rests on.
function corroboration({ rdap, cert, page, official, status }) {
  const strong = [];
  const weak = [];
  const reachable = page && page.reachable && !page.skipped;
  if (reachable) {
    const terms = page.wallet_terms || [];
    const asksSecret = terms.some((t) => SECRET_TERM_RE.test(t));
    if (official && official.icon_sha256 && page.icon_sha256 === official.icon_sha256) strong.push("site icon identical to the official site's");
    if (official && official.title && page.title === official.title) strong.push("page title identical to the official site's");
    if (asksSecret) strong.push("page mentions a seed, recovery or secret phrase or a private key");
    if (page.wallet_prompt && page.brand_in_title && !asksSecret) strong.push("page names the brand in its title and prompts for a wallet");
    if (page.brand_in_title && !titleTermsAreCommon(page)) strong.push("page title names a distinctive brand name");
    else if (page.brand_in_title) weak.push("page title contains the brand word, which is also a common word");
    else if (page.brand_in_page) weak.push("page text contains the brand word");
    if (page.wallet_prompt && !page.brand_in_title && !asksSecret) weak.push("page mentions a wallet, without the brand in its title");
    // Any shop with accounts has a password field, so this never corroborates by itself.
    if (page.has_password_form) weak.push("page has a password field");
  }
  if (rdap && rdap.registered && rdap.age_days != null && rdap.age_days <= 30) weak.push("registered in the last 30 days");
  if (cert && cert.currently_valid && cert.issued_days_ago != null && cert.issued_days_ago <= 30) weak.push("TLS certificate issued in the last 30 days");

  let summary;
  if (status === "redirects_to_official" || status === "likely_brand_owned") summary = "likely_brand_owned";
  else if (status === "parked") summary = "parked";
  else if (strong.length > 0) summary = "corroborated";
  else if (weak.length > 0) summary = "weak_signals_only";
  else summary = "no_signals";
  return { summary, strong, weak };
}

// --- what changed since an earlier record -----------------------------------------

const COMPARED_FIELDS = [
  ["dns.ns", (r) => r.dns && r.dns.ns, "set"],
  ["dns.mx", (r) => r.dns && r.dns.mx, "set"],
  ["dns.a", (r) => r.dns && r.dns.a, "set", "CDN addresses rotate; a change here alone means little"],
  ["dns.aaaa", (r) => r.dns && r.dns.aaaa, "set", "CDN addresses rotate; a change here alone means little"],
  ["rdap.registered_at", (r) => r.rdap && r.rdap.registered_at, "value"],
  ["rdap.expires_at", (r) => r.rdap && r.rdap.expires_at, "value"],
  ["rdap.registrar", (r) => r.rdap && r.rdap.registrar, "value"],
  ["certificate.sha256_fingerprint", (r) => r.certificate && r.certificate.sha256_fingerprint, "value"],
  ["certificate.issuer_org", (r) => r.certificate && r.certificate.issuer_org, "value"],
  ["homepage.sha256", (r) => r.homepage && r.homepage.sha256, "value", "dynamic pages change on every load; a change here alone means little"],
  ["homepage.icon_sha256", (r) => r.homepage && r.homepage.icon_sha256, "value"],
  ["homepage.title", (r) => r.homepage && r.homepage.title, "value"],
  ["homepage.final_host", (r) => r.homepage && r.homepage.final_host, "value"],
  ["homepage.wallet_prompt", (r) => r.homepage && r.homepage.wallet_prompt, "value"],
  ["homepage.has_password_form", (r) => r.homepage && r.homepage.has_password_form, "value"],
  ["homepage.parked", (r) => r.homepage && r.homepage.parked, "value"],
];

// A value we couldn't read on either side is "not comparable", never "changed":
// a failed fetch must not look like the site changed.
function compareRecords(previous, current) {
  const changed = [];
  const not_comparable = [];
  let unchanged = 0;
  for (const [field, get, kind, note] of COMPARED_FIELDS) {
    const before = get(previous);
    const now = get(current);
    if (before == null || now == null) {
      not_comparable.push(field);
      continue;
    }
    const same = kind === "set"
      ? canonicalJson([...before].sort()) === canonicalJson([...now].sort())
      : before === now;
    if (same) unchanged++;
    else changed.push({ field, from: before, to: now, ...(note ? { note } : {}) });
  }
  return {
    compared_to: {
      id: previous.record_id || previous.evidence_id || null,
      observed_at: previous.checked_at || previous.collected_at || null,
    },
    changed,
    unchanged_fields: unchanged,
    not_comparable,
  };
}

// DNS only says what is being served right now. The registry decides whether a name
// is registered, so an empty DNS answer doesn't get to say "not registered" by itself.
function scoreWithoutDns({ probe, rdap, official }) {
  if (rdap && rdap.registered) {
    const r = riskScore({ dns: { ...probe, exists: true, resolves: false }, rdap, cert: null, page: null, official, ct: null });
    const reasons = ["registered at the registry, but DNS returns nothing right now (+5)", ...r.reasons.slice(1)];
    return { ...r, status: "registered_no_dns", reasons };
  }
  if (rdap && rdap.available && rdap.registered === false) return riskScore({ dns: probe, rdap, cert: null, page: null, official, ct: null });
  return { score: 0, level: "none", status: "not_in_dns_registry_unknown", reasons: ["no DNS records, and the registry could not confirm whether the name is registered"], method: METHOD };
}

// --- the re-check -----------------------------------------------------------------

/**
 * request: { domain, official_domains?: [], keywords?: [], brand? }
 * opts:    { deadlineMs, previous: an earlier re-check or evidence record for this domain }
 */
async function recheckDomain(request, opts = {}) {
  const started = Date.now();
  const deadlineAt = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const domain = domainToASCII(String(request.domain || "").trim().toLowerCase());
  if (!checks.isValidDomain(domain)) {
    const err = new Error(`'${request.domain}' is not a valid domain name`);
    err.isInvalidInput = true;
    throw err;
  }
  const official = (request.official_domains || []).map((d) => domainToASCII(String(d).trim().toLowerCase())).filter(checks.isValidDomain);
  const keywords = official.length ? brandKeywords(official, request.keywords || []) : (request.keywords || []).map((k) => String(k).toLowerCase());
  const checked_at = new Date().toISOString();
  const sources = [];

  const officialFp = official.length ? await officialFingerprint(official, keywords) : null;
  const brandCompared = !!(officialFp && (officialFp.title || officialFp.icon_sha256));

  const probe = await runCheck(sources, "dns", `dns:${domain}`, deadlineAt, async () => {
    const p = await checks.dnsProbe(domain);
    if (p.error && !p.exists) throw new Error(`DNS lookup failed: ${p.error}`);
    return p;
  });

  let ips = [];
  let refused = null;
  if (probe) {
    try {
      ips = checks.publicIps(probe);
    } catch (e) {
      if (!e.isSsrfGuard) throw e;
      refused = e.message;
    }
  }

  // RDAP asks about the registered name, never a subdomain, and is only a request to the registry.
  const registrable = (splitDomain(domain) || {}).registrable || domain;
  const rdapPromise = runCheck(sources, "rdap", `rdap:${registrable}`, deadlineAt, () => checks.rdapLookup(registrable, { detail: true }), 1);
  let cert = null;
  let page = null;
  if (ips.length > 0 && !refused) {
    try {
      [cert, page] = await Promise.all([
        runCheck(sources, "tls", `tls:${domain}:443`, deadlineAt, () => checks.tlsCertInfo(domain, ips[0], { detail: true })),
        runCheck(sources, "http", `https://${domain}/`, deadlineAt, () => fingerprint.homepage(domain, keywords, { detail: true })),
      ]);
    } catch (e) {
      if (!e.isSsrfGuard) throw e;
      refused = e.message;
    }
  }
  const rdap = await rdapPromise;

  const done = completeness({ sources, probe, ips, rdap, page, refused });
  let risk;
  if (refused) risk = { score: 0, level: "none", status: "refused_private_address", reasons: [refused], method: METHOD };
  else if (!probe) risk = { score: 0, level: "unchecked", status: "dns_failed", reasons: ["DNS could not be read, so nothing can be said about this name"], method: METHOD };
  else if (!probe.exists) risk = scoreWithoutDns({ probe, rdap, official: officialFp });
  else risk = riskScore({ dns: probe, rdap, cert, page, official: officialFp, ct: null });

  // A missing check can only hide signals, so the score is a floor. A floor that
  // already reads medium or high stands; a lower one isn't a clean result.
  const floor = !done.complete && !refused;
  const risk_level = floor && (risk.level === "low" || risk.level === "none") ? "unchecked" : risk.level;

  const record = {
    schema: SCHEMA,
    record_id: checks.sha256(`${domain}|${checked_at}`).slice(0, 24),
    domain,
    ...(domain.includes("xn--") ? { unicode: domainToUnicode(domain) } : {}),
    brand: request.brand || null,
    official_domains: official,
    checked_at,
    method: METHOD,
    completeness: done,
    assessment: {
      risk: risk.score,
      risk_level,
      risk_is_floor: floor,
      status: risk.status,
      reasons: risk.reasons,
      brand_comparison: brandCompared
        ? "compared"
        : official.length ? "official_site_unavailable" : "no_official_domain_given",
      corroboration: corroboration({ rdap, cert, page, official: officialFp, status: risk.status }),
    },
    sources: [...sources].sort((a, b) => SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind)),
    dns: probe ? { a: probe.a, aaaa: probe.aaaa, mx: probe.mx, ns: probe.ns, nxdomain: probe.nxdomain } : null,
    rdap,
    certificate: cert,
    homepage: page,
    note: "Observed signals, not a finding of fraud. Raw page content isn't kept; hashes and derived fields only.",
  };
  if (opts.previous) record.changes = compareRecords(opts.previous, record);
  record.duration_ms = Date.now() - started;
  record.integrity = { algorithm: "sha256-canonical-json", record_sha256: recordHash(record) };
  return record;
}

module.exports = { SCHEMA, recheckDomain, compareRecords, corroboration, canonicalJson, recordHash, verifyRecord };
