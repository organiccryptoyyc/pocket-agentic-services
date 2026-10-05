// IRS SOI annual extracts of exempt organization financial data (Form 990), no key. One zip per
// IRS processing year (about 55 MB, one CSV of every Form 990 return processed that year). Each
// year is streamed once and summed (total revenue, contributions, expenses, assets, number of
// returns); the zip is not kept, and a year already read is not downloaded again. 2018 is the
// first year in the current CSV layout (seven years, about 360 MB, on the first run); the newest
// year appears around mid-year after it ends.
"use strict";

const { SchemaError } = require("./common");
const { unzip } = require("../xlsx");

const BASE = "https://www.irs.gov/pub/irs-soi";
const CITE = "https://www.irs.gov/statistics/soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data";
const COLUMNS = ["totrevenue", "totcntrbgfts", "totfuncexpns", "totassetsend"];
const FIRST_YEAR = 2018;

async function yearTotals(text) {
  const z = unzip(Buffer.from(text, "base64"));
  const name = z.names.find((n) => /\.csv$/i.test(n));
  if (!name) throw new SchemaError("irs990: no CSV in the zip");
  let idx = null;
  const totals = { count: 0, ...Object.fromEntries(COLUMNS.map((c) => [c, 0])) };
  await z.eachLine(name, (line) => {
    if (!line) return;
    const cells = line.split(",");
    if (!idx) {
      const head = cells.map((h) => h.trim().toLowerCase().replace(/"/g, ""));
      idx = Object.fromEntries(COLUMNS.map((c) => [c, head.indexOf(c)]));
      if (Object.values(idx).some((i) => i < 0)) throw new SchemaError(`irs990: missing columns ${COLUMNS.filter((c) => idx[c] < 0).join(", ")}`);
      return;
    }
    totals.count++;
    for (const c of COLUMNS) {
      const v = Number(cells[idx[c]]);
      if (Number.isFinite(v)) totals[c] += v;
    }
  });
  return totals;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const thisYear = ctx.now.getUTCFullYear();
    const done = ctx.kvGet("years") || {};
    for (let y = Math.max(FIRST_YEAR, thisYear - 10); y <= thisYear; y++) {
      if (done[y]) continue;
      const url = `${BASE}/${String(y).slice(2)}eoextract990.zip`;
      const r = await ctx.get(`irs990:${y}`, url, { binary: true, bulk: true }, { allowStatus: [404] });
      if (r.status === 404) continue; // not published yet
      const t = await yearTotals(r.text);
      if (t.count < 1000) throw new SchemaError(`irs990 ${y}: only ${t.count} returns`);
      done[y] = { count: t.count, totrevenue: t.totrevenue, totcntrbgfts: t.totcntrbgfts, totfuncexpns: t.totfuncexpns, totassetsend: t.totassetsend, sha256: r.sha256 };
      ctx.kvSet("years", done);
    }
    for (const s of series) {
      const col = s.params.column;
      if (col !== "count" && !COLUMNS.includes(col)) throw new SchemaError(`irs990: unknown column '${col}'`);
      for (const [y, t] of Object.entries(done)) {
        const date = `${y}-01-01`;
        if (date < ctx.since(s)) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: String(y), value: Math.round(t[col]), source_url: CITE, raw_sha256: t.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, yearTotals };
