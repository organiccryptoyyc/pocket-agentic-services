// NOAA NCEI Climate at a Glance, national time series (contiguous US), no key. Monthly departure
// from the 1991-2020 normal for average temperature (degrees F) and precipitation (inches), so a
// series reads as "how unusual", not the seasonal cycle. params.element: tavg or pcp.
"use strict";

const { SchemaError, parseJson } = require("./common");

const CITE = "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/national/time-series";

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    try {
      const since = ctx.since(s);
      const url = `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/national/time-series/110/${s.params.element}/1/0/${since.slice(0, 4)}-${ctx.now.getUTCFullYear()}/data.json?base_prd=true&begbaseyear=1991&endbaseyear=2020`;
      const r = await ctx.get(`noaa:${s.params.element}`, url);
      const body = parseJson(r.text, `noaa ${s.params.element}`);
      if (!body.data || typeof body.data !== "object") throw new SchemaError("noaa: no data object");
      for (const [ym, v] of Object.entries(body.data)) {
        if (!/^\d{6}$/.test(ym) || !v || typeof v.departure !== "number") continue;
        const date = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
        if (date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: date.slice(0, 7), value: v.departure, source_url: CITE, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect };
