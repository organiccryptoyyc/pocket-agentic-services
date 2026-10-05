// SEC fails-to-deliver data (public domain): each half month SEC posts a zip of pipe-delimited
// rows SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE. Summed per company and
// calendar month as dollar value (quantity x price). A month is stored only when both halves
// ("a" and "b") are published. Needs the SEC User-Agent in PMIC_SEC_USER_AGENT, like EDGAR.
"use strict";

const { SchemaError, num, completeMonths } = require("./common");
const { unzip } = require("../xlsx");

const BASE = "https://www.sec.gov/files/data/fails-deliver-data";
const CITE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data";

function failsValue(text, symbols) {
  const totals = new Map(symbols.map((s) => [s, 0]));
  for (const line of text.split(/\r?\n/)) {
    const c = line.split("|");
    if (c.length < 6 || !totals.has(c[2])) continue;
    const q = num(c[3]);
    const p = num(c[5]);
    if (q === null || p === null) continue;
    totals.set(c[2], totals.get(c[2]) + q * p);
  }
  return totals;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const ua = ctx.env.PMIC_SEC_USER_AGENT;
  if (!ua) {
    ctx.missingKey("secftd", "PMIC_SEC_USER_AGENT", series.map((s) => s.series_id));
    return out;
  }
  try {
    const symbols = series.map((s) => s.params.ticker);
    const since = series.map((s) => ctx.since(s)).sort()[0];
    for (const m of completeMonths(since, ctx.now)) {
      const ym = m.slice(0, 7).replace("-", "");
      const halves = [];
      for (const h of ["a", "b"]) {
        const r = await ctx.get(`secftd:${ym}${h}`, `${BASE}/cnsfails${ym}${h}.zip`, { headers: { "User-Agent": ua }, binary: true }, { allowStatus: [404] });
        if (r.status === 404) break;
        const z = unzip(Buffer.from(r.text, "base64"));
        if (!z.names.length) throw new SchemaError(`secftd ${ym}${h}: empty zip`);
        halves.push({ text: z.read(z.names[0]), sha: r.sha256 });
      }
      if (halves.length < 2) continue; // the month is not complete on SEC's side yet
      const totals = new Map(symbols.map((s) => [s, 0]));
      for (const half of halves) for (const [sym, v] of failsValue(half.text, symbols)) totals.set(sym, totals.get(sym) + v);
      for (const s of series) {
        if (m < ctx.since(s)) continue;
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: Math.round(totals.get(s.params.ticker)), source_url: CITE, raw_sha256: halves[1].sha });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, failsValue };
