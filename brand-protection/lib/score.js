// Deterministic risk score for one lookalike domain: same inputs, same score,
// on every supplier. Findings are signals, never accusations: the labels say
// what was observed ("copies the brand, wallet prompt"), not "fraud".
"use strict";

const METHOD = "bp-risk/1";

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
  if (cert && cert.currently_valid && cert.issued_days_ago != null && cert.issued_days_ago <= 30) add(10, `TLS certificate issued ${cert.issued_days_ago} days ago`);
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
    if (page.brand_in_title) { add(15, "page title names the brand"); copiesBrand = true; }
    else if (page.brand_in_page) add(5, "page text names the brand");
    if (official && official.icon_sha256 && page.icon_sha256 === official.icon_sha256) {
      add(20, "site icon is byte-identical to the official site's");
      copiesBrand = true;
    }
    if (official && official.title && page.title && page.title === official.title) {
      add(10, "page title is identical to the official site's");
      copiesBrand = true;
    }
    if (page.has_password_form) add(10, "page has a password field");
    if (page.wallet_prompt) add(20, "page asks to connect a wallet or enter a recovery phrase");
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

module.exports = { riskScore, sharesOfficialDns, METHOD };
