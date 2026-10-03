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
