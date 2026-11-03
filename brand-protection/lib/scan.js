// The scan engine, shared by the backend (a quick, deadline-bounded scan for a
// brand nobody has watched yet) and the Pi collector (the full scan).
//
//   candidates (permutations + CT-log hits)
//     -> DNS for all of them
//     -> for the ones that exist, in priority order: RDAP, TLS, homepage
//     -> deterministic risk score + one evidence record per finding
"use strict";

const checks = require("./checks");
const fingerprint = require("./fingerprint");
const { permutations, splitDomain, brandKeywords } = require("./permute");
const { riskScore, METHOD } = require("./score");

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function brandIdFor(officialDomains) {
  const sp = splitDomain(officialDomains[0]);
  return sp ? sp.registrable : null;
}

function evidenceId(brandId, domain, at) {
  return checks.sha256(`${brandId}|${domain}|${at}`).slice(0, 24);
}

async function attempt(sources, kind, url, fn) {
  const fetched_at = new Date().toISOString();
  try {
    const value = await fn();
    sources.push({ kind, url, fetched_at, ok: true });
    return value;
  } catch (e) {
    if (e.isSsrfGuard) throw e;
    sources.push({ kind, url, fetched_at, ok: false, error: String(e.message).slice(0, 200) });
    return null;
  }
}

async function officialNsSets(officialDomains) {
  const probes = await Promise.all(officialDomains.map((d) => checks.dnsProbe(d).catch(() => null)));
  return [...new Set(probes.filter((p) => p && p.ns.length).map((p) => [...p.ns].sort().join(",")))];
}

async function officialFingerprint(officialDomains, keywords) {
  const base = { domains: officialDomains, title: null, icon_sha256: null, ns_sets: await officialNsSets(officialDomains) };
  for (const d of officialDomains) {
    try {
      const page = await fingerprint.homepage(d, keywords);
      if (page.reachable && !page.skipped) {
        // Where the official site really lives (uniswap.org -> app.uniswap.org) counts as official too.
        const domains = page.final_host && !officialDomains.includes(page.final_host) ? [...officialDomains, page.final_host] : officialDomains;
        return { ...base, domains, domain: d, title: page.title, icon_sha256: page.icon_sha256, fetched_at: page.fetched_at };
      }
    } catch {
      // try the next official domain
    }
  }
  return base;
}

/**
 * request: { brand, official_domains[], keywords[] }
 * opts:    { maxCandidates, deepLimit, deadlineMs, dnsConcurrency, deepConcurrency, ctHits: [{domain, log, index, timestamp}] }
 */
async function scanBrand(request, opts = {}) {
  const started = Date.now();
  const deadline = opts.deadlineMs ? started + opts.deadlineMs : Infinity;
  const maxCandidates = opts.maxCandidates ?? 400;
  const deepLimit = opts.deepLimit ?? 60;
  const official = request.official_domains.map((d) => d.toLowerCase());
  const brandId = brandIdFor(official);
  const keywords = brandKeywords(official, request.keywords || []);
  const as_of = new Date().toISOString();

  const ctByDomain = new Map((opts.ctHits || []).map((h) => [h.domain, h]));
  const seen = new Set(official);
  const candidates = [];
  for (const h of opts.ctHits || []) {
    if (!seen.has(h.domain) && checks.isValidDomain(h.domain)) { seen.add(h.domain); candidates.push({ domain: h.domain, fuzzer: "ct-log" }); }
  }
  // Round-robin across the official domains, so a cap cuts each domain's
  // least likely names rather than the whole of the second domain's list.
  const lists = official.map((d) => permutations(d, { exclude: official }));
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const p = l[i];
      if (p && !seen.has(p.domain)) { seen.add(p.domain); candidates.push(p); }
    }
  }
  const generated = candidates.length;
  candidates.splice(maxCandidates);

  const officialFp = opts.skipOfficial
    ? { domains: official, title: null, icon_sha256: null, ns_sets: [] }
    : await officialFingerprint(official, keywords);

  let dnsErrors = 0;
  const probes = await pool(candidates, opts.dnsConcurrency || 25, async (c) => {
    if (Date.now() > deadline) return null;
    const p = await checks.dnsProbe(c.domain);
    if (p.error && !p.exists) dnsErrors++;
    return p;
  });
  const dnsChecked = probes.filter(Boolean).length;
  const existing = candidates.map((c, i) => ({ c, probe: probes[i] })).filter((x) => x.probe && x.probe.exists);

  const findings = [];
  const evidence = [];
  let deepChecked = 0;
  await pool(existing, opts.deepConcurrency || 5, async ({ c, probe }, i) => {
    const deep = i < deepLimit && Date.now() < deadline;
    const sources = [{ kind: "dns", url: `dns:${c.domain}`, fetched_at: as_of, ok: !probe.error }];
    let rdap = null, cert = null, page = null, refused = null;
    if (deep) deepChecked++;
    try {
      const ips = checks.publicIps(probe);
      if (deep) {
        rdap = await attempt(sources, "rdap", `rdap:${c.domain}`, () => checks.rdapLookup(c.domain));
        if (ips.length > 0) {
          cert = await attempt(sources, "tls", `tls:${c.domain}:443`, () => checks.tlsCertInfo(c.domain, ips[0]));
          page = await attempt(sources, "http", `https://${c.domain}/`, () => fingerprint.homepage(c.domain, keywords));
        }
      }
    } catch (e) {
      if (!e.isSsrfGuard) throw e;
      refused = e.message;
    }
    const ct = ctByDomain.get(c.domain) || null;
    const risk = refused
      ? { score: 0, level: "none", status: "refused_private_address", reasons: [refused], method: METHOD }
      : riskScore({ dns: probe, rdap, cert, page, official: officialFp, ct: ct ? { seen: true } : null });
    const id = evidenceId(brandId, c.domain, as_of);
    evidence.push({
      evidence_id: id,
      brand_id: brandId,
      domain: c.domain,
      collected_at: as_of,
      method: METHOD,
      sources,
      dns: { a: probe.a, aaaa: probe.aaaa, mx: probe.mx, ns: probe.ns },
      rdap,
      certificate: cert,
      homepage: page,
      ct_log_entry: ct,
    });
    findings.push({
      domain: c.domain,
      ...(c.unicode ? { unicode: c.unicode } : {}),
      fuzzer: c.fuzzer,
      risk: risk.score,
      risk_level: risk.level,
      status: risk.status,
      reasons: risk.reasons,
      registered_at: rdap && rdap.registered_at || null,
      certificate_issuer: cert && cert.issuer_org || null,
      title: page && page.title || null,
      checked: deep ? "full" : "dns_only",
      evidence_id: id,
    });
  });

  findings.sort((a, b) => b.risk - a.risk || a.domain.localeCompare(b.domain));
  return {
    brand_id: brandId,
    brand: request.brand,
    official_domains: official,
    keywords,
    as_of,
    method: METHOD,
    official_fingerprint: officialFp,
    coverage: {
      candidates_generated: generated,
      candidates_dns_checked: dnsChecked,
      dns_errors: dnsErrors,
      existing: existing.length,
      full_checks: deepChecked,
      ct_hits: (opts.ctHits || []).length,
      partial: dnsChecked < generated || deepChecked < existing.length,
      duration_ms: Date.now() - started,
    },
    findings,
    evidence,
  };
}

module.exports = { scanBrand, brandIdFor, evidenceId, pool };
