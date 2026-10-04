// CDC National Syndromic Surveillance Program (data.cdc.gov dataset vutn-jzwm): the weekly percent
// of US emergency department visits diagnosed as COVID-19, influenza or RSV. One Socrata request
// for the national rows in the window; each pathogen is a series (params.pathogen).
"use strict";

const { SchemaError, num, parseJson, anyDate } = require("./common");

const BASE = "https://data.cdc.gov/resource/vutn-jzwm.json";
const CITE = "https://www.cdc.gov/respiratory-viruses/data/activity-levels.html";

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const where = encodeURIComponent(`geography='United States' AND week_end >= '${since}T00:00:00.000'`);
    const headers = { Accept: "application/json", ...(ctx.env.CDC_APP_TOKEN ? { "X-App-Token": ctx.env.CDC_APP_TOKEN } : {}) };
    const r = await ctx.get("cdc:nssp", `${BASE}?$where=${where}&$order=week_end&$limit=50000`, { headers });
    const rows = parseJson(r.text, "cdc nssp");
    if (!Array.isArray(rows)) throw new SchemaError("cdc nssp: answer is not a JSON array");
    for (const s of series) {
      const since2 = ctx.since(s);
      for (const x of rows) {
        if (x.pathogen !== s.params.pathogen) continue;
        const date = anyDate(x.week_end);
        const v = num(x.percent_visits);
        if (!date || v === null || date < since2) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: `week ending ${date}`, value: v, source_url: CITE, raw_sha256: r.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect };
