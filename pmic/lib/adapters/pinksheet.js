// World Bank Commodity Price Data ("Pink Sheet"), monthly averages, CC BY 4.0. The workbook's link
// changes with every monthly release, so it is read from the Pink Sheet page first, with the
// configured fallback when the page has no link. Sheet "Monthly Prices": a header row naming each
// commodity (Gold, Silver, Platinum ...), then one row per month with the date as 2026M08 in A.
"use strict";

const { SchemaError } = require("./common");
const { readSheet } = require("../xlsx");

const PAGE = "https://www.worldbank.org/en/research/commodity-markets";
const FALLBACK = "https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx";
const LINK = /https?:\/\/[^"'\s<>]+CMO-Historical-Data-Monthly\.xlsx/i;

function monthOf(cell) {
  const m = /^(\d{4})M(\d{2})$/.exec(String(cell || "").trim());
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// {column name -> [[date, value], ...]} for the requested columns.
function pricesFrom(rows, columns) {
  const wanted = columns.map((c) => c.toLowerCase());
  let headerCols = null;
  const out = Object.fromEntries(columns.map((c) => [c, []]));
  for (const [, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (!headerCols) {
      const names = cells.map((c) => (typeof c === "string" ? c.trim().toLowerCase() : null));
      if (wanted.every((w) => names.includes(w))) headerCols = Object.fromEntries(columns.map((c) => [c, names.indexOf(c.toLowerCase())]));
      continue;
    }
    const date = monthOf(cells[0]);
    if (!date) continue;
    for (const c of columns) {
      const v = cells[headerCols[c]];
      if (typeof v === "number" && Number.isFinite(v)) out[c].push([date, v]);
    }
  }
  if (!headerCols) throw new SchemaError(`pinksheet: no header row naming ${columns.join(", ")}`);
  return out;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    let url = FALLBACK;
    try {
      const page = await ctx.get("pinksheet:page", PAGE, { headers: { Accept: "text/html" } });
      const m = LINK.exec(page.text);
      if (m) url = m[0];
      else ctx.note("pinksheet", "Pink Sheet page has no workbook link; using the configured fallback URL");
    } catch (e) {
      ctx.note("pinksheet", `Pink Sheet page unavailable (${e.message}); using the configured fallback URL`);
    }
    const r = await ctx.get("pinksheet:monthly", url, { binary: true });
    const rows = readSheet(Buffer.from(r.text, "base64"), "Monthly Prices");
    const prices = pricesFrom(rows, series.map((s) => s.params.column));
    for (const s of series) {
      const since = ctx.since(s);
      for (const [date, v] of prices[s.params.column]) {
        if (date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: date.slice(0, 7), value: v, source_url: PAGE, raw_sha256: r.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, pricesFrom, monthOf };
