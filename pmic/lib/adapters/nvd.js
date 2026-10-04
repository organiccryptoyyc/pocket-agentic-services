// NIST National Vulnerability Database, CVE API 2.0: one request per complete month and series,
// asking only for totalResults (resultsPerPage=1). All CVEs published that month, and those with a
// CRITICAL CVSS v3 severity. Without NVD_API_KEY the API allows 5 requests per 30 seconds, so
// requests are spaced 6.5 s apart (0.7 s with a key).
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");

const BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CITE = "https://nvd.nist.gov/vuln/search";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const key = ctx.env.NVD_API_KEY;
  const gap = ctx.env.PMIC_NVD_GAP_MS !== undefined ? Number(ctx.env.PMIC_NVD_GAP_MS) : key ? 700 : 6500;
  const headers = key ? { apiKey: key } : {};
  let first = true;
  for (const s of series) {
    try {
      const extra = s.params.feed === "critical" ? "&cvssV3Severity=CRITICAL" : s.params.feed === "all" ? "" : null;
      if (extra === null) throw new SchemaError(`nvd: unknown feed '${s.params.feed}'`);
      for (const m of completeMonths(ctx.since(s), ctx.now)) {
        if (!first) await sleep(gap);
        first = false;
        const url = `${BASE}?pubStartDate=${m}T00:00:00.000&pubEndDate=${addMonths(m, 1)}T00:00:00.000&resultsPerPage=1${extra}`;
        const r = await ctx.get(`nvd:${s.series_id}:${m}`, url, { headers });
        const body = parseJson(r.text, `nvd ${s.series_id}`);
        if (typeof body.totalResults !== "number") throw new SchemaError("nvd: no totalResults");
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: body.totalResults, source_url: CITE, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect };
