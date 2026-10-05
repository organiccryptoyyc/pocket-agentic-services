// TSA checkpoint travel numbers (tsa.gov/travel/passenger-volumes), no key: daily passengers
// screened. The main page holds the current year; earlier years are at /passenger-volumes/YYYY.
// Summed into complete weeks.
"use strict";

const { SchemaError, anyDate, num, weeklyCounts } = require("./common");

const BASE = "https://www.tsa.gov/travel/passenger-volumes";
const UA = "Mozilla/5.0 (compatible; PMIC-collector/1.0)";

function dailyRows(html) {
  const cells = [...html.matchAll(/<td[^>]*>\s*([^<]*?)\s*<\/td>/g)].map((m) => m[1]);
  const rows = [];
  for (let i = 0; i + 1 < cells.length; i++) {
    const d = anyDate(cells[i]);
    const v = num(cells[i + 1]);
    if (d && v !== null && /\d{1,2}\/\d{1,2}\/\d{4}/.test(cells[i])) { rows.push([d, v]); i++; }
  }
  return rows;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const daily = new Map();
    let sha = null;
    const thisYear = ctx.now.getUTCFullYear();
    for (let y = Number(since.slice(0, 4)); y <= thisYear; y++) {
      const url = y === thisYear ? BASE : `${BASE}/${y}`;
      const r = await ctx.get(`tsa:${y}`, url, { headers: { "User-Agent": UA } });
      sha = r.sha256;
      const rows = dailyRows(r.text);
      if (!rows.length) throw new SchemaError(`tsa ${y}: no daily rows`);
      for (const [d, v] of rows) daily.set(d, v);
    }
    // TSA posts each day a day or two late, so a calendar-complete week can still be short:
    // only weeks with all seven days published are stored.
    const days = weeklyCounts([...daily.keys()].map((d) => [d, 1]), "2000-01-01", ctx.now);
    const full = new Set(days.filter(([, n]) => n === 7).map(([w]) => w));
    for (const s of series) {
      for (const [w, n] of weeklyCounts([...daily.entries()], ctx.since(s), ctx.now)) {
        if (!n || !full.has(w)) continue; // a week missing published days is left out, not counted short
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: BASE, raw_sha256: sha });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, dailyRows };
