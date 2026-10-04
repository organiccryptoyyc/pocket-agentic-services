// USAspending.gov API v2. Total award obligations by month from spending_over_time (one POST for
// the whole window; months come back as fiscal year + fiscal month, October = 1), and obligations
// by awarding agency from spending_by_category, one POST per month. Agency months already read are
// kept; the latest four are re-read, since agencies (Defense especially) report late.
// Recent months fill in as agencies report, so a month is only stored once SETTLE_DAYS have passed
// since it ended (params.settle_days overrides: Defense publishes procurement 90 days late).
// Before this rule, September 2026 read $129B against about $300B in a normal month.
"use strict";

const { SchemaError, parseJson, pad, ymd, completeMonths, addMonths } = require("./common");

const BASE = "https://api.usaspending.gov/api/v2";
const REFRESH_MONTHS = 4;
const SETTLE_DAYS = 45;

// Fiscal year 2026, fiscal month 1 -> 2025-10-01.
function fiscalToMonth(fy, fm) {
  const f = Number(fy);
  const m = Number(fm);
  if (!Number.isInteger(f) || !(m >= 1 && m <= 12)) return null;
  const cal = ((m + 8) % 12) + 1;
  return `${cal >= 10 ? f - 1 : f}-${pad(cal)}-01`;
}

function lastDay(m) {
  return new Date(Date.parse(`${addMonths(m, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

// Months whose end is at least `days` before now.
function settled(months, now, days = SETTLE_DAYS) {
  return months.filter((m) => Date.parse(`${lastDay(m)}T00:00:00Z`) + days * 86400000 <= now.getTime());
}

const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const total = series.find((s) => s.params.feed === "total");
  const agencies = series.filter((s) => s.params.feed === "agency");
  const cite = "https://www.usaspending.gov/search";

  if (total) {
    try {
      const since = ctx.since(total);
      const months = new Set(settled(completeMonths(since, ctx.now), ctx.now, total.params.settle_days));
      const r = await ctx.get("usaspending:over_time", `${BASE}/search/spending_over_time/`, post({ group: "month", filters: { time_period: [{ start_date: since, end_date: ymd(ctx.now) }] } }));
      const body = parseJson(r.text, "usaspending spending_over_time");
      if (!Array.isArray(body.results)) throw new SchemaError(`usaspending spending_over_time: ${body.detail || "no results array"}`);
      for (const x of body.results) {
        const m = x.time_period && fiscalToMonth(x.time_period.fiscal_year, x.time_period.month);
        const v = Number(x.aggregated_amount);
        if (!m || !months.has(m) || !Number.isFinite(v)) continue;
        out.observations.push({ series_id: total.series_id, observation_time: m, period: m.slice(0, 7), value: Math.round(v), source_url: cite, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([total.series_id], e);
    }
  }

  if (agencies.length) {
    try {
      const months = completeMonths(agencies.map((s) => ctx.since(s)).sort()[0], ctx.now);
      const cache = ctx.kvGet("agency_months") || {};
      const refresh = new Set(months.slice(-REFRESH_MONTHS));
      let sha = null;
      for (const m of months) {
        if (cache[m] && !refresh.has(m)) continue;
        const r = await ctx.get(`usaspending:agencies:${m}`, `${BASE}/search/spending_by_category/awarding_agency/`, post({ filters: { time_period: [{ start_date: m, end_date: lastDay(m) }] }, limit: 50, page: 1 }));
        const body = parseJson(r.text, `usaspending agencies ${m}`);
        if (!Array.isArray(body.results)) throw new SchemaError(`usaspending spending_by_category: ${body.detail || "no results array"}`);
        cache[m] = Object.fromEntries(body.results.filter((x) => x && x.name).map((x) => [x.name, Math.round(Number(x.amount) || 0)]));
        sha = r.sha256;
        ctx.kvSet("agency_months", cache);
      }
      for (const k of Object.keys(cache)) if (!months.includes(k)) delete cache[k];
      ctx.kvSet("agency_months", cache);
      for (const s of agencies) {
        const want = s.params.agency.toLowerCase();
        if (!months.some((m) => cache[m] && Object.keys(cache[m]).some((k) => k.toLowerCase() === want))) {
          ctx.fail([s.series_id], new SchemaError(`usaspending: agency '${s.params.agency}' not among the top 50 awarding agencies`), { kind: "empty_response" });
          continue;
        }
        for (const m of settled(months, ctx.now, s.params.settle_days)) {
          if (!cache[m]) continue;
          const hit = Object.entries(cache[m]).find(([k]) => k.toLowerCase() === want);
          out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: hit ? hit[1] : 0, source_url: cite, raw_sha256: sha });
        }
      }
    } catch (e) {
      ctx.fail(agencies.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, fiscalToMonth, settled };
