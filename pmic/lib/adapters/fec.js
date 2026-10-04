// OpenFEC: independent expenditures (Schedule E) reported per calendar month, read from the
// pagination count of a one-row query. FEC_API_KEY is a free api.data.gov key; without it the
// public DEMO_KEY is used, whose hourly limit is shared and low. Months already read are kept
// and only the latest three are re-read, since filings arrive late and get amended. When the key
// is rate limited (429) the pass stops there and keeps what it has; the next pass carries on.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");
const { FetchError } = require("../net");

const BASE = "https://api.open.fec.gov/v1";
const REFRESH_MONTHS = 3;

function lastDay(m) {
  return new Date(Date.parse(`${addMonths(m, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function countOf(body) {
  const n = body && body.pagination ? Number(body.pagination.count) : NaN;
  if (!Number.isFinite(n)) throw new SchemaError("fec: answer has no pagination.count");
  return n;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const key = ctx.env.FEC_API_KEY || "DEMO_KEY";
  for (const s of series) {
    try {
      const months = completeMonths(ctx.since(s), ctx.now);
      const cache = ctx.kvGet(s.series_id) || {};
      const refresh = new Set(months.slice(-REFRESH_MONTHS));
      let sha = null;
      let limited = null;
      for (const m of months) {
        if (cache[m] !== undefined && !refresh.has(m)) continue;
        const url = `${BASE}/schedules/schedule_e/?api_key=${encodeURIComponent(key)}&min_date=${m}&max_date=${lastDay(m)}&per_page=1`;
        try {
          const r = await ctx.get(`fec:${s.params.feed}:${m}`, url, { headers: { Accept: "application/json" } });
          cache[m] = countOf(parseJson(r.text, `fec ${m}`));
          sha = r.sha256;
        } catch (e) {
          if (!(e instanceof FetchError && e.status === 429)) throw e;
          limited = e;
          break;
        }
        ctx.kvSet(s.series_id, cache);
      }
      if (limited) {
        const have = months.filter((m) => cache[m] !== undefined).length;
        const hint = ctx.env.FEC_API_KEY ? "" : " (on the shared DEMO_KEY; a free api.data.gov key in FEC_API_KEY lifts this)";
        if (!have) throw new FetchError(`fec: rate limited before any month was read${hint}`, 429);
        ctx.note("fec", `rate limited after ${have} of ${months.length} months${hint}; the rest are read on later passes`);
      }
      for (const k of Object.keys(cache)) if (!months.includes(k)) delete cache[k];
      ctx.kvSet(s.series_id, cache);
      for (const m of months) {
        if (cache[m] === undefined) continue;
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: cache[m], source_url: `https://www.fec.gov/data/independent-expenditures/?min_date=${m}&max_date=${lastDay(m)}`, raw_sha256: sha });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, countOf };
