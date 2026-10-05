// EPA ECHO enforcement case services (echodata.epa.gov), no key. Per complete month: civil
// enforcement cases with any milestone (filed, lodged, settled, closed) in the month, those with
// a federal penalty, judicial cases, and the federal penalties of cases settled that month.
// Cases are entered with a lag, so the last six months are re-read every pass (newest first);
// older months are kept from earlier passes. ECHO rate limits bursts (429): the pass stops there, keeps the months
// it has, and the next pass carries on.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths, num, anyDate } = require("./common");
const { FetchError } = require("../net");

const BASE = "https://echodata.epa.gov/echo/case_rest_services";
const CITE = "https://echo.epa.gov/facilities/enforcement-case-search";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; PMIC-collector/1.0)", Accept: "application/json" }; // the default Node agent gets a 503
const REREAD_MONTHS = 6;
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const lastDay = (m) => new Date(Date.parse(`${addMonths(m, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

async function cases(ctx, jobKey, query) {
  const r = await ctx.get(jobKey, `${BASE}.get_cases?output=JSON&responseset=500&${query}`, { headers: HEADERS });
  const body = parseJson(r.text, "echo get_cases");
  const res = body.Results || {};
  if (res.Error) throw new SchemaError(`echo: ${res.Error.ErrorMessage || "error"}`);
  if (res.QueryRows === undefined) throw new SchemaError("echo get_cases: no QueryRows");
  return { res, sha: r.sha256 };
}

// One month: case counts, and the federal penalties of cases settled in it.
async function readMonth(ctx, m) {
  const range = `p_from_date=${encodeURIComponent(us(m))}&p_to_date=${encodeURIComponent(us(lastDay(m)))}`;
  const all = await cases(ctx, `echo:${m}`, range);
  const pen = await cases(ctx, `echo:${m}:penalty`, `${range}&p_fed_penalty=ANY`);
  let penalties = 0;
  const rows = Number(pen.res.QueryRows) || 0;
  for (let page = 1; (page - 1) * 500 < rows && page <= 20; page++) {
    const r = await ctx.get(`echo:${m}:qid:${page}`, `${BASE}.get_qid?output=JSON&qid=${encodeURIComponent(pen.res.QueryID)}&pageno=${page}`, { headers: HEADERS });
    const body = parseJson(r.text, "echo get_qid");
    const list = body.Results && body.Results.Cases;
    if (!Array.isArray(list)) throw new SchemaError("echo get_qid: no Cases array");
    for (const c of list) {
      const settled = anyDate(c.SettlementDate);
      const v = num(String(c.FedPenalty || "").replace(/\$/g, ""));
      if (settled && settled.slice(0, 7) === m.slice(0, 7) && v) penalties += v;
    }
  }
  return { cases: Number(all.res.QueryRows) || 0, penalty_cases: Number(all.res.FedPenRows) || 0, judicial_cases: Number(all.res.JDCRows) || 0, penalties: Math.round(penalties), sha256: all.sha };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const all = completeMonths(since, ctx.now);
    const months = new Map(Object.entries(ctx.kvGet("months") || {}).filter(([m]) => m >= all[0]));
    const recent = new Set(all.slice(-REREAD_MONTHS));
    let limited = false;
    for (const m of [...all].reverse()) { // newest first, so a rate-limited pass still has the latest months
      if (months.has(m) && !recent.has(m)) continue;
      try {
        months.set(m, await readMonth(ctx, m));
      } catch (e) {
        if (!(e instanceof FetchError && e.status === 429)) throw e;
        limited = true;
        break;
      }
      ctx.kvSet("months", Object.fromEntries(months));
    }
    if (limited) {
      if (!months.size) throw new FetchError("echo: rate limited before any month was read", 429);
      ctx.note("echo", `echo: rate limited; ${months.size} of ${all.length} months read, the next pass carries on`);
    }
    for (const s of series) {
      const f = s.params.feed;
      if (!["cases", "penalty_cases", "judicial_cases", "penalties"].includes(f)) throw new SchemaError(`echo: unknown feed '${f}'`);
      const since2 = ctx.since(s);
      for (const [m, v] of months) {
        if (m < since2) continue;
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: v[f], source_url: CITE, raw_sha256: v.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect };
