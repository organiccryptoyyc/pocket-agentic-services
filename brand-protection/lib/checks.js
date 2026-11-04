// Live network checks: DNS, RDAP (straight from the registry), a TLS
// handshake, and one homepage fetch. Every signal comes from a real call made
// at scan time; nothing is looked up from a third-party threat feed (the
// phase 0 terms check excluded all free feeds for commercial use).
//
// SSRF guard and TLS handshake are copied from agent-trust/lib/checks.js.
"use strict";

const dnsp = require("dns").promises;
const tls = require("tls");
const net = require("net");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { fetchJSON, withRetry, cached, UpstreamError } = require("./net");

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const USER_AGENT = "brand-protection/0.1 (+https://github.com/organiccryptoyyc/pocket-agentic-services)";
const DNS_TIMEOUT_MS = Number(process.env.BP_DNS_TIMEOUT_MS || 2500);
const HTTP_TIMEOUT_MS = Number(process.env.BP_HTTP_TIMEOUT_MS || 8000);
const MAX_PAGE_BYTES = 512 * 1024;

function isValidDomain(domain) {
  return typeof domain === "string" && DOMAIN_RE.test(domain);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// --- SSRF guard --------------------------------------------------------------
// We connect to domains that callers (and lookalike generation) name. Refuse
// anything that resolves to a private, loopback, link-local or reserved address.
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (/^fe[89ab]/.test(low)) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateOrReservedIp(low.slice(7));
    return false;
  }
  return true;
}

function guardError(domain, ip) {
  const err = new UpstreamError(`'${domain}' resolves to a private/reserved address (${ip}); refusing to probe`);
  err.isSsrfGuard = true;
  return err;
}

// --- DNS -----------------------------------------------------------------------

function resolver() {
  const r = new dnsp.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  if (process.env.BP_DNS_SERVERS) r.setServers(process.env.BP_DNS_SERVERS.split(","));
  return r;
}

// Does the name exist and where does it point? `registered` is a DNS-level
// guess (NXDOMAIN = not registered); RDAP is the authority on registration.
async function dnsProbe(domain) {
  const r = resolver();
  const out = { domain, a: [], aaaa: [], mx: [], ns: [], nxdomain: false, error: null };
  const one = async (fn, key) => {
    try {
      out[key] = await fn;
    } catch (e) {
      if (e.code === "ENOTFOUND" || e.code === "NXDOMAIN") out.nxdomain = out.nxdomain || key === "a";
      else if (e.code !== "ENODATA" && e.code !== "ENOTIMP") out.error = out.error || e.code || e.message;
    }
  };
  await Promise.all([
    one(r.resolve4(domain), "a"),
    one(r.resolve6(domain), "aaaa"),
    one(r.resolveMx(domain).then((m) => m.map((x) => x.exchange.toLowerCase())), "mx"),
    one(r.resolveNs(domain).then((n) => n.map((x) => x.toLowerCase())), "ns"),
  ]);
  out.resolves = out.a.length > 0 || out.aaaa.length > 0;
  out.exists = out.resolves || out.mx.length > 0 || out.ns.length > 0;
  return out;
}

function publicIps(probe) {
  const ips = [...probe.a, ...probe.aaaa];
  const bad = ips.find(isPrivateOrReservedIp);
  if (bad) throw guardError(probe.domain, bad);
  return ips;
}

async function resolveSafely(domain) {
  const probe = await dnsProbe(domain);
  const ips = publicIps(probe);
  if (ips.length === 0) throw new UpstreamError(`could not resolve '${domain}'`);
  return ips;
}

// --- RDAP straight from the registry (IANA bootstrap, RFC 9224) ---------------
// rdap.org caps clients at 10 requests per 10 s and asks heavy users to query
// registries directly, so the collector does.

const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

async function rdapBaseFor(tld) {
  const { value } = await cached("iana-rdap-bootstrap", 86_400_000, async () => {
    const res = await withRetry(() => fetchJSON(IANA_BOOTSTRAP));
    if (!res.ok) throw new UpstreamError(`IANA RDAP bootstrap failed: HTTP ${res.status}`);
    const map = {};
    for (const [tlds, urls] of res.body.services || []) {
      const url = urls.find((u) => u.startsWith("https://")) || urls[0];
      for (const t of tlds) map[t.toLowerCase()] = url.endsWith("/") ? url : `${url}/`;
    }
    return map;
  });
  return value[tld] || null;
}

async function rdapLookup(domain, opts = {}) {
  const tld = domain.split(".").pop();
  const base = await rdapBaseFor(tld);
  if (!base) return { available: false, reason: `no RDAP server published for .${tld}` };
  const url = `${base}domain/${encodeURIComponent(domain)}`;
  const res = await withRetry(() => fetchJSON(url, { headers: { Accept: "application/rdap+json, application/json" } }));
  if (!res.ok) {
    if (res.status === 404) return { available: true, registered: false, source_url: url };
    throw new UpstreamError(`RDAP lookup for '${domain}' failed: HTTP ${res.status}`);
  }
  const j = res.body;
  const events = Object.fromEntries((j.events || []).map((e) => [e.eventAction, e.eventDate]));
  const registrar = (j.entities || []).find((e) => (e.roles || []).includes("registrar"));
  const registrarName = registrar && Array.isArray(registrar.vcardArray)
    ? ((registrar.vcardArray[1] || []).find((f) => f[0] === "fn") || [])[3] || null
    : null;
  const reg = events.registration ? Date.parse(events.registration) : NaN;
  const out = {
    available: true,
    registered: true,
    source_url: url,
    registered_at: events.registration || null,
    expires_at: events.expiration || null,
    age_days: Number.isFinite(reg) ? Math.floor((Date.now() - reg) / 86_400_000) : null,
    registrar: registrarName,
    status: j.status || [],
  };
  if (!opts.detail) return out;
  // The re-check keeps more of the record. Personal contact data is left out;
  // the abuse address is the registrar's published role contact.
  const abuse = registrar && (registrar.entities || []).find((e) => (e.roles || []).includes("abuse"));
  const abuseEmail = abuse && Array.isArray(abuse.vcardArray)
    ? ((abuse.vcardArray[1] || []).find((f) => f[0] === "email") || [])[3] || null
    : null;
  return {
    ...out,
    updated_at: events["last changed"] || null,
    nameservers: (j.nameservers || []).map((n) => String(n.ldhName || "").toLowerCase()).filter(Boolean),
    registrar_iana_id: registrar ? ((registrar.publicIds || []).find((p) => /iana/i.test(p.type || "")) || {}).identifier || null : null,
    registrar_abuse_email: abuseEmail,
    response_json_sha256: sha256(JSON.stringify(j)),
  };
}

// --- Live TLS certificate --------------------------------------------------------

function tlsCertInfo(domain, ip, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, servername: domain, port: 443, timeout: HTTP_TIMEOUT_MS, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = !!socket.authorized;
      const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
      const protocol = socket.getProtocol();
      socket.end();
      if (!cert || Object.keys(cert).length === 0) return reject(new UpstreamError(`no certificate presented by '${domain}'`));
      const now = Date.now();
      const from = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
      const to = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      const sans = (cert.subjectaltname || "").split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
      const detail = opts.detail
        ? { ip, tls_protocol: protocol, authorization_error: authorizationError, serial_number: cert.serialNumber || null, sans: sans.slice(0, 50), sans_truncated: sans.length > 50 }
        : {};
      resolve({
        subject_cn: cert.subject?.CN || null,
        subject_org: cert.subject?.O || null,
        issuer_org: cert.issuer?.O || null,
        issuer_cn: cert.issuer?.CN || null,
        valid_from: cert.valid_from || null,
        valid_to: cert.valid_to || null,
        issued_days_ago: Number.isFinite(from) ? Math.floor((now - from) / 86_400_000) : null,
        currently_valid: Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to,
        chain_trusted: authorized,
        san_count: sans.length,
        sha256_fingerprint: cert.fingerprint256 || null,
        ...detail,
      });
    });
    socket.on("error", (e) => reject(new UpstreamError(`TLS handshake with '${domain}' failed: ${e.message}`)));
    socket.setTimeout(HTTP_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new UpstreamError(`TLS handshake with '${domain}' did not finish in ${HTTP_TIMEOUT_MS}ms`));
    });
  });
}

// --- One GET, pinned to an IP we already vetted (no DNS rebinding) --------------

function getPinned(urlStr, ip) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      servername: u.hostname,
      rejectUnauthorized: false,
      // Newer Node asks lookup for all addresses (autoSelectFamily); answer both shapes.
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }]) : cb(null, ip, net.isIPv6(ip) ? 6 : 4)),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.5", "Accept-Encoding": "identity" },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_PAGE_BYTES) { res.destroy(); return; }
        chunks.push(c);
      });
      res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: size > MAX_PAGE_BYTES }));
      res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true }));
    });
    req.on("timeout", () => req.destroy(new UpstreamError(`GET ${urlStr} did not finish in ${HTTP_TIMEOUT_MS}ms`)));
    req.on("error", (e) => reject(e instanceof UpstreamError ? e : new UpstreamError(`GET ${urlStr} failed: ${e.message}`)));
    req.end();
  });
}

// Follows up to 3 redirects; every new host goes through the SSRF guard again.
async function fetchVetted(urlStr) {
  const chain = [];
  let current = urlStr;
  for (let hop = 0; hop < 4; hop++) {
    const host = new URL(current).hostname;
    const ips = await resolveSafely(host);
    const res = await getPinned(current, ips[0]);
    chain.push({ url: current, status: res.status });
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc && hop < 3) {
      const next = new URL(loc, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") break;
      current = next.toString();
      continue;
    }
    return { ...res, final_url: current, chain };
  }
  throw new UpstreamError(`too many redirects from ${urlStr}`);
}

// --- robots.txt (we honour Disallow: / for * and for our own agent) -------------

function robotsDisallowsRoot(text) {
  let applies = false;
  let blocked = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") applies = val === "*" || val.toLowerCase().startsWith("brand-protection");
    else if (key === "disallow" && applies && val === "/") blocked = true;
  }
  return blocked;
}

module.exports = {
  DOMAIN_RE, USER_AGENT, isValidDomain, isPrivateOrReservedIp, sha256,
  dnsProbe, publicIps, resolveSafely, rdapLookup, tlsCertInfo, fetchVetted, robotsDisallowsRoot,
};
