// Agent Trust and Compliance — a Pocket Network service.
//
// Five endpoints an autonomous agent can call before it trusts a
// counterparty domain or address: domain registration/DNS trust signals
// (RDAP + DNS), a live TLS certificate check, a composite "should I pay
// this resource server" seller-trust score, a U.S. Consolidated Screening
// List sanctions lookup, and an EVM address reputation check backed by
// public Blockscout explorer instances. Every check is a real live protocol
// call or documented external API — nothing here is simulated or looked up
// from a bundled static list. See README.md "Verification" for exactly
// which pieces were interactively confirmed against live endpoints during
// this build and which (the Consolidated Screening List response shape)
// still need an operator spot-check before production use, and why.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const checks = require("./lib/checks");
const { cached } = require("./lib/net");

const SERVICE = "agent-trust";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

function requireDomain(body, field = "domain") {
  const v = body?.[field];
  if (typeof v !== "string" || !checks.isValidDomain(v.trim().toLowerCase())) {
    throw new ClientError(422, "invalid_input", `field '${field}' must be a valid domain name (e.g. "example.com")`);
  }
  return v.trim().toLowerCase();
}

function requireNonEmptyString(body, field) {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ClientError(422, "invalid_input", `field '${field}' is required and must be a non-empty string`);
  }
  return v.trim();
}

function withMeta(payload, cacheInfo) {
  return {
    service: SERVICE,
    fetched_at: new Date().toISOString(),
    cache: { stale: !!cacheInfo.stale, age_ms: cacheInfo.ageMs },
    ...payload,
  };
}

function toClientError(e) {
  if (e.isSsrfGuard) return new ClientError(422, "refused_target", e.message);
  if (e.notConfigured) return new ClientError(422, "not_configured", e.message);
  if (e.isClientError) return new ClientError(422, "invalid_input", e.message);
  return e; // let http.js's catch-all turn any other UpstreamError into a sanitized 422
}

// --- scoring (deterministic: same live inputs -> same score everywhere) ----

function scoreDomainTrust(rdap, dns) {
  if (!rdap.registered) return { score: 0, reasons: ["domain is not registered or RDAP has no record for it"] };
  const reasons = [];
  let score = 0;
  if (rdap.age_days != null) {
    const agePts = Math.min(40, Math.log10(1 + Math.max(0, rdap.age_days)) * 13);
    score += agePts;
    reasons.push(`registered ${rdap.age_days}d ago (+${agePts.toFixed(1)})`);
  }
  if (dns.has_mx) { score += 10; reasons.push("has MX records (+10)"); }
  if (dns.has_spf) { score += 5; reasons.push("has SPF record (+5)"); }
  if (dns.has_dmarc) { score += 5; reasons.push("has DMARC record (+5)"); }
  if (rdap.has_secure_dns) { score += 10; reasons.push("DNSSEC signed (+10)"); }
  if ((rdap.status || []).some((s) => /prohibited/i.test(s))) { score += 10; reasons.push("registrar transfer/update lock present (+10)"); }
  if (rdap.nameserver_count >= 2) { score += 10; reasons.push("2+ nameservers (+10)"); }
  if (rdap.days_until_expiration != null) {
    if (rdap.days_until_expiration < 0) { score -= 30; reasons.push("registration has EXPIRED (-30)"); }
    else if (rdap.days_until_expiration < 7) { score -= 20; reasons.push(`expires in ${rdap.days_until_expiration}d (-20)`); }
    else if (rdap.days_until_expiration > 30) { score += 10; reasons.push("not expiring soon (+10)"); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)), reasons };
}

function scoreBrandVerify(cert, rdap, brandName) {
  const reasons = [];
  let score = 0;
  if (cert.currently_valid) { score += 40; reasons.push("TLS certificate is currently valid (+40)"); }
  else reasons.push("TLS certificate is NOT currently valid (+0)");
  if (cert.organization_validated) { score += 25; reasons.push("certificate is organization-validated, not just domain-validated (+25)"); }
  if (cert.san_covers_domain) { score += 15; reasons.push("certificate SAN covers the requested domain (+15)"); }
  if (rdap.registered && rdap.age_days != null) {
    const agePts = Math.min(20, Math.log10(1 + Math.max(0, rdap.age_days)) * 6.5);
    score += agePts;
    reasons.push(`domain registered ${rdap.age_days}d ago (+${agePts.toFixed(1)})`);
  }
  let brandMatch = null;
  if (brandName) {
    const needle = brandName.trim().toLowerCase();
    const haystack = `${cert.subject_org || ""} ${cert.subject_cn || ""}`.toLowerCase();
    brandMatch = haystack.includes(needle);
    reasons.push(brandMatch ? `certificate identity mentions '${brandName}'` : `certificate identity does NOT mention '${brandName}' — verify before trusting this is the claimed brand`);
  }
  return { score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)), reasons, brand_name_match: brandMatch };
}

// --- /v1/domain-trust --------------------------------------------------------

async function handleDomainTrust(body) {
  const domain = requireDomain(body);
  const cacheKey = `domain-trust:${domain}`;
  const { value, stale, ageMs } = await cached(cacheKey, 3_600_000, async () => {
    try {
      await checks.resolveSafely(domain);
    } catch (e) {
      throw toClientError(e);
    }
    const [rdap, dns] = await Promise.all([checks.rdapLookup(domain), checks.dnsSignals(domain)]);
    const { score, reasons } = scoreDomainTrust(rdap, dns);
    return { domain, trust_score: score, trust_score_scale: "0-100, higher is more trustworthy", registration: rdap, dns, reasons };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/brand-verify --------------------------------------------------------

async function handleBrandVerify(body) {
  const domain = requireDomain(body);
  const brandName = body?.brand_name != null ? requireNonEmptyString(body, "brand_name") : null;
  const cacheKey = `brand-verify:${domain}:${brandName || ""}`;
  const { value, stale, ageMs } = await cached(cacheKey, 900_000, async () => {
    let ips;
    try {
      ips = await checks.resolveSafely(domain);
    } catch (e) {
      throw toClientError(e);
    }
    const [cert, rdap] = await Promise.all([checks.tlsCertInfo(domain, ips[0]), checks.rdapLookup(domain)]);
    const { score, reasons, brand_name_match } = scoreBrandVerify(cert, rdap, brandName);
    return { domain, brand_name: brandName, brand_verify_score: score, brand_verify_score_scale: "0-100, higher is more trustworthy", brand_name_match, certificate: cert, reasons };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/seller-trust: composite over a resource-server URL -----------------

async function handleSellerTrust(body) {
  const rawUrl = requireNonEmptyString(body, "url");
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new ClientError(422, "invalid_input", `field 'url' must be a valid absolute URL, got ${JSON.stringify(rawUrl)}`);
  }
  if (!checks.isValidDomain(hostname)) {
    throw new ClientError(422, "invalid_input", `could not extract a valid domain from 'url' (got hostname '${hostname}')`);
  }
  const cacheKey = `seller-trust:${hostname}`;
  const { value, stale, ageMs } = await cached(cacheKey, 900_000, async () => {
    let ips;
    try {
      ips = await checks.resolveSafely(hostname);
    } catch (e) {
      throw toClientError(e);
    }
    const [rdap, dns, cert] = await Promise.all([checks.rdapLookup(hostname), checks.dnsSignals(hostname), checks.tlsCertInfo(hostname, ips[0])]);
    const domainTrust = scoreDomainTrust(rdap, dns);
    const brand = scoreBrandVerify(cert, rdap, null);
    const composite = Math.round((domainTrust.score * 0.4 + brand.score * 0.6) * 10) / 10;
    const recommendation = composite >= 70 ? "trusted" : composite >= 40 ? "proceed_with_caution" : "high_risk";
    return {
      url: rawUrl,
      hostname,
      seller_trust_score: composite,
      seller_trust_score_scale: "0-100, higher is more trustworthy",
      recommendation,
      domain_trust: { score: domainTrust.score, reasons: domainTrust.reasons },
      certificate_trust: { score: brand.score, reasons: brand.reasons, certificate: cert },
      methodology: "40% domain-registration/DNS trust + 60% live TLS certificate trust, both computed fresh from the " +
        "domain's real current state. Deterministic for the same live state; not a guarantee of business legitimacy.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/sanctions-check ------------------------------------------------------

async function handleSanctionsCheck(body) {
  const query = requireNonEmptyString(body, "address");
  const cacheKey = `sanctions-check:${query.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 21_600_000, async () => {
    let result;
    try {
      result = await checks.screeningSearch(query);
    } catch (e) {
      throw toClientError(e);
    }
    return {
      query,
      sanctioned: result.total > 0,
      match_count: result.total,
      matches: result.matches,
      source: "U.S. Consolidated Screening List (International Trade Administration, data.trade.gov) — " +
        "aggregates OFAC SDN and 10+ other U.S. restricted-party lists.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/reputation: EVM address, via public Blockscout instances -----------

async function handleReputation(body) {
  const chain = requireNonEmptyString(body, "chain").toLowerCase();
  const address = requireNonEmptyString(body, "address");
  const cacheKey = `reputation:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 300_000, async () => {
    let r;
    try {
      r = await checks.blockscoutAddress(chain, address);
    } catch (e) {
      throw toClientError(e);
    }
    if (!r.found) throw new ClientError(404, "not_found", `no on-chain activity found for '${address}' on '${chain}'`);
    let score = 0;
    const reasons = [];
    if (r.is_scam) { score = 0; reasons.push("flagged as scam by the block explorer (score forced to 0)"); }
    else {
      if (r.reputation === "ok") { score += 30; reasons.push("explorer reputation flag is 'ok' (+30)"); }
      if (r.is_verified) { score += 15; reasons.push("contract source is verified (+15)"); }
      const txPts = r.transactions_count != null ? Math.min(35, Math.log10(1 + r.transactions_count) * 8) : 0;
      score += txPts;
      if (txPts > 0) reasons.push(`${r.transactions_count} transactions observed (+${txPts.toFixed(1)})`);
      if (r.public_tags.length > 0) { score += 10; reasons.push(`has public tag(s): ${r.public_tags.join(", ")} (+10)`); }
      if (r.ens_name) { score += 10; reasons.push(`has ENS name '${r.ens_name}' (+10)`); }
    }
    return {
      chain, address,
      reputation_score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
      reputation_score_scale: "0-100, higher is more trustworthy",
      is_contract: r.is_contract, is_verified: r.is_verified, is_scam: r.is_scam,
      transactions_count: r.transactions_count, token_transfers_count: r.token_transfers_count,
      public_tags: r.public_tags, ens_name: r.ens_name,
      reasons,
      note: "EVM chains only in this version (" + Object.keys(checks.BLOCKSCOUT_HOSTS).join(", ") + "); " +
        "sourced from the chain's public Blockscout instance, not a proprietary reputation database.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- wiring ------------------------------------------------------------------

const routes = new Map([
  ["POST /v1/domain-trust", handleDomainTrust],
  ["POST /v1/brand-verify", handleBrandVerify],
  ["POST /v1/seller-trust", handleSellerTrust],
  ["POST /v1/sanctions-check", handleSanctionsCheck],
  ["POST /v1/reputation", handleReputation],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`);
});
