// BEA API (needs BEA_API_KEY, a free UserID). One request per NIPA table and one per
// GDPbyIndustry table covering every configured industry. DataValue arrives as text with
// thousands separators; quarters come as "2026Q2" (NIPA) or Year + Quarter (GDPbyIndustry,
// "1".."4" or "I".."IV").
"use strict";

const { SchemaError, num, parseJson, quarterStart } = require("./common");

const ROMAN = { I: 1, II: 2, III: 3, IV: 4 };
const CITE = {
  NIPA: "https://apps.bea.gov/iTable/?reqid=19&step=2&isuri=1&categories=survey",
  GDPbyIndustry: "https://apps.bea.gov/iTable/?reqid=150&step=2&isuri=1&categories=gdpxind",
};

function years(since, now) {
  const out = [];
  for (let y = Number(since.slice(0, 4)); y <= now.getUTCFullYear(); y++) out.push(y);
  return out.join(",");
}

// NIPA answers Results as one object; GDPbyIndustry as an array of result blocks. Either way
// return the flattened Data rows, or throw with BEA's own error text.
function beaRows(body, what) {
  const api = body && body.BEAAPI;
  if (!api) throw new SchemaError(`${what}: response has no BEAAPI object`);
  const blocks = Array.isArray(api.Results) ? api.Results : [api.Results || {}];
  const err = api.Error || blocks.map((b) => b && b.Error).find(Boolean);
  if (err) throw new SchemaError(`${what}: ${`${err.APIErrorCode || ""} ${err.APIErrorDescription || JSON.stringify(err)}`.trim()}`);
  if (!blocks.every((b) => b && Array.isArray(b.Data))) throw new SchemaError(`${what}: response has no Results.Data array`);
  return blocks.flatMap((b) => b.Data);
}

function quarterOf(row) {
  if (row.TimePeriod) {
    const m = /^(\d{4})Q([1-4])$/.exec(row.TimePeriod);
    return m ? { year: Number(m[1]), q: Number(m[2]), label: row.TimePeriod } : null;
  }
  const q = ROMAN[String(row.Quarter)] || Number(row.Quarter);
  return q >= 1 && q <= 4 ? { year: Number(row.Year), q, label: `${row.Year}Q${q}` } : null;
}

async function collect(series, ctx) {
  const key = ctx.env.BEA_API_KEY;
  const out = { observations: [], events: [] };
  if (!key) {
    ctx.missingKey("bea", "BEA_API_KEY", series.map((s) => s.series_id));
    return out;
  }
  const groups = new Map();
  for (const s of series) {
    const p = s.params;
    const g = p.dataset === "NIPA" ? `NIPA:${p.table}:${p.frequency}` : `GDPbyIndustry:${p.table_id}:${p.frequency}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  for (const [g, group] of groups) {
    const p = group[0].params;
    const since = group.map((s) => ctx.since(s)).sort()[0];
    const base = `https://apps.bea.gov/api/data/?UserID=${encodeURIComponent(key)}&method=GetData&ResultFormat=JSON&Year=${years(since, ctx.now)}&Frequency=${p.frequency}`;
    const url = p.dataset === "NIPA"
      ? `${base}&datasetname=NIPA&TableName=${encodeURIComponent(p.table)}`
      : `${base}&datasetname=GDPbyIndustry&TableID=${encodeURIComponent(p.table_id)}&Industry=${group.map((s) => encodeURIComponent(s.params.industry)).join(",")}`;
    try {
      const r = await ctx.get(`bea:${g}`, url);
      const rows = beaRows(parseJson(r.text, `bea ${g}`), `bea ${g}`);
      for (const s of group) {
        const mine = rows.filter((row) => (p.dataset === "NIPA" ? String(row.LineNumber) === String(s.params.line) : String(row.Industry) === String(s.params.industry)));
        if (!mine.length) {
          ctx.fail([s.series_id], new SchemaError(`bea ${s.series_id}: no rows for this line/industry`));
          continue;
        }
        const sinceS = ctx.since(s);
        for (const row of mine) {
          const qq = quarterOf(row);
          const v = num(row.DataValue);
          if (!qq || v === null) continue;
          const date = quarterStart(qq.year, qq.q);
          if (date < sinceS) continue;
          out.observations.push({ series_id: s.series_id, observation_time: date, period: qq.label, value: v, source_url: CITE[p.dataset], raw_sha256: r.sha256 });
        }
      }
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, quarterOf, beaRows };
