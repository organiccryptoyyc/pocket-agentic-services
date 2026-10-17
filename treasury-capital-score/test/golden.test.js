// Frozen v1 scoring contract (spec/tcs6_spec_v1.md §6). Every fixture in fixtures/golden is
// recomputed from its stored input and must match the stored report byte-for-byte (report_id
// normalized). A failure here means a live output changed: that needs owner sign-off, then
// `node ops/freeze-golden.js --force`. Synthetic entities only.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-golden-test-"));

const S = require("../lib/scoring");
const { buildReport, insufficientReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const { normalizeReport } = require("../lib/golden");

const DIR = path.join(__dirname, "fixtures", "golden");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

test("at least 5 golden fixtures are frozen", () => {
  assert.ok(files.length >= 5, `${files.length} fixtures`);
});

for (const f of files) {
  test(`golden ${f} reproduces byte-for-byte`, () => {
    const g = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    let report;
    if (g.input.insufficient) {
      const i = g.input.insufficient;
      report = insufficientReport(i.entity, i.reason, i.now);
    } else {
      const base = S.computeBase(g.input.bundle);
      const peers = g.input.peer_nrts && g.input.peer_nrts.length ? g.input.peer_nrts : [base.nrt];
      report = buildReport(g.input.entity, g.input.bundle, base, peers);
    }
    assert.ok(validateReport(report).ok, validateReport(report).errors.join("\n"));
    assert.strictEqual(JSON.stringify(normalizeReport(report), null, 2), JSON.stringify(g.expected_report, null, 2));
  });
}

test("every golden input bundle conforms to spec/evidence_input_v1.schema.json", () => {
  const { validate } = require("../lib/schema");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "spec", "evidence_input_v1.schema.json"), "utf8"));
  for (const f of files) {
    const g = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    if (!g.input.bundle) continue;
    const r = validate(schema, g.input.bundle);
    assert.ok(r.ok, `${f}: ${r.errors.join("; ")}`);
  }
});

test("a verification_summary (Verified layer 1.3) is schema-valid; without a signed attestation the report adds only attestation: missing", () => {
  const { validate } = require("../lib/schema");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "spec", "evidence_input_v1.schema.json"), "utf8"));
  const vs = {
    method_version: "pmic-verify-1.0", as_of: "2026-10-12T22:00:00Z", agreement_rate: 0.75,
    field_counts: { agree: 2, partial: 0, disagree: 1, unavailable: 0 }, fields_total: 2, truncated: false,
    fields: [
      { field: "price:ethereum:0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", label: "USDC", status: "agree", observed_at: "2026-10-12T21:00:00Z",
        sources: [{ source: "chainlink", agreement: "agree", delta_pct: 0.1 }, { source: "cmc", agreement: "agree", delta_pct: 0.2 }] },
      { field: "treasury.reconciled_usd", status: "disagree", observed_at: "2026-10-12T21:00:00Z",
        sources: [{ source: "report", agreement: "disagree", delta_pct: 12.4 }] },
    ],
  };
  let n = 0;
  for (const f of files) {
    const g = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    if (!g.input.bundle) continue;
    const bundle = { ...g.input.bundle, verification_summary: vs };
    const r = validate(schema, bundle);
    assert.ok(r.ok, `${f}: ${r.errors.join("; ")}`);
    const base = S.computeBase(bundle);
    const peers = g.input.peer_nrts && g.input.peer_nrts.length ? g.input.peer_nrts : [base.nrt];
    const report = buildReport(g.input.entity, bundle, base, peers);
    assert.ok(validateReport(report).ok, `${f}: ${validateReport(report).errors.join("; ")}`);
    const { attestation, ...rest } = report;
    assert.strictEqual(JSON.stringify(normalizeReport(rest), null, 2), JSON.stringify(g.expected_report, null, 2), `${f}: nothing but the block changes`);
    assert.equal(attestation.verification_status, "missing");
    assert.equal(attestation.payload, null);
    assert.equal(attestation.signature, null);
    n++;
  }
  assert.ok(n >= 1);
});
