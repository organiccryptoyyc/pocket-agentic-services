// Senate Lobbying Disclosure Act API: filings posted per calendar month, read from the `count`
// of a one-row page (filing_type RR = new registrations; no type = every filing). Works without a
// key at a low rate limit (requests are spaced in lib/net.js); LDA_API_KEY raises it. Months
// already read are kept and only the latest three re-read. If lda.senate.gov stops answering,
// the same API path is tried on lda.gov.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");

const BASES = ["https://lda.senate.gov/api/v1", "https://lda.gov/api/v1"];
const REFRESH_MONTHS = 3;

function lastDay(m) {
  return new Date(Date.parse(`${addMonths(m, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function countOf(body) {
  const n = body ? Number(body.count) : NaN;
  if (!Number.isFinite(n)) throw new SchemaError("lda: answer has no count");
  return n;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const headers = { Accept: "application/json", ...(ctx.env.LDA_API_KEY ? { Authorization: `Token ${ctx.env.LDA_API_KEY}` } : {}) };
  let base = BASES[0];
  const get = async (jobKey, query) => {
    try {
      return await ctx.get(jobKey, `${base}/filings/?${query}`, { headers });
    } catch (e) {
      if (base === BASES[1]) throw e;
      base = BASES[1];
      return ctx.get(jobKey, `${base}/filings/?${query}`, { headers });
    }
  };
  for (const s of series) {
    try {
      const months = completeMonths(ctx.since(s), ctx.now);
      const cache = ctx.kvGet(s.series_id) || {};
      const refresh = new Set(months.slice(-REFRESH_MONTHS));
      let sha = null;
      for (const m of months) {
        if (cache[m] !== undefined && !refresh.has(m)) continue;
        const type = s.params.filing_type ? `&filing_type=${encodeURIComponent(s.params.filing_type)}` : "";
        const r = await get(`lda:${s.series_id}:${m}`, `filing_dt_posted_after=${m}&filing_dt_posted_before=${lastDay(m)}T23:59:59${type}&page_size=1`);
        cache[m] = countOf(parseJson(r.text, `lda ${m}`));
        sha = r.sha256;
        ctx.kvSet(s.series_id, cache);
      }
      for (const k of Object.keys(cache)) if (!months.includes(k)) delete cache[k];
      ctx.kvSet(s.series_id, cache);
      for (const m of months) {
        if (cache[m] === undefined) continue;
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: cache[m], source_url: "https://lda.senate.gov/filings/public/filing/search/", raw_sha256: sha });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, countOf };
