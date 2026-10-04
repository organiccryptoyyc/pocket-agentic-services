// European Central Bank Data Portal, SDMX REST API. One request per series key in CSV
// (format=csvdata): a header row naming every dimension, then TIME_PERIOD and OBS_VALUE per row.
// Daily periods are YYYY-MM-DD, monthly YYYY-MM (stored as the first of the month).
//
// params.step: the key lists only the dates a rate changed (ECB policy rates), so the rate in force
// is carried forward to every weekday. HICP moved from the ICP dataflow (frozen at 2025-12) to
// the HICP dataflow in 2026, with data provider 4D0.
"use strict";

const { SchemaError, num, csvObjects, ymd } = require("./common");

const DAY = 86400000;

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

async function fetchRows(ctx, flow, key, start) {
  const url = `${BASE}/${flow}/${key}?format=csvdata&startPeriod=${start}`;
  // 404 means no observations after startPeriod: a valid empty answer.
  const r = await ctx.get(`ecb:${flow}.${key}`, url, { headers: { Accept: "text/csv" } }, { allowStatus: [404] });
  return { rows: r.status === 404 ? [] : parse(r.text, `ecb ${flow}.${key}`), sha: r.sha256 };
}

// Rate in force on each weekday from `since` to yesterday, from a list of change dates.
function stepDaily(points, since, now) {
  const sorted = points.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out = [];
  let i = 0;
  let cur = null;
  for (let t = Date.parse(`${sorted.length ? sorted[0][0] : since}T00:00:00Z`); t < now.getTime() - DAY; t += DAY) {
    const d = ymd(new Date(t));
    while (i < sorted.length && sorted[i][0] <= d) cur = sorted[i++][1];
    const wd = new Date(t).getUTCDay();
    if (d >= since && cur !== null && wd !== 0 && wd !== 6) out.push([d, cur]);
  }
  return out;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    const { flow, key } = s.params;
    const since = ctx.since(s);
    try {
      // Change-date series: read ten years back so the rate in force at `since` is known.
      const start = s.params.step ? ymd(new Date(Date.parse(`${since}T00:00:00Z`) - 3650 * DAY)) : since;
      const { rows, sha } = await fetchRows(ctx, flow, key, start);
      const cite = `https://data.ecb.europa.eu/data/datasets/${flow}/${flow}.${key}`;
      const points = rows.map((x) => [periodDate(x.TIME_PERIOD), num(x.OBS_VALUE), x.TIME_PERIOD]).filter(([d, v]) => d && v !== null);
      if (s.params.step) {
        for (const [d, v] of stepDaily(points, since, ctx.now)) out.observations.push({ series_id: s.series_id, observation_time: d, period: d, value: v, source_url: cite, raw_sha256: sha });
        continue;
      }
      for (const [date, v, period] of points) {
        if (date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period, value: v, source_url: cite, raw_sha256: sha });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, periodDate, parse, stepDaily };
