#!/usr/bin/env node
// Freezes the live v1 scoring contract as golden fixtures.
//
//   node ops/freeze-golden.js            # write test/fixtures/golden/<case>.json (refuses to overwrite)
//   node ops/freeze-golden.js --force    # re-freeze: ONLY with owner sign-off (a live output changed)
//
// Each case is self-contained: the exact evidence bundle, the cohort peer NRTs, and the report the
// engine produced from them. test/golden.test.js recomputes every report and requires byte-for-byte
// equality (after replacing the random report_id). All entities are synthetic.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-golden-"));

const S = require("../lib/scoring");
const { buildReport, insufficientReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");
const { normalizeReport } = require("../lib/golden");

const OUT = path.join(__dirname, "..", "test", "fixtures", "golden");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", "evidence-example.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const entity = (id, extra = {}) => ({ entity_id: id, name: id, entity_type: "defi_protocol", peer_cohort: "DeFi protocol", registry_status: "partially_verified", eligibility: "confirmed", scoreable: true, treasury_perimeter: "synthetic", ...extra });

const PEERS_24 = Array.from({ length: 24 }, (_, i) => (i + 1) * 5e6);

const CASES = {
  "01-example-ready": {
    note: "Example bundle, cohort below 20: D1 null, coverage 80, eligible, ready.",
    bundle: () => clone(EXAMPLE),
  },
  "02-d1-with-24-peers": {
    note: "Same bundle against 24 synthetic peer NRTs: D1 percentile computed, coverage 100.",
    bundle: () => clone(EXAMPLE),
    peers: PEERS_24,
  },
  "03-obligations-unknown": {
    note: "Obligation visibility unknown: overall score withheld, insufficient_data.",
    bundle: () => { const b = clone(EXAMPLE); b.obligations = { visibility: "unknown" }; return b; },
  },
  "04-low-control-provisional": {
    note: "Large unverified holding: control coverage under 60%, provisional, confidence capped.",
    bundle: () => { const b = clone(EXAMPLE); b.holdings.push({ ...clone(b.holdings[2]), asset_id: "y", control: "unverified", quantity: 400000000 }); return b; },
  },
  "05-correlated-cap": {
    note: "ETH-correlated group above 50%: D4 capped at 60.",
    bundle: () => {
      const b = clone(EXAMPLE);
      b.holdings[1].correlation_group = "eth";
      b.holdings.push({ ...clone(b.holdings[1]), asset_id: "eth:steth", asset_class: "liquid_alt", quantity: 40000, correlation_group: "eth" });
      return b;
    },
  },
  "06-hqla-impaired": {
    note: "USDC flagged redemption_limits: removed from D2 liquid assets.",
    bundle: () => { const b = clone(EXAMPLE); b.holdings[0].haircut_flags = ["redemption_limits"]; return b; },
  },
  "07-no-cash-uses": {
    note: "No 12-month cash-use data: D2 at the blueprint 0 anchor.",
    bundle: () => { const b = clone(EXAMPLE); b.cash_uses_12m = null; return b; },
  },
  "08-insufficient-unvetted": {
    note: "Unvetted registry entity: insufficient-data report (fixed timestamp).",
    insufficient: { entity: entity("unvetted-dao", { scoreable: false, registry_status: "unverified", eligibility: "needs_first_time_vetting" }), reason: "not vetted", now: "2026-10-02T00:00:00.000Z" },
  },
};

function build(c) {
  if (c.insufficient) return insufficientReport(c.insufficient.entity, c.insufficient.reason, c.insufficient.now);
  const bundle = c.bundleValue;
  const base = S.computeBase(bundle);
  return buildReport(entity(bundle.entity_id), bundle, base, c.peers && c.peers.length ? c.peers : [base.nrt]);
}

function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, c] of Object.entries(CASES)) {
    const file = path.join(OUT, `${name}.json`);
    if (fs.existsSync(file) && !force) { console.log(`keep    ${name} (exists; --force to re-freeze)`); continue; }
    if (c.bundle) c.bundleValue = c.bundle();
    const report = build(c);
    const v = validateReport(report);
    if (!v.ok) throw new Error(`${name}: schema-invalid report: ${v.errors.slice(0, 5).join("; ")}`);
    const golden = {
      case: name,
      note: c.note,
      method_version: report.overall_score ? report.overall_score.method_version : null,
      schema_version: report.schema_version,
      input: c.insufficient ? { insufficient: c.insufficient } : { entity: entity(c.bundleValue.entity_id), bundle: c.bundleValue, peer_nrts: c.peers || null },
      expected_report: normalizeReport(report),
    };
    fs.writeFileSync(file, JSON.stringify(golden, null, 2) + "\n", "utf8");
    console.log(`frozen  ${name}: ${report.analysis_status} score=${report.overall_score ? report.overall_score.score : "-"}`);
  }
}

if (require.main === module) main();
module.exports = { CASES, build };
