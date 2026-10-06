// CFTC Commitments of Traders, Traders in Financial Futures (futures only), public domain, no key
// (publicreporting.cftc.gov Socrata dataset gpe5-46if). Weekly positions as of each Tuesday report
// date for one contract (params.code, e.g. 133741 = CME Bitcoin, 146021 = CME Ether). params.field:
// open_interest, asset_mgr_net (asset managers long minus short) or lev_money_net (leveraged funds).
"use strict";

const { SchemaError, parseJson, num } = require("./common");

const URL_DATA = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
const CITE = "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm";
const FIELDS = {
  open_interest: (x) => num(x.open_interest_all),
  asset_mgr_net: (x) => (num(x.asset_mgr_positions_long) === null || num(x.asset_mgr_positions_short) === null ? null : num(x.asset_mgr_positions_long) - num(x.asset_mgr_positions_short)),
  lev_money_net: (x) => (num(x.lev_money_positions_long) === null || num(x.lev_money_positions_short) === null ? null : num(x.lev_money_positions_long) - num(x.lev_money_positions_short)),
};

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const byCode = new Map();
  for (const s of series) {
    if (!byCode.has(s.params.code)) byCode.set(s.params.code, []);
    byCode.get(s.params.code).push(s);
  }
  for (const [code, group] of byCode) {
    try {
      const since = group.map((s) => ctx.since(s)).sort()[0];
      const where = encodeURIComponent(`cftc_contract_market_code='${code}' AND report_date_as_yyyy_mm_dd >= '${since}T00:00:00'`);
      const r = await ctx.get(`cftc:${code}`, `${URL_DATA}?$where=${where}&$order=report_date_as_yyyy_mm_dd&$limit=5000`, { headers: { Accept: "application/json" } });
      const rows = parseJson(r.text, `cftc ${code}`);
      if (!Array.isArray(rows)) throw new SchemaError(`cftc ${code}: answer is not an array`);
      for (const s of group) {
        const f = FIELDS[s.params.field];
        if (!f) throw new SchemaError(`cftc: unknown field '${s.params.field}'`);
        for (const x of rows) {
          const date = String(x.report_date_as_yyyy_mm_dd || "").slice(0, 10);
          const v = f(x);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || v === null || date < ctx.since(s)) continue;
          out.observations.push({ series_id: s.series_id, observation_time: date, period: `week of ${date}`, value: v, source_url: CITE, raw_sha256: r.sha256 });
        }
      }
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, FIELDS };
