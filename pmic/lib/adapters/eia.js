// EIA petroleum weekly history pages (dnav LeafHandler), no key. FRED stopped serving some EIA
// weekly series, and EIA's own API needs a key, so this reads the public history table: each row
// is a month ("2026-Sep") followed by week-ending dates ("09/04") and values ("424,069").
"use strict";

const { SchemaError, num } = require("./common");

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function weeklyTable(html) {
  const rows = [];
  const clean = (s) => s.replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "").trim();
  for (const tr of html.split(/<tr>/i)) {
    const m = /class='B6'>([^<]*)</.exec(tr);
    if (!m) continue;
    const ym = /(\d{4})-([A-Z][a-z]{2})/.exec(clean(m[1]));
    if (!ym || !MONTHS[ym[2]]) continue;
    const cells = [...tr.matchAll(/<td class='B[35]'>([\s\S]*?)<\/td>/g)].map((c) => clean(c[1]));
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const d = /^(\d{2})\/(\d{2})$/.exec(cells[i]);
      const v = num(cells[i + 1]);
      if (!d || v === null) continue;
      // A week ending in early January can sit in a December row; trust the month in the cell.
      const year = Number(ym[1]) + (ym[2] === "Dec" && d[1] === "01" ? 1 : 0);
      rows.push({ date: `${year}-${d[1]}-${d[2]}`, value: v });
    }
  }
  return rows;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    try {
      const id = s.params.id;
      const url = `https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=${encodeURIComponent(id)}&f=W`;
      const r = await ctx.get(`eia:${id}`, url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PMIC-collector/1.0)" } });
      const rows = weeklyTable(r.text);
      if (!rows.length) throw new SchemaError(`eia ${id}: no weekly rows in the history table`);
      const since = ctx.since(s);
      for (const x of rows) {
        if (x.date < since) continue;
        out.observations.push({ series_id: s.series_id, observation_time: x.date, period: `week ending ${x.date}`, value: x.value, source_url: url, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, weeklyTable };
