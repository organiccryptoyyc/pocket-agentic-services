// European Central Bank Data Portal, SDMX REST API. One request per series key in CSV
// (format=csvdata): a header row naming every dimension, then TIME_PERIOD and OBS_VALUE per row.
// Daily periods are YYYY-MM-DD, monthly YYYY-MM (stored as the first of the month).
"use strict";

const { SchemaError, num, csvObjects } = require("./common");

const BASE = "https://data-api.ecb.europa.eu/service/data";

function periodDate(p) {
  const s = String(p || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  const q = /^(\d{4})-Q([1-4])$/.exec(s);
  if (q) return `${q[1]}-${String((q[2] - 1) * 3 + 1).padStart(2, "0")}-01`;
  return null;
}

function parse(text, what) {
  if (/^\s*</.test(text)) throw new SchemaError(`${what}: answered XML/HTML, not CSV`);
  const rows = csvObjects(text);
  if (rows.length && !("TIME_PERIOD" in rows[0] && "OBS_VALUE" in rows[0])) throw new SchemaError(`${what}: CSV has no TIME_PERIOD/OBS_VALUE columns`);
  return rows;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    const { flow, key } = s.params;
    const since = ctx.since(s);
    const url = `${BASE}/${flow}/${key}?format=csvdata&startPeriod=${since}`;
    try {
      // 404 means no observations after startPeriod: a valid empty answer.
      const r = await ctx.get(`ecb:${flow}.${key}`, url, { headers: { Accept: "text/csv" } }, { allowStatus: [404] });
      if (r.status === 404) continue;
      for (const row of parse(r.text, `ecb ${flow}.${key}`)) {
        const date = periodDate(row.TIME_PERIOD);
        const v = num(row.OBS_VALUE);
        if (!date || v === null || date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: row.TIME_PERIOD, value: v, source_url: `https://data.ecb.europa.eu/data/datasets/${flow}/${flow}.${key}`, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, periodDate, parse };
