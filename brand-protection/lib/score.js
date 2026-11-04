// Deterministic risk score for one lookalike domain: same inputs, same score,
// on every supplier. Findings are signals, never accusations: the labels say
// what was observed ("copies the brand, wallet prompt"), not "fraud".
"use strict";

const METHOD = "bp-risk/2";

// bp-risk/2 (2026-11-04), tuned on 1,446 real Beta findings:
//  - A fresh certificate on an established domain is a routine renewal. It only
//    counts on a young domain, when the age is unknown, or when the page copies
//    the brand or prompts for a wallet.
//  - A brand name that is an ordinary word ("curve", "pocket") turns up on
//    unrelated sites. In a title it needs something else pointing at the brand;
//    a distinctive name ("pancakeswap") counts for more than it did.
//  - A password field is normal on any shop, so on an established domain it needs
//    the same support.
// A word missing from this list is treated as distinctive, so the list can only
// ever miss a false alarm, never hide a finding by accident.
const COMMON_BRAND_WORDS = new Set([
  "curve", "pocket", "compound", "silo", "badger", "gearbox", "euler", "morpho", "sky", "origin", "cow", "lido", "yearn",
  "balancer", "threshold", "stargate", "inverse", "shapeshift", "brand", "anchor", "apex", "atlas", "beacon", "bolt",
  "bridge", "chain", "circle", "coin", "core", "cross", "delta", "echo", "edge", "flow", "forge", "frame", "gate",
  "harbor", "horizon", "hub", "iron", "key", "layer", "lens", "link", "maker", "market", "matrix", "mint", "moon",
  "nexus", "nova", "oasis", "orbit", "peak", "pilot", "pine", "pivot", "pulse", "quest", "radar", "rain", "ridge",
  "river", "rocket", "safe", "scale", "shield", "signal", "solid", "spark", "spring", "stream", "summit", "sun", "swap",
  "terra", "tide", "token", "trust", "union", "unity", "vault", "venture", "wallet", "wave", "zero",
]);
const YOUNG_DOMAIN_DAYS = 180;

// True when every brand term in the page title is an ordinary word.
function titleTermsAreCommon(page) {
  const terms = page && page.brand_terms_in_title;
  return Array.isArray(terms) && terms.length > 0 && terms.every((t) => COMMON_BRAND_WORDS.has(String(t).toLowerCase()));
}

// Nameservers that millions of unrelated domains share (registrar defaults,
// parking, shared hosting). An identical set there says nothing about owner.
const SHARED_NS = [
  "domaincontrol.com", "registrar-servers.com", "dnsowl.com", "googledomains.com", "name-services.com",
  "parkingcrew.net", "sedoparking.com", "bodis.com", "above.com", "dan.com", "afternic.com", "hostinger.com",
  "dns-parking.com", "namebrightdns.com", "porkbun.com", "dynadot.com", "ui-dns.com", "ui-dns.de", "ui-dns.org",
  "ui-dns.biz", "hichina.com", "dnspod.net", "nsone.net", "wixdns.net", "squarespacedns.com", "vercel-dns.com",
  "digitalocean.com", "linode.com", "hover.com", "gandi.net", "ovh.net", "1and1.com", "secureserver.net",
];

// Same nameserver set as an official domain, on a provider that hands out
// per-account sets (e.g. a Cloudflare pair): very likely the same owner.
function sharesOfficialDns(dnsNs, officialNsSets) {
  if (!Array.isArray(dnsNs) || dnsNs.length === 0 || !Array.isArray(officialNsSets)) return false;
  const set = [...dnsNs].map((n) => n.toLowerCase().replace(/\.$/, "")).sort();
  if (set.some((n) => SHARED_NS.some((g) => n === g || n.endsWith(`.${g}`)))) return false;
  const key = set.join(",");
  return officialNsSets.includes(key);
}

function riskScore({ dns, rdap, cert, page, official, ct }) {
  const reasons = [];
  let score = 0;
  const add = (pts, why) => { score += pts; reasons.push(`${why} (${pts >= 0 ? "+" : ""}${pts})`); };

  if (!dns || !dns.exists) return { score: 0, level: "none", status: "not_registered", reasons: ["name does not exist in DNS"], method: METHOD };

  if (dns.resolves) add(15, "resolves to an address");
  else add(5, "registered (has DNS) but no web address");
  if (dns.mx && dns.mx.length > 0) add(5, "can receive email (MX)");

  if (rdap && rdap.registered && rdap.age_days != null) {
    if (rdap.age_days <= 30) add(25, `registered ${rdap.age_days} days ago`);
    else if (rdap.age_days <= 180) add(10, `registered ${rdap.age_days} days ago`);
    else if (rdap.age_days > 1825) add(-10, `registered ${Math.floor(rdap.age_days / 365)} years ago`);
  }
  const young = !!(rdap && rdap.registered && rdap.age_days != null && rdap.age_days <= YOUNG_DOMAIN_DAYS);
  const ageKnown = !!(rdap && rdap.registered && rdap.age_days != null);
  const pageRead = !!(page && page.reachable && !page.skipped);
  const sameIcon = !!(pageRead && official && official.icon_sha256 && page.icon_sha256 === official.icon_sha256);
  const sameTitle = !!(pageRead && official && official.title && page.title && page.title === official.title);
  const walletPrompt = !!(pageRead && page.wallet_prompt);
  const supported = young || sameIcon || sameTitle || walletPrompt;
  const commonTitle = pageRead && titleTermsAreCommon(page);
  const freshCert = !!(cert && cert.currently_valid && cert.issued_days_ago != null && cert.issued_days_ago <= 30);
  if (freshCert && (!ageKnown || supported)) add(10, `TLS certificate issued ${cert.issued_days_ago} days ago`);
  if (ct && ct.seen) add(5, "new certificate seen in Certificate Transparency logs");

  let copiesBrand = false;
  let toOfficial = false;
  const sameOwner = !!(official && sharesOfficialDns(dns.ns, official.ns_sets));
  if (sameOwner) add(-40, `uses the same nameservers as the official site (${dns.ns.slice(0, 2).join(", ")}), likely the brand's own`);
  if (page && page.final_host && official && Array.isArray(official.domains)) {
    toOfficial = official.domains.some((d) => page.final_host === d || page.final_host.endsWith(`.${d}`));
  }
  if (toOfficial) {
    add(-40, `redirects to the official site (${page.final_host}), likely the brand's own defensive registration`);
  } else if (page && page.reachable && !page.skipped) {
    if (page.parked) add(-20, "page looks parked or for sale");
    if (page.brand_in_title) {
      if (!commonTitle) { add(25, "page title names the brand"); copiesBrand = true; }
      else if (supported) { add(15, "page title names the brand"); copiesBrand = true; }
      else add(5, `page title contains the common word "${page.brand_terms_in_title[0]}", with nothing else pointing at the brand`);
    } else if (page.brand_in_page) add(5, "page text names the brand");
    if (sameIcon) {
      add(20, "site icon is byte-identical to the official site's");
      copiesBrand = true;
    }
    if (sameTitle) {
      add(10, "page title is identical to the official site's");
      copiesBrand = true;
    }
    if (page.has_password_form && (!ageKnown || supported || (page.brand_in_title && !commonTitle))) add(10, "page has a password field");
    if (walletPrompt) add(20, "page asks to connect a wallet or enter a recovery phrase");
  }

  score = Math.max(0, Math.min(100, score));
  // The brand's own site never reads as a medium or high risk, however much it "copies the brand".
  if (toOfficial || sameOwner) score = Math.min(score, 20);
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  let status;
  if (toOfficial) status = "redirects_to_official";
  else if (sameOwner) status = "likely_brand_owned";
  else if (page && page.parked) status = "parked";
  else if (copiesBrand) status = "copies_brand";
  else if (dns.resolves) status = page && page.reachable ? "live" : "resolves";
  else status = "registered_not_live";
  return { score, level, status, reasons, method: METHOD };
}

module.exports = { riskScore, sharesOfficialDns, titleTermsAreCommon, METHOD };
