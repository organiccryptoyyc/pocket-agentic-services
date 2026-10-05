// Census Business Formation Statistics, the public monthly CSV (no key). Rows are
// sa (A = seasonally adjusted), naics_sector, series, geo, year, then jan..dec. Each PMIC series
// picks one series code (params.code, e.g. BA_BA) for the US total, seasonally adjusted.
"use strict";

const { SchemaError, num, csvObjects, pad } = require("./common");

const URL_BFS = "https://www.census.gov/econ/bfs/csv/bfs_monthly.csv";
const CITE = "https://www.census.gov/econ/bfs/index.html";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function bfsSeries(rows, code) {
  const out = [];
  for (const r of rows) {
    if (r.sa !== "A" || r.naics_sector !== "TOTAL" || r.geo !== "US" || r.series !== code) continue;
    const y = Number(r.year);
    if (!Number.isInteger(y)) continue;
    MONTHS.forEach((m, i) => {
      const v = num(r[m]);
      if (v !== null) out.push({ date: `${y}-${pad(i + 1)}-01`, value: v });
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const r = await ctx.get("census:bfs", URL_BFS, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PMIC-collector/1.0)" } });
    const rows = csvObjects(r.text);
    if (!rows.length || !("series" in rows[0])) throw new SchemaError("census bfs: unexpected CSV header");
    for (const s of series) {
      const points = bfsSeries(rows, s.params.code);
      if (!points.length) {
        ctx.fail([s.series_id], new SchemaError(`census bfs: no rows for ${s.params.code}`));
        continue;
      }
      const since = ctx.since(s);
      for (const p of points) {
        if (p.date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: p.date, period: p.date.slice(0, 7), value: p.value, source_url: CITE, raw_sha256: r.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, bfsSeries };
