// FRED. With FRED_API_KEY: the JSON API (series/observations). Without: the public
// fredgraph.csv download of the same series. Missing values arrive as "." in both.
"use strict";

const { SchemaError, num, parseJson } = require("./common");

function citation(id) {
  return `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`;
}

function parseCsv(text, id) {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines.shift() || "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  if (header.length < 2 || !/^(observation_date|DATE)$/i.test(header[0])) {
    throw new SchemaError(`fred csv ${id}: unexpected header '${header.join(",")}'`);
  }
  return lines.map((l) => l.split(",")).map(([date, value]) => ({ date, value }));
}

async function collect(series, ctx) {
  const key = ctx.env.FRED_API_KEY;
  const out = { observations: [], events: [] };
  for (const s of series) {
    const id = s.params.id;
    const since = ctx.since(s);
    try {
      let rows;
      let sha;
      if (key) {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${since}`;
        const r = await ctx.get(`fred:${id}`, url);
        const body = parseJson(r.text, `fred ${id}`);
        if (!Array.isArray(body.observations)) throw new SchemaError(`fred ${id}: no observations array`);
        rows = body.observations;
        sha = r.sha256;
      } else {
        const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${since}`;
        const r = await ctx.get(`fred:${id}`, url);
        rows = parseCsv(r.text, id);
        sha = r.sha256;
      }
      for (const row of rows) {
        const v = num(row.value);
        if (v === null || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "") || row.date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: row.date, period: row.date, value: v, source_url: citation(id), raw_sha256: sha });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, parseCsv };
