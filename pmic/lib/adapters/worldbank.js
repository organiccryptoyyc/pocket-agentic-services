// World Bank Indicators API v2: one request per indicator for every configured country
// (semicolon-separated ISO2 codes), paged. Body is [meta, rows]; an error is [{message: [...]}].
"use strict";

const { SchemaError, parseJson } = require("./common");

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const byIndicator = new Map();
  for (const s of series) {
    if (!byIndicator.has(s.params.indicator)) byIndicator.set(s.params.indicator, []);
    byIndicator.get(s.params.indicator).push(s);
  }
  for (const [indicator, group] of byIndicator) {
    const since = group.map((s) => ctx.since(s)).sort()[0];
    const countries = group.map((s) => s.params.country).join(";");
    const bySeries = new Map(group.map((s) => [s.params.country, s]));
    try {
      let page = 1;
      let pages = 1;
      do {
        const url = `https://api.worldbank.org/v2/country/${countries}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=1000&page=${page}&date=${since.slice(0, 4)}:${ctx.now.getUTCFullYear()}`;
        const r = await ctx.get(`worldbank:${indicator}:p${page}`, url);
        const body = parseJson(r.text, `worldbank ${indicator}`);
        if (!Array.isArray(body)) throw new SchemaError(`worldbank ${indicator}: body is not an array`);
        if (body[0] && body[0].message) throw new SchemaError(`worldbank ${indicator}: ${body[0].message.map((m) => m.value || m.key).join("; ")}`);
        const [meta, rows] = body;
        pages = Number(meta && meta.pages) || 1;
        for (const row of rows || []) {
          const s = bySeries.get(row.country && row.country.id);
          if (!s || row.value === null || row.value === undefined || !/^\d{4}$/.test(row.date)) continue;
          const date = `${row.date}-01-01`;
          if (date < ctx.since(s)) continue;
          out.observations.push({
            series_id: s.series_id,
            observation_time: date,
            period: row.date,
            value: Number(row.value),
            source_url: `https://data.worldbank.org/indicator/${indicator}?locations=${s.params.country}`,
            raw_sha256: r.sha256,
          });
        }
        page++;
      } while (page <= pages && page <= 20);
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect };
