// node --test test/brand.test.js  (no network: DNS, RDAP, TLS and homepage calls are stubbed)
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.BP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-test-"));
process.env.PORT = "0";
process.env.BP_INGEST_PORT = "0";
process.env.BP_INGEST_TOKEN = "test-token-not-secret";

const checks = require("../lib/checks");
const fingerprint = require("../lib/fingerprint");
const { permutations, brandKeywords } = require("../lib/permute");
const { riskScore, sharesOfficialDns } = require("../lib/score");
const { scanBrand } = require("../lib/scan");
const store = require("../lib/store");
const { checkResult, tokenOk } = require("../lib/ingest");

// --- a small fake internet ----------------------------------------------------
const ICON = "a".repeat(64);
const WORLD = {
  "uniswap.org": { a: ["198.51.100.1"], ns: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], age: 2500, page: { title: "Uniswap Interface", icon_sha256: ICON } },
  "uniswap-claim.org": { a: ["203.0.113.10"], mx: ["mx.uniswap-claim.org"], age: 5, certDays: 3, page: { title: "Uniswap Interface", icon_sha256: ICON, wallet_prompt: true, brand_in_title: true, brand_in_page: true } },
  "uniswap.xyz": { a: ["203.0.113.11"], age: 900, page: { title: "uniswap.xyz is for sale", parked: true, brand_in_title: true, brand_in_page: true } },
  "unlswap.org": { a: ["10.0.0.5"], age: 10 },
};
checks.dnsProbe = async (domain) => {
  const w = WORLD[domain];
  return w
    ? { domain, a: w.a || [], aaaa: [], mx: w.mx || [], ns: w.ns || ["ns1.example.net"], nxdomain: false, error: null, resolves: (w.a || []).length > 0, exists: true }
    : { domain, a: [], aaaa: [], mx: [], ns: [], nxdomain: true, error: null, resolves: false, exists: false };
};
checks.rdapLookup = async (domain) => ({ available: true, registered: true, source_url: `https://rdap.test/domain/${domain}`, registered_at: "2026-10-28T00:00:00Z", age_days: WORLD[domain].age, registrar: "Test Registrar", status: [] });
checks.tlsCertInfo = async (domain) => ({ issuer_org: "Let's Encrypt", currently_valid: true, issued_days_ago: WORLD[domain].certDays ?? 200, sha256_fingerprint: "AB:CD" });
fingerprint.homepage = async (domain) => ({
  fetched_at: "2026-11-02T00:00:00Z", reachable: true, status: 200, sha256: "b".repeat(64),
  brand_in_title: false, brand_in_page: false, has_password_form: false, wallet_prompt: false, parked: false, ...WORLD[domain].page,
});

// --- bp-risk/2: real Beta findings, so a change to the scale shows up here -------

// reg = days since registration; null = the registry gave no age.
function realCase({ reg, cert, title, terms, wallet, pw, mx, icon, sameTitle, text, host }) {
  return riskScore({
    dns: { exists: true, resolves: true, mx: mx ? ["mx.example"] : [], ns: ["ns1.example.net"] },
    rdap: reg === null ? null : { registered: true, age_days: reg },
    cert: cert == null ? null : { currently_valid: true, issued_days_ago: cert },
    page: {
      reachable: true, title: sameTitle ? "Official" : (title || "Some page"), brand_in_title: !!terms, brand_terms_in_title: terms || [],
      brand_in_page: !!terms || !!text, wallet_prompt: !!wallet, has_password_form: !!pw, icon_sha256: icon ? "i" : "p",
      ...(host ? { final_host: host } : {}),
    },
    official: { domains: ["official.example"], title: "Official", icon_sha256: "i", ns_sets: [] },
  });
}

test("bp-risk/2: unrelated businesses with an ordinary brand word drop out of medium", () => {
  const cases = [
    ["pocket.capital", { reg: 900, cert: 21, mx: true, terms: ["pocket"], title: "Pocket Capital" }, 25],
    ["curve.us", { reg: 900, terms: ["curve"], pw: true, title: "Curve Fragrances" }, 20],
    ["compound.co", { reg: 900, cert: 2, mx: true, terms: ["compound"], title: "Compound Health" }, 25],
    ["silo.network", { reg: 900, cert: 8, terms: ["silo"], title: "Silo Network" }, 20],
    ["morpho.world", { reg: 900, cert: 9, mx: true, terms: ["morpho"], title: "Morpho by Tomorrowland" }, 25],
    ["gearbox.app", { reg: 3000, cert: 27, mx: true, terms: ["gearbox"], pw: true, title: "GEARBOX" }, 15],
  ];
  for (const [name, input, want] of cases) {
    const r = realCase(input);
    assert.strictEqual(r.score, want, name);
    assert.strictEqual(r.level, "low", name);
    assert.strictEqual(r.status, "live", `${name} no longer reads as copying the brand`);
  }
});

test("bp-risk/2: real clones and new lookalikes stay flagged", () => {
  const cases = [
    ["aavestaking.com", { reg: 21, cert: 21, terms: ["aave"], title: "Aave Staking", wallet: true }, 85, "high"],
    ["aavemigrate.com", { reg: 800, cert: 7, terms: ["aave"], title: "AaveMigrate", wallet: true }, 60, "medium"],
    ["compound-labs.xyz", { reg: 5, cert: 5, terms: ["compound"], title: "Compound" }, 65, "medium"],
    ["pancakeswap.co", { reg: 900, cert: 19, terms: ["pancakeswap"], title: "Exchange | PancakeSwap" }, 40, "medium"],
    ["synthetix.live", { reg: 900, cert: 26, terms: ["synthetix"], title: "Synthetix" }, 40, "medium"],
    ["stargate.fi", { reg: 900, mx: true, text: true, icon: true, sameTitle: true }, 55, "medium"],
    ["cow.foundation", { reg: 900, cert: 15, mx: true, icon: true }, 50, "medium"],
    ["silo.global", { reg: 900, mx: true, terms: ["silo"], title: "Silo", wallet: true }, 55, "medium"],
    ["app-balancer.fi", { reg: 36, terms: ["balancer"], title: "Balancer" }, 40, "medium"],
  ];
  for (const [name, input, score, level] of cases) {
    const r = realCase(input);
    assert.strictEqual(r.score, score, name);
    assert.strictEqual(r.level, level, name);
  }
});

test("bp-risk/2: an unknown age keeps the certificate and password signals", () => {
  assert.strictEqual(realCase({ reg: null, cert: 10, terms: ["curve"], title: "Curve", pw: true }).score, 40);
});

test("bp-risk/2: a word that isn't on the list stays distinctive", () => {
  const r = realCase({ reg: 900, terms: ["notonthelistword"], title: "Notonthelistword" });
  assert.strictEqual(r.score, 30);
  assert.strictEqual(r.status, "copies_brand");
});

test("bp-risk/2: a title that only repeats the hostname doesn't name the brand", () => {
  for (const [host, title, terms] of [
    ["alchemix.me", "alchemix.me", ["alchemix"]],
    ["synthetix.click", "synthetix.click | 523: Origin is unreachable", ["synthetix"]],
    ["www.machinex.us", "www.machinex.us", ["machinex"]],
  ]) {
    const r = realCase({ reg: 900, terms, title, host });
    assert.strictEqual(r.status, "live", host);
    assert.strictEqual(r.score, 20, host);
    assert.ok(r.reasons.includes("page text names the brand (+5)"), host);
  }
  const named = realCase({ reg: 900, terms: ["alchemix"], title: "Alchemix on alchemix.me", host: "alchemix.me" });
  assert.strictEqual(named.status, "copies_brand", "the name outside the hostname still counts");
});

test("bp-risk/3: a live name built on a phishing word is flagged, not a parked or owned one", () => {
  const live = riskScore({ dns: { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] }, rdap: { registered: true, age_days: 900 }, fuzzer: "added-word" });
  assert.strictEqual(live.score, 30);
  assert.ok(live.reasons.includes("name adds a phishing-style word to the brand (+15)"));
  const typo = riskScore({ dns: { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] }, rdap: { registered: true, age_days: 900 }, fuzzer: "omission" });
  assert.strictEqual(typo.score, 15);
  const parked = riskScore({ dns: { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] }, page: { reachable: true, parked: true }, fuzzer: "added-word" });
  assert.ok(!parked.reasons.some((r) => r.startsWith("name adds")));
  const own = riskScore({ dns: { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] }, page: { reachable: true, final_host: "official.example" }, official: { domains: ["official.example"], ns_sets: [] }, fuzzer: "added-word" });
  assert.ok(!own.reasons.some((r) => r.startsWith("name adds")));
  const noAddress = riskScore({ dns: { exists: true, resolves: false, mx: [], ns: ["ns1.example.net"] }, fuzzer: "added-word" });
  assert.ok(!noAddress.reasons.some((r) => r.startsWith("name adds")));
});

test("bp-risk/3: the name alone can't make a finding high", () => {
  const dns = { exists: true, resolves: true, mx: ["mx.example"], ns: ["ns1.example.net"] };
  const official = { domains: ["official.example"], title: "Official", icon_sha256: "i", ns_sets: [] };
  const page = { reachable: true, title: "Compound", brand_in_title: true, brand_terms_in_title: ["compound"], brand_in_page: true };
  const recent = { registered: true, age_days: 5 };
  const fresh = { currently_valid: true, issued_days_ago: 5 };
  const noEvidence = riskScore({ dns, rdap: recent, cert: fresh, page, official, fuzzer: "added-word" });
  assert.strictEqual(noEvidence.score, 69);
  assert.strictEqual(noEvidence.level, "medium");
  const wallet = riskScore({ dns, rdap: recent, cert: fresh, page: { ...page, wallet_prompt: true }, official, fuzzer: "added-word" });
  assert.strictEqual(wallet.level, "high");
  const icon = riskScore({ dns, rdap: recent, cert: fresh, page: { ...page, icon_sha256: "i" }, official, fuzzer: "added-word" });
  assert.strictEqual(icon.level, "high");
  const typo = riskScore({ dns, rdap: recent, cert: fresh, page: { ...page, wallet_prompt: true }, official });
  assert.strictEqual(typo.score, 90, "other names are not capped");
});

test("bp-risk/4: a password field under the brand's name reaches high", () => {
  const dns = { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] };
  const official = { domains: ["wise.com"], title: "Wise", icon_sha256: "i", ns_sets: [] };
  const page = { reachable: true, title: "TransferWise - Secure Online Banking", brand_in_title: true, brand_terms_in_title: ["transferwise", "wise"], brand_in_page: true, has_password_form: true };
  const fake = riskScore({ dns, rdap: { registered: true, age_days: 166 }, page, official, fuzzer: "insertion" });
  assert.strictEqual(fake.score, 70);
  assert.strictEqual(fake.level, "high");
  const shop = { ...page, title: "Wise Shop", brand_terms_in_title: ["wise"] };
  assert.strictEqual(riskScore({ dns, rdap: { registered: true, age_days: 4000 }, page: shop, official }).level, "low", "an old shop with an ordinary word stays low");
  const named = riskScore({ dns, rdap: { registered: true, age_days: 100 }, page, official, fuzzer: "added-word" });
  assert.strictEqual(named.level, "high", "a branded login is page evidence, so the name cap doesn't apply");
});

test("bp-risk/4: bank claims need support and a brand link", () => {
  const dns = { exists: true, resolves: true, mx: ["mx.example"], ns: ["ns1.example.net"] };
  const official = { domains: ["revolut.com"], title: "Revolut", icon_sha256: "i", ns_sets: [] };
  const page = { reachable: true, title: "Ravolut Banking", brand_in_title: false, brand_terms_in_title: [], brand_in_page: true, bank_claim: true };
  const cert = { currently_valid: true, issued_days_ago: 25 };
  assert.strictEqual(riskScore({ dns, rdap: { registered: true, age_days: 26 }, cert, page, official, fuzzer: "vowel-swap" }).score, 75);
  const noReason = riskScore({ dns, rdap: { registered: true, age_days: 4000 }, page, official });
  assert.ok(!noReason.reasons.some((r) => r.includes("bank")));
  const noBrand = riskScore({ dns, rdap: { registered: true, age_days: 26 }, page: { ...page, brand_in_page: false }, official });
  assert.ok(!noBrand.reasons.some((r) => r.includes("bank")));
});

test("bp-risk/4: a host's phishing warning counts as page evidence", () => {
  const dns = { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] };
  const official = { domains: ["robinhood.com"], title: "Robinhood", icon_sha256: "i", ns_sets: [] };
  const signals = fingerprint.analyzeHtml(Buffer.from('<title>Suspected Phishing | Cloudflare</title><form action="/cdn-cgi/phish-bypass">'), ["robinhood"]);
  assert.strictEqual(signals.host_phishing_warning, true);
  const r = riskScore({ dns, rdap: { registered: true, age_days: 97 }, page: { reachable: true, ...signals }, official, fuzzer: "added-word" });
  assert.strictEqual(r.score, 80);
  assert.strictEqual(r.level, "high");
  assert.strictEqual(fingerprint.analyzeHtml(Buffer.from("<title>Suspected Phishing</title>"), ["x"]).host_phishing_warning, false, "words alone don't count");
});

test("bp-risk/4: a pulled site is low, unless it still asks for something", () => {
  const dns = { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] };
  const official = { domains: ["wise.com"], title: "Wise", icon_sha256: "i", ns_sets: [] };
  const signals = fingerprint.analyzeHtml(Buffer.from("<title>Deployment Unavailable</title>"), ["wise"]);
  assert.strictEqual(signals.taken_down, true);
  const args = { dns, rdap: { registered: true, age_days: 18 }, cert: { currently_valid: true, issued_days_ago: 18 }, official, fuzzer: "added-word" };
  const r = riskScore({ ...args, page: { reachable: true, ...signals } });
  assert.strictEqual(r.status, "taken_down");
  assert.strictEqual(r.level, "low");
  const lure = riskScore({ ...args, page: { reachable: true, ...signals, wallet_prompt: true } });
  assert.notStrictEqual(lure.status, "taken_down");
  assert.strictEqual(fingerprint.analyzeHtml(Buffer.from("<title>Log in</title>Your account suspended, verify now"), ["wise"]).taken_down, false, "lure text doesn't count");
});

test("bp-risk/4: the name's shape doesn't count on an old domain, and a parking page is parked", () => {
  const dns = { exists: true, resolves: true, mx: [], ns: ["ns1.example.net"] };
  const official = { domains: ["wise.com"], title: "Wise", icon_sha256: "i", ns_sets: [] };
  const page = { reachable: true, title: "Connect", brand_in_title: false, brand_terms_in_title: [] };
  const shaped = (age) => riskScore({ dns, rdap: { registered: true, age_days: age }, page, official, fuzzer: "added-word" }).reasons.some((x) => x.startsWith("name adds"));
  assert.strictEqual(shaped(1000), true);
  assert.strictEqual(shaped(1100), false);
  assert.strictEqual(fingerprint.analyzeHtml(Buffer.from("<title>Namecheap Parking Page</title>"), ["x"]).parked, true);
});

test("analyzeHtml says which brand terms the title used", () => {
  const s = fingerprint.analyzeHtml(Buffer.from("<title>Pocket and POKT tools</title>"), ["pocket", "pokt", "other"]);
  assert.deepStrictEqual(s.brand_terms_in_title, ["pocket", "pokt"]);
});

// --- the re-check's extra detail ------------------------------------------------

test("wallet terms name what a page really used", () => {
  assert.deepStrictEqual(fingerprint.walletTerms("Connect  Wallet, then enter your Seed Phrase. connect wallet"), ["connect wallet", "seed phrase"]);
  assert.deepStrictEqual(fingerprint.walletTerms("<p>plain page</p>"), []);
});

// --- permutations ---------------------------------------------------------------

test("permutations are deterministic, valid and never include the original", () => {
  const a = permutations("uniswap.org");
  assert.deepStrictEqual(a, permutations("uniswap.org"));
  const names = a.map((p) => p.domain);
  assert.ok(!names.includes("uniswap.org"));
  for (const want of ["uniswap-claim.org", "uniswap.xyz", "unlswap.org", "uniswpa.org", "unisawp.org"]) assert.ok(names.includes(want), want);
  assert.ok(a.some((p) => p.fuzzer === "idn-homoglyph" && p.domain.startsWith("xn--") && p.unicode), "IDN variant in punycode");
  assert.strictEqual(new Set(names).size, names.length, "no duplicates");
  assert.ok(names.every(checks.isValidDomain));
  assert.strictEqual(a[0].fuzzer, "tld-swap", "priority order");
});

test("keywords skip short labels", () => {
  assert.deepStrictEqual(brandKeywords(["uniswap.org", "gmx.io"], ["UNI-claim", "x"]), ["uni-claim", "uniswap"]);
});

// --- scoring ----------------------------------------------------------------------

test("risk score: not registered, full impersonation, parked", () => {
  assert.strictEqual(riskScore({ dns: { exists: false } }).score, 0);
  const high = riskScore({
    dns: { exists: true, resolves: true, mx: ["mx"] },
    rdap: { registered: true, age_days: 5 },
    cert: { currently_valid: true, issued_days_ago: 3 },
    page: { reachable: true, brand_in_title: true, icon_sha256: ICON, title: "Uniswap Interface", wallet_prompt: true },
    official: { icon_sha256: ICON, title: "Uniswap Interface" },
  });
  assert.strictEqual(high.level, "high");
  assert.strictEqual(high.status, "copies_brand");
  assert.strictEqual(high.score, 100);
  const parked = riskScore({ dns: { exists: true, resolves: true, mx: [] }, page: { reachable: true, parked: true } });
  assert.strictEqual(parked.status, "parked");
  assert.strictEqual(parked.level, "low");
  const defensive = riskScore({
    dns: { exists: true, resolves: true, mx: [] }, rdap: { registered: true, age_days: 5 },
    page: { reachable: true, final_host: "app.uniswap.org", brand_in_title: true, wallet_prompt: true },
    official: { domains: ["uniswap.org"] },
  });
  assert.strictEqual(defensive.status, "redirects_to_official");
  assert.strictEqual(defensive.score, 0);
  const cf = ["art.ns.cloudflare.com", "elaine.ns.cloudflare.com"];
  const mirror = riskScore({
    dns: { exists: true, resolves: true, mx: [], ns: [...cf].reverse() },
    page: { reachable: true, brand_in_title: true, title: "Aave", wallet_prompt: true },
    official: { domains: ["aave.com"], title: "Aave", ns_sets: [cf.join(",")] },
  });
  assert.strictEqual(mirror.status, "likely_brand_owned");
  assert.ok(mirror.score <= 20);
  const shared = ["ns1.dnsowl.com", "ns2.dnsowl.com"];
  assert.strictEqual(sharesOfficialDns(shared, [shared.join(",")]), false, "registrar default nameservers prove nothing");
});

test("homepage analysis and robots.txt", () => {
  const html = Buffer.from('<html><head><title>Uniswap | Claim</title><link rel="shortcut icon" href="/i.png"></head><body><input type="password"> Connect Wallet</body></html>');
  const s = fingerprint.analyzeHtml(html, ["uniswap"]);
  assert.deepStrictEqual(s, { title: "Uniswap | Claim", brand_in_title: true, brand_terms_in_title: ["uniswap"], brand_in_page: true, has_password_form: true, wallet_prompt: true, bank_claim: false, host_phishing_warning: false, taken_down: false, parked: false, icon_href: "/i.png" });
  assert.strictEqual(fingerprint.analyzeHtml(Buffer.from("<title>For Sale Domain: uniswap.pro</title>"), ["uniswap"]).parked, true);
  assert.strictEqual(checks.robotsDisallowsRoot("User-agent: *\nDisallow: /"), true);
  assert.strictEqual(checks.robotsDisallowsRoot("User-agent: Googlebot\nDisallow: /\nUser-agent: *\nDisallow: /admin"), false);
  assert.strictEqual(checks.isPrivateOrReservedIp("10.1.2.3"), true);
  assert.strictEqual(checks.isPrivateOrReservedIp("203.0.113.10"), false);
});

// --- the engine -----------------------------------------------------------------

test("scanBrand finds, scores and evidences the lookalikes", async () => {
  const r = await scanBrand({ brand: "Uniswap", official_domains: ["uniswap.org"] }, { ctHits: [{ domain: "uniswap-claim.org", log: "test", index: 7, timestamp: 1 }] });
  const by = Object.fromEntries(r.findings.map((f) => [f.domain, f]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["uniswap-claim.org", "uniswap.xyz", "unlswap.org"]);
  assert.strictEqual(by["uniswap-claim.org"].status, "copies_brand");
  assert.strictEqual(by["uniswap-claim.org"].risk_level, "high");
  assert.strictEqual(by["uniswap-claim.org"].fuzzer, "ct-log");
  assert.strictEqual(by["uniswap.xyz"].status, "parked");
  assert.strictEqual(by["unlswap.org"].status, "refused_private_address");
  assert.strictEqual(r.findings[0].domain, "uniswap-claim.org", "sorted by risk");
  assert.strictEqual(r.official_fingerprint.icon_sha256, ICON);
  const ids = new Set(r.evidence.map((e) => e.evidence_id));
  assert.ok(r.findings.every((f) => ids.has(f.evidence_id)));
  assert.strictEqual(r.evidence.find((e) => e.domain === "uniswap-claim.org").ct_log_entry.index, 7);
  assert.strictEqual(r.coverage.partial, false);
  assert.deepStrictEqual(checkResult(r, { brands: { "uniswap.org": {} } }), []);
});

test("deadline makes a partial, DNS-only scan", async () => {
  const r = await scanBrand({ brand: "Uniswap", official_domains: ["uniswap.org"] }, { deepLimit: 0, skipOfficial: true });
  assert.ok(r.findings.every((f) => f.checked === "dns_only"));
  const unvetted = r.findings.filter((f) => f.status !== "refused_private_address");
  assert.ok(unvetted.length > 0 && unvetted.every((f) => f.risk_level === "unchecked"), "a DNS-only finding is never called low");
  assert.strictEqual(r.coverage.full_checks, 0);
  assert.strictEqual(r.coverage.partial, true);
});

test("a candidate cap is partial and shared across official domains", async () => {
  const r = await scanBrand({ brand: "Uniswap", official_domains: ["uniswap.org", "uniswap.com"] }, { maxCandidates: 10, deepLimit: 0, skipOfficial: true });
  assert.ok(r.coverage.candidates_generated > 10);
  assert.strictEqual(r.coverage.candidates_dns_checked, 10);
  assert.strictEqual(r.coverage.partial, true, "names cut by the cap make the scan partial");
  const full = await scanBrand({ brand: "Uniswap", official_domains: ["uniswap.org"] }, { deepLimit: 0, skipOfficial: true, maxCandidates: 10000 });
  assert.strictEqual(full.coverage.candidates_dns_checked, full.coverage.candidates_generated);
});

// --- store ------------------------------------------------------------------------

test("merge keeps first_seen, stamps changes, keeps vanished findings 30 days", () => {
  const f = (domain, risk, status = "live") => ({ domain, risk, status, evidence_id: "0".repeat(24) });
  const prev = { findings: store.mergeFindings(null, [f("a.com", 20), f("b.com", 50)], "2026-10-01T00:00:00Z") };
  const next = store.mergeFindings(prev, [f("a.com", 20), f("c.com", 80)], "2026-10-08T00:00:00Z");
  const by = Object.fromEntries(next.map((x) => [x.domain, x]));
  assert.strictEqual(by["a.com"].first_seen, "2026-10-01T00:00:00Z");
  assert.strictEqual(by["a.com"].changed_at, "2026-10-01T00:00:00Z");
  assert.strictEqual(by["c.com"].first_seen, "2026-10-08T00:00:00Z");
  assert.strictEqual(by["b.com"].status, "no_longer_seen");
  const later = store.mergeFindings({ findings: next }, [f("a.com", 20)], "2026-12-01T00:00:00Z");
  assert.ok(!later.some((x) => x.domain === "b.com"), "dropped after 30 days");
});

test("a domain made official leaves the stored report at once", () => {
  const f = (domain, risk) => ({ domain, risk, status: "copies_brand", evidence_id: "0".repeat(24) });
  const base = { brand_id: "alchemix.fi", brand: "Alchemix", evidence: [] };
  store.saveResult({ ...base, official_domains: ["alchemix.fi"], as_of: "2026-11-03T09:53:04Z", findings: [f("alchemix.finance", 80), f("alchemix.dev", 35)] });
  store.saveResult({ ...base, official_domains: ["alchemix.fi", "alchemix.finance"], as_of: "2026-11-03T13:35:20Z", findings: [f("alchemix.dev", 35)] });
  assert.deepStrictEqual(store.loadBrand("alchemix.fi").findings.map((x) => x.domain), ["alchemix.dev"]);
});

test("ingest: third-party text can't block a report; our own fields and the token still can", () => {
  const id = "014e83aa-1111-4222-8333-444455556666";
  const base = { brand_id: "x.com", as_of: "2026-01-01T00:00:00Z", findings: [], evidence: [] };
  const watch = { brands: { "x.com": {} } };
  const third = { ...base, official_fingerprint: { title: id }, evidence: [{ evidence_id: "a".repeat(24), homepage: { title: id, final_url: `https://t.example/visit/${id}`, redirect_chain: [{ url: `https://t.example/${id}` }], sha256: "a".repeat(64) }, rdap: { registrar: id }, certificate: { issuer_org: id }, dns: { ns: [id] } }] };
  assert.deepStrictEqual(checkResult(third, watch), []);
  assert.match(checkResult({ ...base, collector_warnings: [id] }, watch).join(), /key-like/);
  const before = process.env.BP_INGEST_TOKEN;
  process.env.BP_INGEST_TOKEN = "our-own-ingest-token-value";
  try {
    assert.match(checkResult({ ...third, evidence: [{ ...third.evidence[0], homepage: { title: "our-own-ingest-token-value" } }] }, watch).join(), /key-like/);
  } finally {
    if (before === undefined) delete process.env.BP_INGEST_TOKEN; else process.env.BP_INGEST_TOKEN = before;
  }
});

test("ingest rejects unknown brands and key-like strings; token check", () => {
  const ok = { brand_id: "x.com", as_of: "2026-11-02T00:00:00Z", findings: [], evidence: [] };
  assert.deepStrictEqual(checkResult(ok, { brands: { "x.com": {} } }), []);
  assert.match(checkResult(ok, { brands: {} })[0], /not on the watch list/);
  const leaky = { ...ok, note: "CG-abcdefghijklmnopqrstuvwx" };
  assert.match(checkResult(leaky, { brands: { "x.com": {} } }).join(), /key-like/);
  assert.strictEqual(tokenOk("Bearer test-token-not-secret", "test-token-not-secret"), true);
  assert.strictEqual(tokenOk("Bearer wrong", "test-token-not-secret"), false);
  assert.strictEqual(tokenOk(undefined, "test-token-not-secret"), false);
});

// --- HTTP: paid API + private ingest --------------------------------------------

function call(server, method, p, body, headers = {}) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test("routes: quick scan, Pi push, since filter, evidence, watched, errors", async (t) => {
  const { server, ingest } = require("../server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  await new Promise((r) => (ingest.listening ? r() : ingest.once("listening", r)));
  t.after(() => { server.close(); ingest.close(); });

  const first = await call(server, "POST", "/v1/brand/scan", { brand: "Uniswap", official_domains: ["uniswap.org"] });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.scan_type, "quick");
  assert.strictEqual(first.body.full_scan, "queued");
  assert.ok(first.body.findings.every((f) => f.checked === "dns_only"));

  assert.strictEqual((await call(ingest, "GET", "/ingest/watch")).status, 401);
  const watch = await call(ingest, "GET", "/ingest/watch", undefined, { Authorization: "Bearer test-token-not-secret" });
  assert.deepStrictEqual(watch.body.brands.map((b) => b.brand_id), ["uniswap.org"]);

  const full = await scanBrand({ brand: "Uniswap", official_domains: ["uniswap.org"] });
  const push = await call(ingest, "POST", "/ingest/results", { results: [full] }, { Authorization: "Bearer test-token-not-secret" });
  assert.deepStrictEqual(push.body, { accepted: ["uniswap.org"], rejected: [] });

  const second = await call(server, "POST", "/v1/brand/scan", { official_domains: ["uniswap.org"] });
  assert.strictEqual(second.body.scan_type, "full");
  assert.strictEqual(second.body.full_scan, "done");
  assert.strictEqual(second.body.findings[0].domain, "uniswap-claim.org");

  const none = await call(server, "POST", "/v1/brand/scan", { official_domains: ["uniswap.org"], since: new Date(Date.now() + 60_000).toISOString() });
  assert.strictEqual(none.body.findings_total, 0);

  const ev = await call(server, "POST", "/v1/brand/evidence", { evidence_id: second.body.findings[0].evidence_id });
  assert.strictEqual(ev.status, 200);
  assert.strictEqual(ev.body.domain, "uniswap-claim.org");
  assert.strictEqual((await call(server, "POST", "/v1/brand/evidence", { evidence_id: "f".repeat(24) })).status, 404);

  const look = await call(server, "POST", "/v1/brand/lookalikes", { domain: "uniswap.org" });
  assert.strictEqual(look.body.source, "watch_list");
  const live = await call(server, "POST", "/v1/brand/lookalikes", { domain: "example.com" });
  assert.strictEqual(live.body.source, "live_dns_only");

  const w = await call(server, "GET", "/v1/brand/watched");
  assert.strictEqual(w.body.count, 1);
  assert.strictEqual(w.body.brands[0].high_risk_findings, 1);

  assert.strictEqual((await call(server, "POST", "/v1/brand/scan", { official_domains: ["not a domain"] })).status, 422);
  assert.strictEqual((await call(server, "POST", "/v1/brand/scan", { official_domains: ["uniswap.org"], limit: 999 })).status, 422);
  assert.strictEqual((await call(server, "GET", "/v1/version")).body.service, "brand-protection");
});
