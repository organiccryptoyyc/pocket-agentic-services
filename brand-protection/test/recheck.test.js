// node --test test/recheck.test.js  (no network: every check is stubbed)
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const checks = require("../lib/checks");
const fingerprint = require("../lib/fingerprint");
const { recheckDomain, compareRecords, canonicalJson, verifyRecord } = require("../lib/recheck");

const ICON = "a".repeat(64);
const WORLD = {
  "brand.org": { a: ["198.51.100.1"], ns: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], page: { title: "Brand App", icon_sha256: ICON, final_host: "brand.org" } },
  "brand-claim.org": { a: ["203.0.113.10"], mx: ["mx.brand-claim.org"], age: 5, certDays: 3, page: { title: "Brand App", icon_sha256: ICON, wallet_prompt: true, wallet_terms: ["seed phrase"], brand_in_title: true, brand_in_page: true, final_host: "brand-claim.org" } },
  "brand.shop": { a: ["203.0.113.11"], age: 2000, certDays: 200, page: { title: "Brand new shoes", icon_sha256: "c".repeat(64), brand_in_title: true, brand_in_page: true, final_host: "brand.shop" } },
  "brand.xyz": { a: ["203.0.113.12"], age: 900, page: { title: "brand.xyz is for sale", parked: true, final_host: "brand.xyz" } },
  "brand.net": { a: ["203.0.113.13"], age: 900, page: { title: "Brand App", final_host: "brand.org" } },
  "brandd.org": { a: ["10.0.0.5"], age: 10 },
  "registered-only.org": { ns: ["ns1.example.net"], age: 40, noAddress: true },
};

let failures = {};
function maybeFail(kind) {
  if (failures[kind] > 0) { failures[kind]--; throw new Error(`${kind} failed (stub)`); }
}

test.beforeEach(() => {
  failures = {};
  checks.dnsProbe = async (domain) => {
    maybeFail("dns");
    const w = WORLD[domain];
    return w
      ? { domain, a: w.a || [], aaaa: [], mx: w.mx || [], ns: w.ns || ["ns1.example.net"], nxdomain: false, error: null, resolves: (w.a || []).length > 0, exists: true }
      : { domain, a: [], aaaa: [], mx: [], ns: [], nxdomain: true, error: null, resolves: false, exists: false };
  };
  checks.rdapLookup = async (domain, opts) => {
    maybeFail("rdap");
    assert.deepStrictEqual(opts, { detail: true });
    if (!WORLD[domain]) return { available: true, registered: false, source_url: `https://rdap.test/domain/${domain}` };
    return { available: true, registered: true, registered_at: "2026-10-28T00:00:00Z", expires_at: "2027-10-28T00:00:00Z", age_days: WORLD[domain].age, registrar: "Test Registrar", status: [] };
  };
  checks.tlsCertInfo = async (domain) => {
    maybeFail("tls");
    return { issuer_org: "Let's Encrypt", currently_valid: true, issued_days_ago: WORLD[domain].certDays ?? 200, sha256_fingerprint: "AB:CD" };
  };
  fingerprint.homepage = async (domain) => {
    maybeFail("http");
    return { fetched_at: "2026-11-02T00:00:00Z", reachable: true, status: 200, sha256: "b".repeat(64), brand_in_title: false, brand_in_page: false, has_password_form: false, wallet_prompt: false, parked: false, ...WORLD[domain].page };
  };
});

const OFFICIAL = { official_domains: ["brand.org"] };

test("a copy of the brand is complete, high and corroborated", async () => {
  const r = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL });
  assert.strictEqual(r.schema, "bp-recheck/1");
  assert.strictEqual(r.completeness.complete, true);
  assert.deepStrictEqual(r.completeness.missing, []);
  assert.strictEqual(r.assessment.risk_level, "high");
  assert.strictEqual(r.assessment.risk_is_floor, false);
  assert.strictEqual(r.assessment.brand_comparison, "compared");
  assert.strictEqual(r.assessment.corroboration.summary, "corroborated");
  assert.ok(r.assessment.corroboration.strong.some((s) => /icon identical/.test(s)));
  assert.ok(r.assessment.corroboration.strong.some((s) => /seed, recovery/.test(s)));
});

test("an ordinary word in a title is weak, whatever the score says", async () => {
  const r = await recheckDomain({ domain: "brand.shop", ...OFFICIAL });
  assert.strictEqual(r.assessment.corroboration.summary, "weak_signals_only");
  assert.deepStrictEqual(r.assessment.corroboration.strong, []);
});

test("a password field on a page with the brand word doesn't corroborate", async () => {
  WORLD["brand.shop"].page = { ...WORLD["brand.shop"].page, has_password_form: true };
  const r = await recheckDomain({ domain: "brand.shop", ...OFFICIAL });
  delete WORLD["brand.shop"].page.has_password_form;
  assert.strictEqual(r.assessment.corroboration.summary, "weak_signals_only");
  assert.ok(r.assessment.corroboration.weak.includes("page has a password field"));
});

test("the registry outranks an empty DNS answer", async () => {
  checks.rdapLookup = async () => ({ available: true, registered: true, registered_at: "2026-11-03T00:00:00Z", age_days: 1, registrar: "Test Registrar", status: [] });
  const r = await recheckDomain({ domain: "just-registered.org" });
  assert.strictEqual(r.assessment.status, "registered_no_dns");
  assert.strictEqual(r.assessment.risk, 30);
  assert.strictEqual(r.assessment.risk_level, "low");
  assert.ok(r.assessment.reasons[0].startsWith("registered at the registry"));
  assert.ok(r.assessment.reasons.some((x) => x.startsWith("registered 1 days ago")));
});

test("no DNS and no registry answer is unknown, not unregistered", async () => {
  failures.rdap = 1;
  const r = await recheckDomain({ domain: "unknown-name.org" });
  assert.strictEqual(r.assessment.status, "not_in_dns_registry_unknown");
  assert.strictEqual(r.assessment.risk_level, "unchecked");
  assert.strictEqual(r.assessment.risk_is_floor, true);
});

test("sources are listed in a fixed order", async () => {
  const r = await recheckDomain({ domain: "brand.shop" });
  assert.deepStrictEqual(r.sources.map((s) => s.kind), ["dns", "rdap", "tls", "http"]);
});

test("parked and brand-owned domains say so", async () => {
  assert.strictEqual((await recheckDomain({ domain: "brand.xyz", ...OFFICIAL })).assessment.corroboration.summary, "parked");
  assert.strictEqual((await recheckDomain({ domain: "brand.net", ...OFFICIAL })).assessment.corroboration.summary, "likely_brand_owned");
});

test("a passing network failure is retried and recorded", async () => {
  failures.http = 1;
  failures.tls = 1;
  const r = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL, official_domains: [] });
  assert.strictEqual(r.completeness.http, "ok");
  assert.strictEqual(r.sources.find((s) => s.kind === "http").tries, 2);
  assert.strictEqual(r.sources.find((s) => s.kind === "tls").tries, 2);
});

test("a page that can't be read makes the score a floor, never a clean result", async () => {
  failures.http = 2;
  const r = await recheckDomain({ domain: "brand.shop", ...OFFICIAL, official_domains: [] });
  assert.strictEqual(r.completeness.http, "failed");
  assert.deepStrictEqual(r.completeness.missing, ["http"]);
  assert.strictEqual(r.assessment.risk_is_floor, true);
  assert.strictEqual(r.assessment.risk_level, "unchecked");
  assert.ok(r.sources.find((s) => s.kind === "http").error);
});

test("a TLS failure alone doesn't hide anything when the page was read", async () => {
  failures.tls = 2;
  const r = await recheckDomain({ domain: "brand.shop" });
  assert.strictEqual(r.completeness.tls, "failed");
  assert.strictEqual(r.completeness.complete, true);
  assert.strictEqual(r.certificate, null);
});

test("failed DNS says nothing about the name", async () => {
  failures.dns = 2;
  const r = await recheckDomain({ domain: "brand.shop" });
  assert.strictEqual(r.assessment.status, "dns_failed");
  assert.strictEqual(r.assessment.risk_level, "unchecked");
  assert.strictEqual(r.dns, null);
  assert.strictEqual(r.completeness.complete, false);
});

test("a private address stops the probe: no TLS, no page", async () => {
  let touched = false;
  checks.tlsCertInfo = async () => { touched = true; return {}; };
  fingerprint.homepage = async () => { touched = true; return {}; };
  const r = await recheckDomain({ domain: "brandd.org" });
  assert.strictEqual(r.assessment.status, "refused_private_address");
  assert.strictEqual(touched, false);
  assert.ok(r.completeness.missing.includes("refused_private_address"));
});

test("a name that doesn't exist, and one with no address, are plain answers", async () => {
  const none = await recheckDomain({ domain: "nothing-here.org" });
  assert.strictEqual(none.assessment.status, "not_registered");
  assert.strictEqual(none.completeness.complete, true);
  assert.strictEqual(none.completeness.http, "not_attempted");
  const noAddress = await recheckDomain({ domain: "registered-only.org" });
  assert.strictEqual(noAddress.assessment.status, "registered_not_live");
  assert.strictEqual(noAddress.completeness.complete, true);
});

test("robots.txt is honoured and leaves the score a floor", async () => {
  fingerprint.homepage = async () => ({ fetched_at: "t", reachable: true, skipped: "robots_txt" });
  const r = await recheckDomain({ domain: "brand.shop" });
  assert.strictEqual(r.completeness.http, "skipped_robots_txt");
  assert.strictEqual(r.assessment.risk_is_floor, true);
});

test("RDAP asks about the registered name, not a subdomain", async () => {
  let asked = null;
  checks.rdapLookup = async (d) => { asked = d; return { available: true, registered: true, age_days: 100, status: [] }; };
  await recheckDomain({ domain: "app.brand.shop" }).catch(() => {});
  assert.strictEqual(asked, "brand.shop");
});

test("no official domain means no brand comparison, and it says so", async () => {
  assert.strictEqual((await recheckDomain({ domain: "brand.shop" })).assessment.brand_comparison, "no_official_domain_given");
  fingerprint.homepage = async () => ({ reachable: false, error: "down" });
  assert.strictEqual((await recheckDomain({ domain: "brand.shop", ...OFFICIAL })).assessment.brand_comparison, "official_site_unavailable");
});

test("bad input is refused with a marked error", async () => {
  for (const domain of ["", "not a domain", "http://brand.org/", null]) {
    await assert.rejects(recheckDomain({ domain }), (e) => e.isInvalidInput === true);
  }
});

test("Unicode names are converted and shown both ways", async () => {
  const r = await recheckDomain({ domain: "bränd.org" });
  assert.ok(r.domain.startsWith("xn--"));
  assert.strictEqual(r.unicode, "bränd.org");
});

test("the record hash covers the record and catches edits", async () => {
  const r = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL });
  assert.match(r.integrity.record_sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(verifyRecord(r), true);
  assert.strictEqual(verifyRecord(JSON.parse(JSON.stringify(r))), true, "survives a JSON round trip");
  assert.strictEqual(verifyRecord({ ...r, assessment: { ...r.assessment, risk: 0 } }), false);
  assert.strictEqual(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("no raw page content can get into a record", async () => {
  const r = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL });
  assert.ok(!("body" in (r.homepage || {})));
  assert.ok(!/<html/i.test(JSON.stringify(r)));
});

test("changes list what moved, and a failed read is not a change", async () => {
  const first = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL });
  WORLD["brand-claim.org"].page = { ...WORLD["brand-claim.org"].page, title: "Claim your tokens" };
  const second = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL }, { previous: first });
  WORLD["brand-claim.org"].page = { ...WORLD["brand-claim.org"].page, title: "Brand App" };
  assert.strictEqual(second.changes.compared_to.id, first.record_id);
  assert.deepStrictEqual(second.changes.changed.map((c) => c.field), ["homepage.title"]);
  assert.strictEqual(second.changes.changed[0].to, "Claim your tokens");
  assert.strictEqual(verifyRecord(second), true);

  failures.http = 2;
  const third = await recheckDomain({ domain: "brand-claim.org", ...OFFICIAL, official_domains: [] }, { previous: first });
  assert.deepStrictEqual(third.changes.changed, []);
  assert.ok(third.changes.not_comparable.includes("homepage.title"));
});

test("changes also read the older evidence record shape", () => {
  const previous = { evidence_id: "abc", collected_at: "2026-11-01T00:00:00Z", dns: { ns: ["a", "b"], mx: [], a: ["1.1.1.1"], aaaa: [] }, rdap: { registrar: "Old" }, certificate: null, homepage: null };
  const current = { dns: { ns: ["b", "a"], mx: [], a: ["1.1.1.1"], aaaa: [] }, rdap: { registrar: "New" }, certificate: null, homepage: null };
  const c = compareRecords(previous, current);
  assert.strictEqual(c.compared_to.id, "abc");
  assert.deepStrictEqual(c.changed.map((x) => x.field), ["rdap.registrar"]);
});
