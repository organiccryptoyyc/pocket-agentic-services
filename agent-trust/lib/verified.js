// The shared `verified` block (pocket-agentic-envelope/1, docs/envelope/ in the repo) for agent-trust.
// Additive: built from the response each route already returns. Each live lookup the route made (RDAP, DNS, the
// TLS handshake, the screening list, the explorer or RPC) becomes one evidence item, retrieved when the answer was
// computed (the cache time, not the response time).
"use strict";

const C = require("./verified-core");
const { POCKET_RPC_HOSTS, BLOCKSCOUT_HOSTS } = require("./checks");

const SERVICE = "agent-trust";
const CHAIN_IDS = { eth: 1, base: 8453, arbitrum: 42161, polygon: 137 };
const OK = "permitted_for_derived_output";

const rdap = (d, at) => C.evidence({ source_ref: `rdap:${d}`, title: `RDAP registration record for ${d}`, publisher: "RDAP (rdap.org bootstrap to the registry)", url: `https://rdap.org/domain/${encodeURIComponent(d)}`, retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK });
const dns = (d, at) => C.evidence({ source_ref: `dns:${d}`, title: `DNS records for ${d} (MX, TXT, A, _dmarc)`, publisher: "Public DNS (live lookup)", retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK });
const tls = (d, at) => C.evidence({ source_ref: `tls:${d}:443`, title: `TLS certificate presented by ${d}:443`, publisher: "TLS handshake (live)", url: `https://${d}/`, retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK });

function domainSubject(d) {
  return { kind: "domain", id: C.domainId(d), name: d, identifiers: { domain: d } };
}

function domainGaps(r) {
  const out = [];
  if (r && r.registration && r.registration.registered === false) out.push(C.gap("registration", "RDAP has no record for this domain", "the score is 0"));
  if (r && r.certificate && r.certificate.error) out.push(C.gap("certificate", String(r.certificate.error), "certificate signals are missing"));
  return out;
}

// out: the response the route already built (withMeta applied). Returns out plus `verified`.
function withVerified(route, out, version, nowMs = Date.now()) {
  const at = new Date(nowMs - ((out.cache && out.cache.age_ms) || 0)).toISOString();
  const base = { service: SERVICE, version, route, as_of: at, nowMs };
  let v;
  if (route === "/v1/domain-trust") {
    v = C.build({ ...base, subject: domainSubject(out.domain),
      assessment: C.assessment({ status: "ok", score: out.trust_score, scale: C.SCALE_0_100 }),
      evidence: [rdap(out.domain, at), dns(out.domain, at)], gaps: domainGaps(out) });
  } else if (route === "/v1/brand-verify") {
    v = C.build({ ...base, subject: domainSubject(out.domain),
      assessment: C.assessment({ status: "ok", score: out.brand_verify_score, scale: C.SCALE_0_100, label: out.brand_name ? (out.brand_name_match ? "brand name matches" : "brand name does not match") : null }),
      evidence: [tls(out.domain, at), rdap(out.domain, at)], gaps: domainGaps(out) });
  } else if (route === "/v1/seller-trust") {
    const h = out.hostname;
    v = C.build({ ...base, subject: { ...domainSubject(h), identifiers: { domain: h, url: out.url } },
      assessment: C.assessment({ status: "ok", native_status: out.recommendation, score: out.seller_trust_score, scale: C.SCALE_0_100, label: out.recommendation }),
      evidence: [rdap(h, at), dns(h, at), tls(h, at)],
      gaps: domainGaps({ certificate: out.certificate_trust && out.certificate_trust.certificate }) });
  } else if (route === "/v1/sanctions-check") {
    // A screening query is an address or a name, with no chain: an EVM address is keyed chain-free.
    const q = String(out.query);
    const subject = /^0x[0-9a-fA-F]{40}$/.test(q)
      ? { kind: "wallet", id: C.id("wallet", "evm-address", q.toLowerCase()), name: null, identifiers: { address: q } }
      : { kind: "topic", id: C.id("topic", "csl-name", encodeURIComponent(q.toLowerCase())), name: q, identifiers: { query: q } };
    v = C.build({ ...base, subject,
      assessment: C.notScored(out.sanctioned ? `${out.match_count} screening list match${out.match_count === 1 ? "" : "es"}` : "no screening list match"),
      evidence: [C.evidence({ source_ref: "csl", title: "U.S. Consolidated Screening List search (OFAC SDN and 10+ other U.S. lists)", publisher: "International Trade Administration (data.trade.gov)", url: "https://www.trade.gov/consolidated-screening-list", retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK })],
      gaps: [C.gap("match_scope", "the list is searched by name or address text, not by wallet clustering", "an address that is not listed verbatim returns no match", "screen the owner's name as well")] });
  } else if (route === "/v1/reputation") {
    const cid = CHAIN_IDS[out.chain];
    const explorer = out.coverage === "full" && BLOCKSCOUT_HOSTS[out.chain];
    const host = explorer || POCKET_RPC_HOSTS[out.chain];
    v = C.build({ ...base,
      subject: { kind: "wallet", id: cid ? C.caip10(cid, out.address) : C.id("wallet", "evm-address", String(out.address).toLowerCase()), name: out.ens_name || null, identifiers: { chain: out.chain, address: out.address } },
      assessment: C.assessment({ status: "ok", native_status: out.coverage, score: out.reputation_score, scale: C.SCALE_0_100, coverage_pct: out.score_max_possible }),
      evidence: [explorer
        ? C.evidence({ source_ref: `blockscout:${out.chain}:${out.address}`, title: `Block explorer record for ${out.address}`, publisher: "Blockscout", url: `https://${host}/address/${out.address}`, retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK })
        : C.evidence({ source_ref: `rpc:${out.chain}:${out.address}`, title: `On-chain code, nonce and balance of ${out.address}`, publisher: "Pocket Network public RPC", url: `https://${host}`, retrieved_at: at, observation_time: at, source_tier: 1, rights_status: OK })],
      gaps: out.coverage === "full" ? [] : [C.gap("explorer_signals", "explorer signals (reputation flag, verified source, scam flag, public tags, ENS) are not available for this chain or the explorer did not answer", "basic score, at most 35")] });
  } else {
    return out;
  }
  return { ...out, verified: v };
}

module.exports = { withVerified, CHAIN_IDS };
