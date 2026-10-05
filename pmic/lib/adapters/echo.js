// EPA ECHO enforcement case services (echodata.epa.gov), no key. Per complete month: civil
// enforcement cases with any milestone (filed, lodged, settled, closed) in the month, those with
// a federal penalty, judicial cases, and the federal penalties of cases settled that month.
// Cases are entered with a lag, so recent months fill in on later passes.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths, num, anyDate } = require("./common");

const BASE = "https://echodata.epa.gov/echo/case_rest_services";
const CITE = "https://echo.epa.gov/facilities/enforcement-case-search";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; PMIC-collector/1.0)", Accept: "application/json" }; // the default Node agent gets a 503
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

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const months = new Map();
    let sha = null;
    for (const m of completeMonths(since, ctx.now)) {
      const range = `p_from_date=${encodeURIComponent(us(m))}&p_to_date=${encodeURIComponent(us(lastDay(m)))}`;
      const all = await cases(ctx, `echo:${m}`, range);
      sha = all.sha;
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
      months.set(m, { cases: Number(all.res.QueryRows) || 0, penalty_cases: Number(all.res.FedPenRows) || 0, judicial_cases: Number(all.res.JDCRows) || 0, penalties: Math.round(penalties) });
    }
    for (const s of series) {
      const f = s.params.feed;
      if (!["cases", "penalty_cases", "judicial_cases", "penalties"].includes(f)) throw new SchemaError(`echo: unknown feed '${f}'`);
      const since2 = ctx.since(s);
      for (const [m, v] of months) {
        if (m < since2) continue;
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: v[f], source_url: CITE, raw_sha256: sha });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect };
