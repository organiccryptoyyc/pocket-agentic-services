// openFDA adapter details that the end-to-end collector test can't see: the FAERS lag trim and
// the per-company series.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalogLib = require("../lib/catalog");
const openfda = require("../lib/adapters/openfda");

const DAY = 86400000;
const now = new Date("2026-10-04T06:00:00Z"); // a Sunday; the last complete week starts 2026-09-21
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

function ctxFor(catalog, lastLoaded) {
  return {
    now, env: {}, catalog,
    since: () => ymd(now.getTime() - 120 * DAY),
    eventSince: () => ymd(now.getTime() - 30 * DAY),
    fail: (ids, e) => { throw e; },
    async get(job, url) {
      const u = new URL(url);
      if (u.pathname.endsWith("drugsfda.json")) {
        const date = ymd(now.getTime() - 10 * DAY).replace(/-/g, "");
        return { status: 200, sha256: "x", text: JSON.stringify({ results: [
          { application_number: "BLA761408", sponsor_name: "ELI LILLY AND CO", submissions: [{ submission_type: "ORIG", submission_number: "1", submission_status: "AP", submission_status_date: date }] },
          { application_number: "ANDA200001", sponsor_name: "OTHER CO", submissions: [{ submission_type: "ORIG", submission_number: "1", submission_status: "AP", submission_status_date: date }] },
        ] }) };
      }
      if (u.pathname.endsWith("enforcement.json") && !u.searchParams.get("count")) return { status: 404, sha256: "x", text: JSON.stringify({ error: { code: "NOT_FOUND" } }) };
      // Daily counts up to lastLoaded for FAERS (the FDA hasn't loaded later days), up to yesterday otherwise.
      const end = /receivedate/.test(u.searchParams.get("count")) ? Date.parse(lastLoaded) : now.getTime() - DAY;
      const results = [];
      for (let t = now.getTime() - 120 * DAY; t <= end; t += DAY) results.push({ time: ymd(t).replace(/-/g, ""), count: 900 });
      return { status: 200, sha256: "x", text: JSON.stringify({ results }) };
    },
  };
}

test("FAERS stops at the last complete loaded week instead of storing zeros", async () => {
  const catalog = catalogLib.load();
  const series = catalog.series.filter((s) => s.source_id === "openfda");
  const out = await openfda.collect(series, ctxFor(catalog, "2026-09-16")); // loaded through a Wednesday
  const faers = out.observations.filter((o) => o.series_id === "openfda:adverse_event_reports_weekly");
  const last = faers.map((o) => o.observation_time).sort().pop();
  assert.equal(last, "2026-09-07", "the Monday week of 09-14 is only half loaded, so the last stored week is 09-07");
  assert.ok(faers.every((o) => o.value > 0));
  const recalls = out.observations.filter((o) => o.series_id === "openfda:drug_recalls_weekly");
  assert.equal(recalls.map((o) => o.observation_time).sort().pop(), "2026-09-21", "other count series are not trimmed");
  const lilly = out.observations.filter((o) => o.series_id === "openfda:LLY:adverse_event_reports_weekly");
  assert.equal(lilly.map((o) => o.observation_time).sort().pop(), "2026-09-07", "per-company FAERS is trimmed too");
});

test("per-company approvals count only that company's sponsor", async () => {
  const catalog = catalogLib.load();
  const series = catalog.series.filter((s) => s.source_id === "openfda");
  const out = await openfda.collect(series, ctxFor(catalog, "2026-10-03"));
  const sum = (id) => out.observations.filter((o) => o.series_id === id).reduce((a, o) => a + o.value, 0);
  assert.equal(sum("openfda:LLY:approvals_weekly"), 1);
  assert.equal(sum("openfda:PFE:approvals_weekly"), 0);
  assert.equal(sum("openfda:approvals_nda_bla_weekly"), 1);
  assert.equal(sum("openfda:approvals_anda_weekly"), 1);
  for (const t of ["PFE", "LLY", "JNJ"]) {
    for (const m of ["drug_recalls_weekly", "adverse_event_reports_weekly", "approvals_weekly", "label_updates_weekly"]) {
      assert.ok(series.some((s) => s.series_id === `openfda:${t}:${m}`), `${t} ${m}`);
    }
  }
});

test("company aliases: J&J's FDA searches also match Janssen", async () => {
  const catalog = catalogLib.load();
  const series = catalog.series.filter((s) => s.source_id === "openfda" && s.entity_id === "jnj");
  const ctx = ctxFor(catalog, "2026-10-03");
  const urls = [];
  const get = ctx.get.bind(ctx);
  ctx.get = (job, url, ...rest) => { urls.push(decodeURIComponent(url)); return get(job, url, ...rest); };
  await openfda.collect(series, ctx);
  for (const field of ["recalling_firm", "patient.drug.openfda.manufacturer_name", "openfda.manufacturer_name"]) {
    assert.ok(urls.some((u) => u.includes(`${field}:"Johnson & Johnson" OR ${field}:"Janssen"`) || u.includes(`${field}:"Johnson+&+Johnson"+OR+${field}:"Janssen"`)), field);
  }
});
