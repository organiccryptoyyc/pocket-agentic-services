// OECD Data Explorer SDMX API (sdmx.oecd.org), no key, CC BY 4.0: composite leading indicators,
// amplitude adjusted (long-term trend = 100), monthly. One request for every configured country
// (params.country is ISO3). The OECD limits anonymous calls per hour, so this runs weekly.
"use strict";

const { SchemaError, csvObjects, num } = require("./common");

const CITE = "https://data-explorer.oecd.org/vis?df[ds]=dsDisseminateFinalDMZ&df[id]=DSD_STES%40DF_CLI&df[ag]=OECD.SDD.STES";

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const countries = [...new Set(series.map((s) => s.params.country))].join("+");
    const url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/${countries}.M.LI...AA...H?startPeriod=${since.slice(0, 7)}&dimensionAtObservation=AllDimensions&format=csvfile`;
    const r = await ctx.get("oecd:cli", url, { headers: { Accept: "application/vnd.sdmx.data+csv" } });
    const rows = csvObjects(r.text);
    if (!rows.length || !("OBS_VALUE" in rows[0])) throw new SchemaError("oecd cli: no OBS_VALUE column");
    for (const s of series) {
      const since2 = ctx.since(s);
      for (const x of rows) {
        if (x.REF_AREA !== s.params.country || x.MEASURE !== "LI" || x.ADJUSTMENT !== "AA") continue;
        const v = num(x.OBS_VALUE);
        if (v === null || !/^\d{4}-\d{2}$/.test(x.TIME_PERIOD)) continue;
        const date = `${x.TIME_PERIOD}-01`;
        if (date < since2) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: x.TIME_PERIOD, value: v, source_url: CITE, raw_sha256: r.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect };
