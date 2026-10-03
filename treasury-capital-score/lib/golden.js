// Helpers for the frozen v1 scoring contract (test/fixtures/golden, spec/tcs6_spec_v1.md).
"use strict";

// report_id is a random UUID per build; everything else in a v1 report is a pure
// function of (entity, evidence bundle, cohort peer NRTs, method version).
function normalizeReport(report) {
  return { ...report, report_id: "<report_id>" };
}

module.exports = { normalizeReport };
