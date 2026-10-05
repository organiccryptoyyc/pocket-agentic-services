// FBI Crime Data Explorer API (api.usa.gov, an api.data.gov key in FBI_API_KEY; DEMO_KEY works
// at a low rate): national monthly offense rates per 100,000 people (params.offense: violent-crime
// or property-crime). Agencies report late, so the two newest months read low and are left out
// until they fill in.
"use strict";

const { SchemaError, parseJson, completeMonths } = require("./common");

const CITE = "https://cde.ucr.cjis.gov/";
const LAG_MONTHS = 2;

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const key = ctx.env.FBI_API_KEY || ctx.env.FEC_API_KEY || "DEMO_KEY";
  for (const s of series) {
    try {
      const months = completeMonths(ctx.since(s), ctx.now);
      const keep = new Set(months.slice(0, Math.max(0, months.length - LAG_MONTHS)));
      if (!keep.size) continue;
      const first = months[0];
      const last = months[months.length - 1];
      const mmYYYY = (d) => `${d.slice(5, 7)}-${d.slice(0, 4)}`;
      const url = `https://api.usa.gov/crime/fbi/cde/summarized/national/${s.params.offense}?from=${mmYYYY(first)}&to=${mmYYYY(last)}&API_KEY=${encodeURIComponent(key)}`;
      const r = await ctx.get(`fbi:${s.params.offense}`, url);
      const body = parseJson(r.text, `fbi ${s.params.offense}`);
      const rates = body.offenses && body.offenses.rates && body.offenses.rates["United States Offenses"];
      if (!rates) throw new SchemaError(`fbi ${s.params.offense}: no national rates`);
      for (const [mmy, v] of Object.entries(rates)) {
        const m = /^(\d{2})-(\d{4})$/.exec(mmy);
        if (!m || typeof v !== "number") continue;
        const date = `${m[2]}-${m[1]}-01`;
        if (!keep.has(date)) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: date.slice(0, 7), value: v, source_url: CITE, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, LAG_MONTHS };
