// Real, live checks this backend performs. No fabricated or simulated data:
// every signal here comes from a real protocol call (RDAP, DNS, a live TLS
// handshake, or a documented external API) made at request time.
"use strict";

const dns = require("dns").promises;
const tls = require("tls");
const net = require("net");
const { fetchJSON, withRetry, UpstreamError } = require("./net");

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function isValidDomain(domain) {
  return typeof domain === "string" && DOMAIN_RE.test(domain);
}

// --- SSRF guard ------------------------------------------------------------
// This backend makes outbound DNS/TLS connections to a caller-supplied
// hostname (domain-trust, brand-verify, seller-trust). Refuse to connect to
// anything that resolves to a private, loopback, link-local, or otherwise
// non-public address, so the service cannot be used to probe internal
// infrastructure from wherever the supplier happens to run it.
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1") return true; // loopback
    if (low.startsWith("fe80:") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local
    if (low.startsWith("::ffff:")) return isPrivateOrReservedIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // unrecognized: refuse rather than risk it
}

async function resolveSafely(domain) {
  let addresses;
  try {
    addresses = await dns.lookup(domain, { all: true, verbatim: true });
  } catch (e) {
    throw new UpstreamError(`could not resolve '${domain}': ${e.code || e.message}`);
  }
  if (addresses.length === 0) throw new UpstreamError(`no addresses for '${domain}'`);
  const bad = addresses.find((a) => isPrivateOrReservedIp(a.address));
  if (bad) {
    const err = new UpstreamError(`'${domain}' resolves to a private/reserved address (${bad.address}); refusing to probe`);
    err.isSsrfGuard = true;
    throw err;
  }
  return addresses.map((a) => a.address);
}

// --- RDAP (domain registration data) ---------------------------------------

async function rdapLookup(domain) {
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  const res = await withRetry(() => fetchJSON(url));
  if (!res.ok) {
    if (res.status === 404) return { registered: false };
    throw new UpstreamError(`RDAP lookup for '${domain}' failed: HTTP ${res.status}`);
  }
  const j = res.body;
  const events = Object.fromEntries((j.events || []).map((e) => [e.eventAction, e.eventDate]));
  const now = Date.now();
  const registrationDate = events.registration ? new Date(events.registration) : null;
  const expirationDate = events.expiration ? new Date(events.expiration) : null;
  return {
    registered: true,
    ldh_name: j.ldhName || domain,
    status: j.status || [],
    nameserver_count: (j.nameservers || []).length,
    has_secure_dns: !!(j.secureDNS && j.secureDNS.delegationSigned),
    registered_at: events.registration || null,
    expires_at: events.expiration || null,
    last_changed_at: events["last changed"] || null,
    age_days: registrationDate ? Math.floor((now - registrationDate.getTime()) / 86_400_000) : null,
    days_until_expiration: expirationDate ? Math.floor((expirationDate.getTime() - now) / 86_400_000) : null,
  };
}

// --- DNS signals -------------------------------------------------------------

async function dnsSignals(domain) {
  const [mx, txt, a] = await Promise.all([
    dns.resolveMx(domain).catch(() => []),
    dns.resolveTxt(domain).catch(() => []),
    dns.resolve4(domain).catch(() => []),
  ]);
  const txtFlat = txt.map((parts) => parts.join(""));
  return {
    has_mx: mx.length > 0,
    mx_count: mx.length,
    has_spf: txtFlat.some((t) => t.toUpperCase().startsWith("V=SPF1")),
    has_dmarc: await dns.resolveTxt(`_dmarc.${domain}`).then((r) => r.length > 0).catch(() => false),
    a_record_count: a.length,
  };
}

// --- Live TLS certificate -----------------------------------------------------

function tlsCertInfo(domain, resolvedIp) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: resolvedIp, servername: domain, port: 443, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || Object.keys(cert).length === 0) {
          return reject(new UpstreamError(`no certificate presented by '${domain}'`));
        }
        const now = Date.now();
        const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const sans = (cert.subjectaltname || "").split(",").map((s) => s.trim().replace(/^DNS:/, ""));
        resolve({
          subject_cn: cert.subject?.CN || null,
          subject_org: cert.subject?.O || null,
          issuer_cn: cert.issuer?.CN || null,
          issuer_org: cert.issuer?.O || null,
          valid_from: cert.valid_from || null,
          valid_to: cert.valid_to || null,
          currently_valid: !!(validFrom && validTo && now >= validFrom.getTime() && now <= validTo.getTime()),
          days_until_expiry: validTo ? Math.floor((validTo.getTime() - now) / 86_400_000) : null,
          san_covers_domain: sans.includes(domain) || sans.some((s) => s.startsWith("*.") && domain.endsWith(s.slice(1))),
          organization_validated: !!(cert.subject?.O && cert.subject.O.trim() !== ""),
          chain_authorized_by_node: !!socket.authorized,
        });
      }
    );
    socket.on("error", (e) => reject(new UpstreamError(`TLS handshake with '${domain}' failed: ${e.message}`)));
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new UpstreamError(`TLS handshake with '${domain}' timed out`));
    });
  });
}

// --- U.S. Consolidated Screening List (OFAC SDN + other restricted-party lists) --
//
// Official API: https://developer.trade.gov (International Trade Administration).
// Requires a free operator-supplied subscription key (TRADE_GOV_SUBSCRIPTION_KEY);
// this backend never ships or assumes one. The exact response field names below
// were not independently re-verified against a live authenticated call during
// this build (the sandbox this was built in has no way to obtain a key), so an
// operator should spot-check one known-sanctioned query against the live API
// before relying on this in production — see README.md "Verification".

async function screeningSearch(query) {
  const key = process.env.TRADE_GOV_SUBSCRIPTION_KEY;
  if (!key) {
    const e = new UpstreamError("TRADE_GOV_SUBSCRIPTION_KEY is not configured on this backend");
    e.notConfigured = true;
    throw e;
  }
  const url = `https://data.trade.gov/consolidated_screening_list/v1/search?q=${encodeURIComponent(query)}`;
  const res = await withRetry(() => fetchJSON(url, { headers: { "Subscription-Key": key, "Ocp-Apim-Subscription-Key": key } }));
  if (!res.ok) {
    throw new UpstreamError(`Consolidated Screening List query failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  const body = res.body || {};
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    total: typeof body.total === "number" ? body.total : results.length,
    matches: results.slice(0, 10).map((r) => ({
      name: r.name ?? null,
      type: r.type ?? null,
      programs: r.programs ?? null,
      source: r.source ?? r.source_list_url ?? null,
      raw: r,
    })),
  };
}

// --- EVM address reputation via public Blockscout instances ------------------

const BLOCKSCOUT_HOSTS = {
  eth: "eth.blockscout.com",
  base: "base.blockscout.com",
  arbitrum: "arbitrum.blockscout.com",
  polygon: "polygon.blockscout.com",
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

async function blockscoutAddress(chain, address) {
  const host = BLOCKSCOUT_HOSTS[chain];
  if (!host) {
    const e = new UpstreamError(`unsupported chain '${chain}'; supported: ${Object.keys(BLOCKSCOUT_HOSTS).join(", ")}`);
    e.isClientError = true;
    throw e;
  }
  if (!EVM_ADDRESS_RE.test(address)) {
    const e = new UpstreamError(`'${address}' is not a well-formed EVM address`);
    e.isClientError = true;
    throw e;
  }
  const [addrRes, countersRes] = await Promise.all([
    withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}`)),
    withRetry(() => fetchJSON(`https://${host}/api/v2/addresses/${address}/counters`)),
  ]);
  if (!addrRes.ok) {
    if (addrRes.status === 404) return { found: false, chain, address };
    throw new UpstreamError(`Blockscout (${host}) address lookup failed: HTTP ${addrRes.status}`);
  }
  const a = addrRes.body;
  const c = countersRes.ok ? countersRes.body : {};
  return {
    found: true,
    chain,
    address,
    is_contract: !!a.is_contract,
    is_verified: !!a.is_verified,
    is_scam: !!a.is_scam,
    reputation: a.reputation ?? null,
    public_tags: (a.public_tags || []).map((t) => t.display_name || t.label || t),
    ens_name: a.ens_domain_name || null,
    coin_balance_wei: a.coin_balance ?? null,
    transactions_count: c.transactions_count != null ? Number(c.transactions_count) : null,
    token_transfers_count: c.token_transfers_count != null ? Number(c.token_transfers_count) : null,
  };
}

module.exports = {
  isValidDomain,
  isPrivateOrReservedIp,
  resolveSafely,
  rdapLookup,
  dnsSignals,
  tlsCertInfo,
  screeningSearch,
  blockscoutAddress,
  BLOCKSCOUT_HOSTS,
  EVM_ADDRESS_RE,
};
