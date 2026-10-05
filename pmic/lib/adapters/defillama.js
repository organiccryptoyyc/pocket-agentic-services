// DefiLlama public API, no key: total stablecoin supply (all pegged-USD stablecoins) and total
// DeFi value locked across chains, daily. Each series reads one endpoint (params.feed).
"use strict";

const { SchemaError, parseJson, ymd } = require("./common");

const FEEDS = {
  stablecoins: { url: "https://stablecoins.llama.fi/stablecoincharts/all", cite: "https://defillama.com/stablecoins", value: (x) => x.totalCirculatingUSD && x.totalCirculatingUSD.peggedUSD },
  tvl: { url: "https://api.llama.fi/v2/historicalChainTvl", cite: "https://defillama.com/", value: (x) => x.tvl },
};

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    try {
      const f = FEEDS[s.params.feed];
      if (!f) throw new SchemaError(`defillama: unknown feed '${s.params.feed}'`);
      const r = await ctx.get(`defillama:${s.params.feed}`, f.url, { headers: { Accept: "application/json" } });
      const rows = parseJson(r.text, `defillama ${s.params.feed}`);
      if (!Array.isArray(rows)) throw new SchemaError(`defillama ${s.params.feed}: answer is not an array`);
      const since = ctx.since(s);
      const today = ymd(ctx.now);
      for (const x of rows) {
        const date = ymd(new Date(Number(x.date) * 1000));
        const v = Number(f.value(x));
        // today's point is still moving; keep complete days only
        if (date < since || date >= today || !Number.isFinite(v) || v <= 0) continue;
        out.observations.push({ series_id: s.series_id, observation_time: date, period: date, value: Math.round(v), source_url: f.cite, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect };
