// BLS Public Data API. Series are batched (25 per request on v1, 50 on v2 with BLS_API_KEY).
// Periods: M01-M12 monthly, M13 annual average (skipped), Q01-Q04 quarterly, A01 annual.
// Footnote code P marks preliminary values; that becomes a qc flag on the observation.
"use strict";

const { SchemaError, num, parseJson, pad, quarterStart } = require("./common");

function periodToDate(year, period) {
  let m;
  if ((m = /^M(\d{2})$/.exec(period)) && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${year}-${m[1]}-01`;
  if ((m = /^Q0([1-4])$/.exec(period))) return quarterStart(year, Number(m[1]));
  if (period === "A01") return `${year}-01-01`;
  return null;
}

async function collect(series, ctx) {
  const key = ctx.env.BLS_API_KEY;
  const batch = key ? 50 : 25;
  const maxYears = key ? 20 : 10;
  const out = { observations: [], events: [] };
  for (let i = 0; i < series.length; i += batch) {
    const group = series.slice(i, i + batch);
    const since = group.map((s) => ctx.since(s)).sort()[0];
    const endyear = ctx.now.getUTCFullYear();
    const startyear = Math.max(Number(since.slice(0, 4)), endyear - maxYears + 1);
    const payload = { seriesid: group.map((s) => s.params.id), startyear: String(startyear), endyear: String(endyear) };
    if (key) payload.registrationkey = key;
    const url = `https://api.bls.gov/publicAPI/${key ? "v2" : "v1"}/timeseries/data/`;
    try {
      const r = await ctx.get(`bls:batch${i / batch}`, url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = parseJson(r.text, "bls");
      if (body.status !== "REQUEST_SUCCEEDED") {
        throw new SchemaError(`bls: ${body.status || "no status"}: ${(body.message || []).join("; ").slice(0, 300)}`);
      }
      const results = (body.Results && body.Results.series) || [];
      const byId = new Map(results.map((x) => [x.seriesID, x]));
      for (const s of group) {
        const res = byId.get(s.params.id);
        if (!res || !Array.isArray(res.data)) {
          ctx.fail([s.series_id], new SchemaError(`bls ${s.params.id}: series missing from response`));
          continue;
        }
        const sinceS = ctx.since(s);
        for (const d of res.data) {
          const date = periodToDate(d.year, d.period);
          const v = num(d.value);
          if (!date || v === null || date < sinceS) continue;
          const prelim = (d.footnotes || []).some((f) => f && f.code === "P");
          out.observations.push({
            series_id: s.series_id,
            observation_time: date,
            period: `${d.year}-${d.period}`,
            value: v,
            source_url: `https://data.bls.gov/timeseries/${s.params.id}`,
            raw_sha256: r.sha256,
            qc_flags: prelim ? ["preliminary"] : [],
          });
        }
      }
      if (Array.isArray(body.message) && body.message.length) ctx.note("bls", body.message.join("; "));
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, periodToDate, pad };
