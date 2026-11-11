// 0.1.9: the shared `verified` block (pocket-agentic-envelope/1) on scan, lookalikes and evidence.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { withVerified } = require("../lib/verified");

const ENV = path.join(__dirname, "..", "..", "docs", "envelope");
const schema = JSON.parse(fs.readFileSync(path.join(ENV, "pocket-agentic-envelope-v1.schema.json"), "utf8"));
const validator = import(pathToFileURL(path.join(ENV, "validate.mjs")).href);
const valid = async (v) => assert.deepStrictEqual((await validator).validate(schema, v), []);
const NOW = Date.parse("2026-11-11T18:00:00Z");

const report = (over = {}) => ({
  service: "brand-protection", version: "0.1.9", fetched_at: "2026-11-11T18:00:00.000Z",
  brand_id: "aave.com", brand: "Aave", official_domains: ["aave.com", "app.aave.com"],
  as_of: "2026-11-11T09:40:00.000Z", age_hours: 8.3, scan_type: "full", full_scan: "done", collector_warnings: [],
  method: "bp-risk/5",
  coverage: { candidates_generated: 900, candidates_dns_checked: 900, dns_errors: 0, existing: 40, full_checks: 40, ct_hits: 0, partial: false, duration_ms: 1 },
  since: null, findings_total: 2, findings_returned: 2,
  findings: [{ domain: "aave-claim.com", risk: 80, risk_level: "high", evidence_id: "a".repeat(24) }, { domain: "aavee.com", risk: 20, risk_level: "low", evidence_id: "b".repeat(24) }],
  ...over,
});

test("the vendored core is an unchanged copy of docs/envelope/verified-core.js", () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "..", "lib", "verified-core.js"), "utf8"), fs.readFileSync(path.join(ENV, "verified-core.js"), "utf8"));
});

test("scan: the brand, its official domains and where the evidence lives", async () => {
  const out = withVerified("/v1/brand/scan", report(), "0.1.9", NOW);
  const v = out.verified;
  await valid(v);
  assert.strictEqual(out.findings_total, 2, "existing fields unchanged");
  assert.strictEqual(v.subject.id, "brand:bp:aave.com");
  assert.deepStrictEqual(v.subject.links.map((l) => [l.rel, l.id, l.service]), [["official_domain", "domain:dns:aave.com", "agent-trust"], ["official_domain", "domain:dns:app.aave.com", "agent-trust"]]);
  assert.strictEqual(v.as_of, "2026-11-11T09:40:00.000Z");
  assert.strictEqual(v.assessment.status, "not_scored");
  assert.strictEqual(v.assessment.label, "2 findings, 1 high risk in this page");
  assert.deepStrictEqual(v.evidence, []);
  assert.deepStrictEqual(v.evidence_more.route, "/v1/brand/evidence");
  assert.strictEqual(v.evidence_more.count, 2);
  assert.deepStrictEqual(v.gaps, []);
});

test("lookalikes on a quick, partial scan: the limits become gaps", async () => {
  const v = withVerified("/v1/brand/lookalikes", report({ scan_type: "quick", collector_warnings: ["held"], findings_total: 0, findings: [],
    coverage: { candidates_generated: 900, candidates_dns_checked: 120, dns_errors: 3, existing: 9, full_checks: 0, partial: true } }), "0.1.9", NOW).verified;
  await valid(v);
  assert.deepStrictEqual(v.gaps.map((g) => g.field), ["scan_type", "coverage", "dns_errors", "collector"]);
  assert.strictEqual(v.evidence_more, null);
  assert.strictEqual(v.assessment.label, "0 findings");
});

test("evidence: the lookalike domain, linked to the brand, one item per lookup that answered", async () => {
  const rec = {
    service: "brand-protection", version: "0.1.9", fetched_at: "2026-11-11T18:00:00.000Z",
    evidence_id: "a".repeat(24), brand_id: "aave.com", domain: "aave-claim.com", collected_at: "2026-11-11T09:40:00.000Z", method: "bp-risk/5",
    sources: [
      { kind: "dns", url: "dns:aave-claim.com", fetched_at: "2026-11-11T09:40:00.000Z", ok: true },
      { kind: "rdap", url: "rdap:aave-claim.com", fetched_at: "2026-11-11T09:40:01.000Z", ok: true },
      { kind: "tls", url: "tls:aave-claim.com:443", fetched_at: "2026-11-11T09:40:02.000Z", ok: false, error: "connect timeout" },
      { kind: "http", url: "https://aave-claim.com/", fetched_at: "2026-11-11T09:40:03.000Z", ok: true },
    ],
  };
  const v = withVerified("/v1/brand/evidence", rec, "0.1.9", NOW).verified;
  await valid(v);
  assert.strictEqual(v.subject.id, "domain:dns:aave-claim.com");
  assert.deepStrictEqual(v.subject.links, [{ rel: "lookalike_of", id: "brand:bp:aave.com", service: "brand-protection" }]);
  assert.deepStrictEqual(v.evidence.map((e) => [e.source_ref, e.source_tier, e.url]), [["dns:aave-claim.com", 1, null], ["rdap:aave-claim.com", 1, null], ["http:aave-claim.com", 2, "https://aave-claim.com/"]]);
  assert.deepStrictEqual(v.gaps.map((g) => [g.field, g.reason]), [["sources.tls", "connect timeout"]]);
});

test("routes without a mapping are returned unchanged", () => {
  const w = { count: 0, brands: [] };
  assert.strictEqual(withVerified("/v1/brand/watched", w, "0.1.9", NOW), w);
});
