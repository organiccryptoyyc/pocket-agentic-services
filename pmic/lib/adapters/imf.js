// IMF World Economic Outlook, SDMX 2.1 data API (api.imf.org), no key. One request per indicator
// for all configured countries (params.country is ISO3). Annual values including IMF projections;
// only years up to next year are kept, so the latest point of each series is the IMF's forecast
// for next year.
"use strict";

const { SchemaError } = require("./common");

const CITE = "https://www.imf.org/en/Publications/WEO";

function seriesOf(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Series ([^>]*)>([\s\S]*?)<\/Series>/g)) {
    const attr = (name) => (new RegExp(`${name}="([^"]*)"`).exec(m[1]) || [])[1];
    const obs = [...m[2].matchAll(/<Obs ([^/]*)\/>/g)].map((o) => ({ year: (/TIME_PERIOD="(\d{4})"/.exec(o[1]) || [])[1], value: Number((/OBS_VALUE="([^"]*)"/.exec(o[1]) || [])[1]) }));
    out.push({ country: attr("COUNTRY"), indicator: attr("INDICATOR"), obs: obs.filter((o) => o.year && Number.isFinite(o.value)) });
  }
  return out;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const byIndicator = new Map();
  for (const s of series) {
    if (!byIndicator.has(s.params.indicator)) byIndicator.set(s.params.indicator, []);
    byIndicator.get(s.params.indicator).push(s);
  }
  const lastYear = ctx.now.getUTCFullYear() + 1;
  for (const [indicator, group] of byIndicator) {
    try {
      const since = group.map((s) => ctx.since(s)).sort()[0];
      const countries = group.map((s) => s.params.country).join("+");
      const url = `https://api.imf.org/external/sdmx/2.1/data/WEO/${countries}.${indicator}.A?startPeriod=${since.slice(0, 4)}`;
      const r = await ctx.get(`imf:${indicator}`, url, { headers: { Accept: "application/xml" } });
      if (!/<Series /.test(r.text)) throw new SchemaError(`imf ${indicator}: no Series in the answer`);
      const bySeries = new Map(group.map((s) => [s.params.country, s]));
      for (const x of seriesOf(r.text)) {
        const s = bySeries.get(x.country);
        if (!s) continue;
        for (const o of x.obs) {
          if (Number(o.year) > lastYear) continue;
          const date = `${o.year}-01-01`;
          if (date < ctx.since(s)) continue;
          out.observations.push({ series_id: s.series_id, observation_time: date, period: o.year, value: o.value, source_url: CITE, raw_sha256: r.sha256 });
        }
      }
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, seriesOf };
