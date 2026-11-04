// Homepage fingerprint: one GET of the site root (after robots.txt) and one of
// its icon. We keep only derived fields and SHA-256 hashes; the raw page is
// never returned to callers (raw bytes stay on the collector).
"use strict";

const checks = require("./checks");

const WALLET_RE = /walletconnect|connect\s*wallet|metamask|seed\s*phrase|recovery\s*phrase|secret\s*phrase|private\s*key|eth_requestaccounts|window\.ethereum|wallet\s*sync|validate\s*wallet|rectify\s*wallet/i;
const PASSWORD_RE = /<input[^>]+type\s*=\s*["']?password/i;
const PARKED_RE = /domain\s+(?:is\s+)?for\s+sale|buy\s+this\s+domain|this\s+domain\s+(?:may\s+be|is)\s+for\s+sale|parked\s+(?:free|domain)|sedoparking|dan\.com|afternic|parkingcrew|bodis\.com|domain\s+parking/i;
// A lookalike that redirects to a domain marketplace is for sale, i.e. parked.
const MARKETPLACE_HOSTS = ["atom.com", "dan.com", "afternic.com", "sedo.com", "hugedomains.com", "squadhelp.com", "undeveloped.com", "godaddy.com", "brandbucket.com", "spaceship.com", "efty.com", "sav.com", "bodis.com", "parkingcrew.net"];
const TITLE_RE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const ICON_RE = /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>/i;
const HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// Which wallet terms a page really used, so a reader can tell "mentions MetaMask"
// from "asks for your recovery phrase". Pure.
function walletTerms(text) {
  const re = new RegExp(WALLET_RE.source, "gi");
  const found = new Set();
  for (const m of text.matchAll(re)) {
    found.add(m[0].toLowerCase().replace(/\s+/g, " "));
    if (found.size >= 10) break;
  }
  return [...found].sort();
}

// Pure: derive signals from page bytes. Exported for tests.
function analyzeHtml(body, keywords) {
  const text = body.toString("utf8");
  const titleMatch = TITLE_RE.exec(text);
  const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : null;
  const lower = text.toLowerCase();
  const iconTag = ICON_RE.exec(text);
  const iconHref = iconTag ? (HREF_RE.exec(iconTag[0]) || [])[1] || null : null;
  return {
    title,
    brand_in_title: !!title && keywords.some((k) => title.toLowerCase().includes(k)),
    brand_in_page: keywords.some((k) => lower.includes(k)),
    has_password_form: PASSWORD_RE.test(text),
    wallet_prompt: WALLET_RE.test(text),
    parked: PARKED_RE.test(text) || (!!title && /\bfor\s+sale\b|\bdomain\s+(?:sale|auction)\b|make\s+an\s+offer/i.test(title)),
    icon_href: iconHref,
  };
}

async function homepage(domain, keywords, opts = {}) {
  const fetched_at = new Date().toISOString();
  let base = `https://${domain}/`;
  let robots;
  try {
    robots = await checks.fetchVetted(`${base}robots.txt`);
  } catch (e) {
    if (e.isSsrfGuard) throw e;
    base = `http://${domain}/`;
    try {
      robots = await checks.fetchVetted(`${base}robots.txt`);
    } catch (e2) {
      if (e2.isSsrfGuard) throw e2;
      return { fetched_at, reachable: false, error: String(e2.message).slice(0, 200) };
    }
  }
  if (robots.status === 200 && checks.robotsDisallowsRoot(robots.body.toString("utf8"))) {
    return { fetched_at, reachable: true, skipped: "robots_txt" };
  }
  const page = await checks.fetchVetted(base);
  const signals = analyzeHtml(page.body, keywords);
  let icon_sha256 = null;
  const iconUrl = new URL(signals.icon_href || "/favicon.ico", page.final_url);
  if (iconUrl.hostname === new URL(page.final_url).hostname) {
    try {
      const icon = await checks.fetchVetted(iconUrl.toString());
      if (icon.status === 200 && icon.body.length > 0) icon_sha256 = checks.sha256(icon.body);
    } catch (e) {
      // a missing icon is not an error; leave the hash null
    }
  }
  const { icon_href, ...rest } = signals;
  const finalHost = new URL(page.final_url).hostname.toLowerCase();
  if (MARKETPLACE_HOSTS.some((h) => finalHost === h || finalHost.endsWith(`.${h}`))) rest.parked = true;
  return {
    fetched_at,
    reachable: true,
    url: base,
    final_url: page.final_url,
    final_host: finalHost,
    redirect_chain: page.chain,
    status: page.status,
    bytes: page.body.length,
    truncated: page.truncated,
    sha256: checks.sha256(page.body),
    icon_sha256,
    ...rest,
    ...(opts.detail
      ? {
          wallet_terms: walletTerms(page.body.toString("utf8")),
          content_type: page.headers["content-type"] || null,
          server: page.headers.server || null,
          robots_txt_status: robots.status,
        }
      : {}),
  };
}

module.exports = { homepage, analyzeHtml, walletTerms };
