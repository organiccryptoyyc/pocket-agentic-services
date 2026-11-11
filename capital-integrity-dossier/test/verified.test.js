"use strict";
// The shared `verified` block (1.7.0). Synthetic snapshots only. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dossier-verified-"));
process.env.DOSSIER_TCS6_DATA_DIR = path.join(ROOT, "tcs6");
process.env.DOSSIER_DATA_DIR = path.join(ROOT, "own");
const store = require("../lib/store");
const D = require("../lib/dossier");
const A = require("../lib/availability");
const V = require("../lib/verified");

// The repo's schema validator (docs/envelope). The service folder alone (as packaged for PSM) skips this check.
const VALIDATOR = path.join(__dirname, "..", "..", "docs", "envelope", "validate.mjs");
const SCHEMA_FILE = path.join(__dirname, "..", "..", "docs", "envelope", "pocket-agentic-envelope-v1.schema.json");
async function schemaErrors(block) {
  if (!fs.existsSync(VALIDATOR)) return [];
  const { validate } = await import(pathToFileURL(VALIDATOR).href);
  return validate(JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")), block);
}

const AS_OF = "2026-11-09T19:14:45Z";
const NOW = Date.parse("2026-11-10T04:40:00Z");
const addr = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const [SAFE1, SAFE2, GOV, MON] = [addr(1), addr(2), addr(3), addr(4)];

function bundle() {
  return {
    entity_id: "demo", collected_at: AS_OF,
    holdings: [
      { asset_id: "eth:usdc", symbol: "USDC", chain: "ethereum", address: SAFE1, asset_class: "fiat_stablecoin", control: "verified", quantity: 1000000,
        holdings_observed_at: AS_OF, prices: [{ source_ref: "CG", usd: 1, observed_at: AS_OF }], haircut_flags: [] },
    ],
    obligations: { items: [] },
    governance: {
      reconciliation: { reported_total_usd: 1000000, reported_as_of: "2026-11-01", observed_usd_same_scope: 990000, scope_status: "comparable", source_refs: ["OWN"], netted_obligation_items: [], method: "min/max" },
      wallet_controls: [
        { chain: "ethereum", address: SAFE1, role: "treasury_safe", perimeter: "include", control: "safe", threshold: 2, signers: [] },
        { chain: "Ethereum", address: SAFE1, role: "duplicate", perimeter: "include", control: "safe", threshold: 2, signers: [] },
        { chain: "monad", address: MON, role: "monad_safe", perimeter: "include", control: "safe", threshold: 2, signers: [] },
        { chain: "ethereum", address: GOV, role: "governor", perimeter: "control_only", control: "contract" },
        { chain: "solana", address: SAFE2, role: "not_evm", perimeter: "include", control: "eoa" },
      ],
    },
    gaps: [{ field: "holdings.prices.ethereum:0xabc", reason: "XYZ had no price from any source", impact: "left out", remediation: "next run" }],
    sources: [
      { source_ref: "CG", title: "CoinGecko prices", publisher: "CoinGecko", url: "https://www.coingecko.com", raw: "never copied" },
      { source_ref: "OWN", title: "Demo transparency page", publisher: "Demo", url: "https://demo.example" },
    ],
  };
}

function report(over = {}) {
  return {
    report_id: "tcs6_demo-1", as_of: AS_OF, entity: { entity_id: "demo", name: "Demo DAO", entity_type: "dao", peer_cohort: "defi" },
    headline: { gross_adjusted_treasury_usd: 1000000 },
    overall_score: { score: 51, status: "provisional", coverage_pct: 85, decision_band: "watch" },
    confidence: { score: 72, label: "medium" },
    attestation: { verification_status: "valid", verification_detail: "signature verified with key tcs6-attest-test", payload: { attestation_id: "att-1", evidence_manifest_hash: "sha256:00" } },
    source_manifest: [
      { source_ref: "CG", title: "CoinGecko prices", publisher: "CoinGecko", url: "https://www.coingecko.com", retrieved_at: AS_OF, observation_time: AS_OF, source_tier: 2, rights_status: "permitted_for_derived_output" },
      { source_ref: "OWN", title: "Demo transparency page", publisher: "Demo", url: "https://demo.example", retrieved_at: AS_OF, observation_time: "2026-11-01", source_tier: 3, rights_status: "licensed_for_display" },
      { source_ref: "VENDOR", title: "Licensed feed", publisher: "Vendor", url: "https://vendor.example", retrieved_at: AS_OF, observation_time: null, source_tier: 2, rights_status: "internal_only" },
    ],
    data_gaps: [{ field: "D5", reason: "no flows", impact: "D5 not scored", remediation: "curate" }],
    hard_gates: [], dimensions: [], risks: [], capital_perimeter: {},
    disclaimer: "Research, not investment advice.",
    ...over,
  };
}

let seq = 0;
function seed(r = report(), b = bundle()) {
  const id = `demo-${++seq}`;
  for (const d of ["reports", "evidence"]) fs.mkdirSync(path.join(store.TCS6_DIR, d), { recursive: true });
  fs.writeFileSync(path.join(store.TCS6_DIR, "reports", `${id}.json`), JSON.stringify(r));
  fs.writeFileSync(path.join(store.TCS6_DIR, "evidence", `${id}.json`), JSON.stringify(b));
  store.ensureDirs();
  store.refreshPairs();
  return id;
}

test("plan carries a valid verified block with the TCS-6 judgement", async () => {
  const p = D.plan({ entity_id: seed() }, NOW);
  const v = p.verified;
  assert.deepStrictEqual(await schemaErrors(v), []);
  assert.strictEqual(v.schema, "pocket-agentic-envelope/1");
  assert.strictEqual(v.service, "capital-integrity-dossier");
  assert.strictEqual(v.service_version, "1.7.0");
  assert.strictEqual(v.route, "/v1/dossier/plan");
  assert.strictEqual(v.subject.id, "protocol:tcs6:demo");
  assert.deepStrictEqual(v.subject.identifiers, { tcs6_entity_id: "demo", entity_type: "dao", peer_cohort: "defi" });
  assert.strictEqual(v.as_of, AS_OF);
  assert.strictEqual(v.generated_at, "2026-11-10T04:40:00.000Z");
  assert.deepStrictEqual(v.assessment, { status: "provisional", native_status: "provisional", score: 51, scale: { min: 0, max: 100, higher_is: "better" },
    label: "watch", confidence: { score: 72, label: "medium" }, coverage_pct: 85 });
  assert.deepStrictEqual(v.attestation_ref, { attestation_id: "att-1", key_id: "tcs6-attest-test", payload_hash: "sha256:00", verification_status: "valid" });
  assert.deepStrictEqual(v.gaps, [{ field: "D5", reason: "no flows", impact: "D5 not scored", remediation: "curate" }]);
});

test("the dossier's own fields are unchanged; verified is one extra field", () => {
  const p = D.plan({ entity_id: seed() }, NOW);
  for (const k of ["schema_version", "dossier_id", "entity", "as_of", "snapshot_report_id", "headline", "sections", "calls_required", "estimate", "notice", "attestation_ref", "disclaimer"]) assert.ok(k in p, k);
  assert.deepStrictEqual(p.attestation_ref, { attestation_id: "att-1", key_id: "tcs6-attest-test", evidence_manifest_hash: "sha256:00", verification_status: "valid" });
  assert.strictEqual(p.schema_version, "capital-integrity-dossier/1.0");
});

test("links: included EVM wallets only, CAIP-10, de-duplicated, Monad mapped", () => {
  const v = D.plan({ entity_id: seed() }, NOW).verified;
  assert.deepStrictEqual(v.subject.links, [
    { rel: "treasury_wallet", id: `wallet:caip10:eip155:1:${SAFE1}`, service: null },
    { rel: "treasury_wallet", id: `wallet:caip10:eip155:143:${MON}`, service: null },
  ]);
});

test("evidence: internal_only sources and raw payloads never leave", () => {
  const v = D.plan({ entity_id: seed() }, NOW).verified;
  assert.deepStrictEqual(v.evidence.map((e) => e.source_ref), ["CG", "OWN"]);
  assert.ok(!JSON.stringify(v).includes("never copied"));
  assert.ok(!JSON.stringify(v).includes("VENDOR"));
  assert.strictEqual(v.evidence_more, null);
});

test("older snapshots without source_manifest fall back to the bundle with nulls", async () => {
  const r = report();
  delete r.source_manifest;
  const v = D.plan({ entity_id: seed(r) }, NOW).verified;
  assert.deepStrictEqual(await schemaErrors(v), []);
  assert.deepStrictEqual(v.evidence[0], { source_ref: "CG", title: "CoinGecko prices", publisher: "CoinGecko", url: "https://www.coingecko.com",
    retrieved_at: null, observation_time: null, source_tier: null, rights_status: "pending_review" });
});

test("sections are facts (not_scored) and cite only their own sources", async () => {
  const p = D.plan({ entity_id: seed() }, NOW);
  const rec = D.section({ dossier_id: p.dossier_id, section: "reconciliation" }, NOW);
  assert.deepStrictEqual(await schemaErrors(rec.verified), []);
  assert.strictEqual(rec.verified.route, "/v1/dossier/section");
  assert.strictEqual(rec.verified.assessment.status, "not_scored");
  assert.deepStrictEqual(rec.verified.evidence.map((e) => e.source_ref), ["OWN"]);
  const auth = D.section({ dossier_id: p.dossier_id, section: "authority_graph" }, NOW);
  assert.deepStrictEqual(await schemaErrors(auth.verified), []);
  assert.deepStrictEqual(auth.verified.evidence, []);
  assert.deepStrictEqual({ route: auth.verified.evidence_more.route, count: auth.verified.evidence_more.count }, { route: "/v1/dossier/plan", count: 2 });
});

test("availability: not_scored, unpriced tokens become gaps", async () => {
  const a = A.availability({ entity_id: seed() }, NOW);
  assert.deepStrictEqual(await schemaErrors(a.verified), []);
  assert.strictEqual(a.verified.route, "/v1/dossier/availability");
  assert.strictEqual(a.verified.assessment.status, "not_scored");
  assert.ok(a.verified.gaps.some((g) => g.field === "holdings.prices" && /XYZ/.test(g.reason)));
});

test("status and attestation edge cases", async () => {
  const none = D.plan({ entity_id: seed(report({ attestation: undefined, overall_score: { score: null, status: "insufficient_data" }, confidence: {} })) }, NOW).verified;
  assert.deepStrictEqual(await schemaErrors(none), []);
  assert.strictEqual(none.attestation_ref, null);
  assert.strictEqual(none.assessment.status, "insufficient_data");
  assert.strictEqual(none.assessment.confidence, null);
  const eligible = V.tcs6Assessment(report({ overall_score: { score: 80, status: "eligible" } }));
  assert.strictEqual(eligible.status, "ok");
  assert.strictEqual(eligible.native_status, "eligible");
  assert.strictEqual(V.attestationRef({ attestation: { verification_status: "absent" } }).verification_status, "missing");
});

test("evidence is capped at 50 with a pointer to the rest", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ source_ref: `S${i}`, title: `s${i}`, publisher: "p", url: null, retrieved_at: AS_OF,
    observation_time: null, source_tier: 1, rights_status: "permitted_for_derived_output" }));
  const v = D.plan({ entity_id: seed(report({ source_manifest: many })) }, NOW).verified;
  assert.deepStrictEqual(await schemaErrors(v), []);
  assert.strictEqual(v.evidence.length, 50);
  assert.deepStrictEqual({ route: v.evidence_more.route, count: v.evidence_more.count }, { route: "/v1/dossier/section", count: 60 });
});
