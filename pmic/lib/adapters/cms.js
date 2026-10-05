// CMS Medicare Monthly Enrollment (data.cms.gov data API), no key: national beneficiaries each
// month, in total, in Original Medicare and in Medicare Advantage and other health plans.
// params.field is the column (TOT_BENES, ORGNL_MDCR_BENES, MA_AND_OTH_BENES).
"use strict";

const { SchemaError, num, parseJson, pad } = require("./common");

const URL_DATA = "https://data.cms.gov/data-api/v1/dataset/d7fabe1e-d19b-4333-9eff-e80e0643f2fd/data";
const CITE = "https://data.cms.gov/summary-statistics-on-beneficiary-enrollment/medicare-and-medicaid-reports/medicare-monthly-enrollment";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthDate(year, month) {
  const i = MONTHS.indexOf(String(month || "").trim().toLowerCase());
  return i < 0 || !/^\d{4}$/.test(String(year)) ? null : `${year}-${pad(i + 1)}-01`;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const rows = [];
    let sha = null;
    for (let offset = 0; offset < 20000; offset += 1000) {
      const r = await ctx.get(`cms:enrollment:${offset}`, `${URL_DATA}?filter%5BBENE_GEO_LVL%5D=National&size=1000&offset=${offset}`, { headers: { Accept: "application/json" } });
      sha = r.sha256;
      const page = parseJson(r.text, "cms enrollment");
      if (!Array.isArray(page)) throw new SchemaError("cms enrollment: answer is not an array");
      rows.push(...page);
      if (page.length < 1000) break;
    }
    for (const s of series) {
      const since = ctx.since(s);
      for (const x of rows) {
        const date = monthDate(x.YEAR, x.MONTH);
        const v = num(x[s.params.field]);
        if (!date || v === null || date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: date.slice(0, 7), value: v, source_url: CITE, raw_sha256: sha });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, monthDate };
