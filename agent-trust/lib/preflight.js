// /v1/preflight: one call, every counterparty check, one verdict (agent-trust 1.4.0).
//
// The route runs the existing agent-trust checks (RDAP + DNS, live TLS, seller trust,
// the Consolidated Screening List, EVM address reputation), plus two new ones: the OFAC
// SDN wallet-address list (lib/sdn.js) and brand-protection's stored lookalike findings
// (read over the internal Docker network). Each check reports its own result:
//
//   pass | warn | fail | unknown | not_available,  method: definitive | heuristic
//
// Verdict: any definitive fail -> fail; else any heuristic fail or any warn -> warn;
// else any unknown -> unknown (unknown never counts as a pass); else pass.
// not_available means the check doesn't apply or we have no coverage; it is left out.
// This module has no network code of its own: the server passes in runners.
"use strict";

const crypto = require("crypto");
const { ClientError } = require("./http");

const BUDGET_MS = Number(process.env.PREFLIGHT_BUDGET_MS || 8000);
const CHAINS = ["eth", "base", "arbitrum", "polygon"];
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_RE = /^[A-Za-z0-9]{20,128}$/;

// --- input -----------------------------------------------------------------

function parseInput(body, isValidDomain) {
  const b = body && typeof body === "object" ? body : {};
  const str = (f, max) => {
    if (b[f] === undefined || b[f] === null) return null;
    if (typeof b[f] !== "string" || !b[f].trim() || b[f].length > max) throw new ClientError(422, "invalid_input", `field '${f}' must be a non-empty string of at most ${max} characters`);
    return b[f].trim();
  };
  const url = str("url", 2048);
  let domain = str("domain", 253);
  const address = str("address", 128);
  const name = str("name", 200);
  let chain = str("chain", 16);
  if (!url && !domain && !address && !name) throw new ClientError(422, "invalid_input", "give at least one of 'url', 'domain', 'address' or 'name'");

  let host = null;
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw new ClientError(422, "invalid_input", "field 'url' must be an absolute http(s) URL"); }
    if (!/^https?:$/.test(u.protocol)) throw new ClientError(422, "invalid_input", "field 'url' must be an absolute http(s) URL");
    host = u.hostname.toLowerCase();
    if (!isValidDomain(host)) throw new ClientError(422, "invalid_input", `could not read a domain name from 'url' (got '${host}')`);
  }
  if (domain) {
    domain = domain.toLowerCase().replace(/\.$/, "");
    if (!isValidDomain(domain)) throw new ClientError(422, "invalid_input", "field 'domain' must be a valid domain name (e.g. \"example.com\")");
    if (host && host !== domain) throw new ClientError(422, "invalid_input", `'domain' (${domain}) and the host of 'url' (${host}) differ; send one subject per call`);
  }
  domain = domain || host;

  if (address && !ADDRESS_RE.test(address)) throw new ClientError(422, "invalid_input", "field 'address' must be a wallet address (letters and digits, 20-128 characters)");
  const evm = !!(address && EVM_RE.test(address));
  if (chain) {
    chain = chain.toLowerCase();
    if (!CHAINS.includes(chain)) throw new ClientError(422, "invalid_input", `field 'chain' must be one of ${CHAINS.join(", ")}`);
    if (!evm) throw new ClientError(422, "invalid_input", "'chain' applies only to an EVM 0x address");
  }
  if (evm && !chain) chain = "eth";

  let since = null;
  if (b.since !== undefined && b.since !== null) {
    since = typeof b.since === "string" ? Date.parse(b.since) : NaN;
    if (!Number.isFinite(since)) throw new ClientError(422, "invalid_input", "field 'since' must be an RFC 3339 timestamp, e.g. 2026-11-01T00:00:00Z");
  }
  return { url, domain, address, evm, chain, name, since };
}

// --- one check ---------------------------------------------------------------

const check = (id, result, method, summary, extra = {}) => ({ id, result, method, summary, ...extra });

function domainChecks(dt, asked) {
  const reg = dt.registration || {};
  const out = [];
  const of = reg.looked_up_as ? ` (registered name ${reg.looked_up_as})` : "";
  // 1.6.0: a registry with no RDAP (e.g. .co) is unknown, never a fail: the name may well be registered.
  if (reg.registered === null) out.push(check("domain_registration", "unknown", "definitive", reg.reason || "the registration can't be read"));
  else if (!reg.registered) out.push(check("domain_registration", "fail", "definitive", "RDAP has no registration record for this domain"));
  else if (reg.days_until_expiration != null && reg.days_until_expiration < 0) out.push(check("domain_registration", "fail", "definitive", "the domain registration has expired"));
  else if (reg.age_days != null && reg.age_days < 30) out.push(check("domain_registration", "warn", "heuristic", `registered only ${reg.age_days} days ago`));
  else if (dt.trust_score < 40) out.push(check("domain_registration", "warn", "heuristic", `low registration trust score (${dt.trust_score}/100)`));
  else out.push(check("domain_registration", "pass", "definitive", (reg.age_days != null ? `registered ${reg.age_days} days ago; trust score ${dt.trust_score}/100` : `registered; trust score ${dt.trust_score}/100`) + of));
  const d = dt.dns || {};
  if (d.has_mx && !d.has_spf && !d.has_dmarc) out.push(check("dns_posture", "warn", "heuristic", "receives mail but publishes neither SPF nor DMARC, so mail from it is easy to fake"));
  else out.push(check("dns_posture", "pass", "definitive", [d.has_mx ? "MX" : "no MX", d.has_spf ? "SPF" : "no SPF", d.has_dmarc ? "DMARC" : "no DMARC"].join(", ")));
  out[0].data = { registered_name: (reg.looked_up_as || reg.ldh_name || "").toLowerCase() || null, trust_score: dt.trust_score, age_days: reg.age_days ?? null, days_until_expiration: reg.days_until_expiration ?? null };
  return { checks: out };
}

function tlsCheck(bv) {
  const c = bv.certificate || {};
  const data = { issuer: c.issuer_org || c.issuer_cn || null, valid_to: c.valid_to || null, days_until_expiry: c.days_until_expiry ?? null };
  if (!c.currently_valid) return check("tls_certificate", "fail", "definitive", "the TLS certificate is expired or not yet valid", { data });
  if (!c.san_covers_domain) return check("tls_certificate", "fail", "definitive", "the TLS certificate does not cover this domain name", { data });
  if (c.chain_authorized_by_node === false) return check("tls_certificate", "fail", "definitive", "the TLS certificate is not issued by a publicly trusted authority (self-signed or broken chain)", { data });
  if (c.days_until_expiry != null && c.days_until_expiry < 7) return check("tls_certificate", "warn", "definitive", `the TLS certificate expires in ${c.days_until_expiry} days`, { data });
  return check("tls_certificate", "pass", "definitive", `valid certificate from ${data.issuer || "a trusted issuer"}, ${c.days_until_expiry} days left`, { data });
}

function sellerCheck(st) {
  const data = { seller_trust_score: st.seller_trust_score, recommendation: st.recommendation, score_basis: st.score_basis || "registration_and_certificate" };
  const r = st.recommendation === "trusted" ? "pass" : st.recommendation === "proceed_with_caution" ? "warn" : "fail";
  const basis = st.score_basis === "certificate_only" ? "; certificate only, the registry can't be read" : "";
  return check("seller_trust", r, "heuristic", `seller trust ${st.seller_trust_score}/100 (${st.recommendation}${basis})`, { data });
}

function brandCheck(lk) {
  if (!lk) return check("brand_impersonation", "not_available", "heuristic", "the brand-protection lookup is not configured on this backend");
  if (lk.match === "official") {
    return check("brand_impersonation", "pass", "definitive", `this is an official domain of ${lk.brand.brand}, a brand we watch`, { data: { brand_id: lk.brand.brand_id } });
  }
  if (lk.match === "none") {
    return check("brand_impersonation", "not_available", "heuristic", `not a lookalike of any of the ${lk.watched_brands} brands we watch; brands we don't watch aren't covered`, { data: { watched_brands: lk.watched_brands } });
  }
  const f = lk.findings[0];
  const data = { brand_id: f.brand_id, brand: f.brand, official_domains: f.official_domains, risk: f.risk, risk_level: f.risk_level, status: f.status, first_seen: f.first_seen, report_as_of: f.report_as_of, brand_protection_evidence_id: f.evidence_id };
  const what = `a lookalike of ${f.brand} (${(f.official_domains || []).join(", ")}), risk ${f.risk}/100`;
  if (f.status === "no_longer_seen") return check("brand_impersonation", "pass", "heuristic", `was ${what.replace(/, risk.*/, "")}; no longer seen`, { data });
  if (f.risk_level === "high") return check("brand_impersonation", "fail", "heuristic", `${what}: high`, { data });
  if (f.risk_level === "medium") return check("brand_impersonation", "warn", "heuristic", `${what}: medium`, { data });
  if (f.risk_level === "unchecked") return check("brand_impersonation", "unknown", "heuristic", `${what.replace(/, risk.*/, "")}; only its DNS has been read so far`, { data });
  return check("brand_impersonation", "pass", "heuristic", `${what}: ${f.risk_level}`, { data });
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

function sanctionsNameCheck(sc, name) {
  const matches = (sc.matches || []).map((m) => ({ name: m.name, type: m.type, programs: m.programs, source: m.source }));
  if (!sc.match_count) return check("sanctions_name", "pass", "definitive", "no match on the U.S. Consolidated Screening List", { data: { match_count: 0 } });
  const exact = matches.some((m) => norm(m.name) === norm(name));
  return exact
    ? check("sanctions_name", "fail", "definitive", `exact name match on the U.S. Consolidated Screening List (${matches[0].source || "listed"})`, { data: { match_count: sc.match_count, matches } })
    : check("sanctions_name", "warn", "heuristic", `${sc.match_count} similar name${sc.match_count === 1 ? "" : "s"} on the U.S. Consolidated Screening List; review before dealing`, { data: { match_count: sc.match_count, matches } });
}

function sanctionsAddressCheck(s) {
  if (!s.loaded) return check("sanctions_address", "unknown", "definitive", `the OFAC SDN list is not loaded yet${s.error ? ` (${s.error})` : ""}`);
  const data = { list: "OFAC SDN (Digital Currency Address ids)", publish_date: s.publish_date, listed_addresses: s.listed_addresses };
  if (s.matches.length) {
    const m = s.matches[0];
    return check("sanctions_address", "fail", "definitive", `this address is on the OFAC SDN list (${m.name}, ${m.currency}, programs ${m.programs.join(", ")})`, { data: { ...data, matches: s.matches } });
  }
  return check("sanctions_address", "pass", "definitive", `not listed on the OFAC SDN list of ${s.publish_date}. This is an exact-address match only: no wallet clustering, so funds one hop away are not covered`, { data });
}

function reputationCheck(rep) {
  if (rep.not_found) return check("address_reputation", "warn", "heuristic", `no on-chain activity for this address on ${rep.chain}`);
  const data = { chain: rep.chain, reputation_score: rep.reputation_score, coverage: rep.coverage, is_contract: rep.is_contract, is_scam: rep.is_scam };
  if (rep.is_scam) return check("address_reputation", "fail", "heuristic", `the ${rep.chain} block explorer flags this address as a scam`, { data });
  if (rep.reputation_score < 15) return check("address_reputation", "warn", "heuristic", `little history on ${rep.chain} (reputation ${rep.reputation_score}/100); a new or idle address, not a confirmed risk`, { data });
  return check("address_reputation", "pass", "heuristic", `reputation ${rep.reputation_score}/100 on ${rep.chain} (${rep.coverage} coverage)`, { data });
}

// --- verdict ------------------------------------------------------------------

function verdictOf(checks) {
  const counted = checks.filter((c) => c.result !== "not_available");
  if (counted.some((c) => c.result === "fail" && c.method === "definitive")) return "fail";
  if (counted.some((c) => c.result === "fail" || c.result === "warn")) return "warn";
  if (!counted.length || counted.some((c) => c.result === "unknown")) return "unknown";
  return "pass";
}

const sha256 = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");

// Canonical, timing-free form of a check: what the hash and the change tracking compare.
const canonical = (c) => ({ id: c.id, result: c.result, method: c.method, summary: c.summary, data: c.data ?? null });

// --- change tracking for `since` ----------------------------------------------
// In memory: after a restart every check counts as changed once. Bounded.
const history = new Map();
const MAX_SUBJECTS = 5000;

function track(subjectKey, checks, nowIso) {
  let h = history.get(subjectKey);
  if (!h) {
    if (history.size >= MAX_SUBJECTS) history.delete(history.keys().next().value);
    h = new Map();
    history.set(subjectKey, h);
  }
  for (const c of checks) {
    const hash = sha256(canonical(c));
    const prev = h.get(c.id);
    if (!prev || prev.hash !== hash) h.set(c.id, { hash, changed_at: nowIso });
    c.evidence_hash = hash;
    c.changed_at = h.get(c.id).changed_at;
  }
}

// --- run ------------------------------------------------------------------------

// runners: { domainTrust(domain), brandVerify(domain), sellerTrust(url), sanctionsName(name),
//            sanctionsAddress(address, waitMs), reputation(chain, address), brandLookup(domain) | null }
// Each returns the existing route's response (or for the new sources their own shape) and may throw.
async function runPreflight(input, runners, { budgetMs = BUDGET_MS, now = () => Date.now() } = {}) {
  const started = now();
  const run = (label, fn) => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: label }), budgetMs); });
    return Promise.race([Promise.resolve().then(fn).then((v) => ({ v }), (e) => ({ e })), timeout]).finally(() => clearTimeout(timer));
  };
  const unknown = (id, why) => check(id, "unknown", "definitive", why);
  const why = (r, what) => (r.__timeout ? `${what} did not answer within ${budgetMs / 1000} s` : `${what} failed: ${String((r.e && r.e.message) || r.e).slice(0, 160)}`);

  const jobs = [];
  const add = (ids, label, fn, map) => jobs.push(run(label, fn).then((r) => (r.v !== undefined && !r.__timeout ? map(r.v) : ids.map((id) => unknown(id, why(r, label))))));

  if (input.domain) {
    add(["domain_registration", "dns_posture"], "the registration (RDAP) and DNS lookup", () => runners.domainTrust(input.domain), (v) => domainChecks(v, input.domain).checks);
    add(["tls_certificate"], "the TLS handshake", () => runners.brandVerify(input.domain), (v) => [tlsCheck(v)]);
    jobs.push(runners.brandLookup
      ? run("the brand-protection lookup", () => runners.brandLookup(input.domain)).then((r) => [r.v !== undefined && !r.__timeout ? brandCheck(r.v) : check("brand_impersonation", "unknown", "heuristic", why(r, "the brand-protection lookup"))])
      : Promise.resolve([brandCheck(null)]));
  }
  if (input.url) add(["seller_trust"], "the seller-trust check", () => runners.sellerTrust(input.url), (v) => [sellerCheck(v)]);
  if (input.name) {
    add(["sanctions_name"], "the Consolidated Screening List", () => runners.sanctionsName(input.name), (v) => [sanctionsNameCheck(v, input.name)]);
  }
  if (input.address) {
    add(["sanctions_address"], "the OFAC SDN list", () => runners.sanctionsAddress(input.address, Math.max(0, budgetMs - 500)), (v) => [sanctionsAddressCheck(v)]);
    if (input.evm) add(["address_reputation"], "the address reputation check", () => runners.reputation(input.chain, input.address), (v) => [reputationCheck(v)]);
    else jobs.push(Promise.resolve([check("address_reputation", "not_available", "heuristic", "reputation covers EVM 0x addresses only")]));
  }

  const checks = (await Promise.all(jobs)).flat();
  const nowIso = new Date(now()).toISOString();
  const subject = { url: input.url, domain: input.domain, address: input.address, chain: input.chain, name: input.name };
  track(sha256(subject), checks, nowIso);
  const verdict = verdictOf(checks);
  const order = { fail: 0, warn: 1, unknown: 2, pass: 3, not_available: 4 };
  const reasons = checks.filter((c) => c.result !== "pass" && c.result !== "not_available").sort((a, b) => order[a.result] - order[b.result]).map((c) => `${c.id}: ${c.result} - ${c.summary}`);
  const returned = input.since === null ? checks : checks.filter((c) => Date.parse(c.changed_at) > input.since);
  return {
    subject,
    verdict,
    verdict_rule: "fail if any definitive check fails; warn if a heuristic check fails or any check warns; unknown if any check could not answer (unknown never counts as a pass); otherwise pass. not_available checks are left out.",
    reasons: reasons.length ? reasons : ["every check that applies passed"],
    counts: Object.fromEntries(["pass", "warn", "fail", "unknown", "not_available"].map((k) => [k, checks.filter((c) => c.result === k).length])),
    since: input.since === null ? null : new Date(input.since).toISOString(),
    checks_total: checks.length,
    checks_returned: returned.length,
    checks: returned,
    evidence_hash: sha256({ subject, verdict, checks: checks.map(canonical) }),
    as_of: nowIso,
    duration_ms: now() - started,
    disclaimer: "Observed signals at the stated time, not legal advice or a finding of fraud. Screening is exact-match on the official U.S. lists; review any warn or fail before acting.",
  };
}

function _resetHistory() {
  history.clear();
}

module.exports = { parseInput, runPreflight, verdictOf, domainChecks, tlsCheck, sellerCheck, brandCheck, sanctionsNameCheck, sanctionsAddressCheck, reputationCheck, CHAINS, _resetHistory };
