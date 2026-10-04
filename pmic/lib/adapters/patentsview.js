// USPTO PatentsView PatentSearch API v1: utility patents granted per month to each company's
// assignee names (config sec.companies[].patent_assignees). One request per complete month and
// company asking only for total_hits. Needs a free key in PATENTSVIEW_API_KEY (X-Api-Key header);
// without it the series are skipped with a missing_key alert. The API allows 45 requests a minute,
// so requests are spaced 1.4 s apart.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");

const BASE = "https://search.patentsview.org/api/v1/patent/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(assignees, from, to) {
  const who = assignees.length === 1
    ? { "assignees.assignee_organization": assignees[0] }
    : { _or: assignees.map((a) => ({ "assignees.assignee_organization": a })) };
  return { _and: [who, { _gte: { patent_date: from } }, { _lt: { patent_date: to } }] };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const key = ctx.env.PATENTSVIEW_API_KEY;
  if (!key) {
    ctx.missingKey("patentsview", "PATENTSVIEW_API_KEY", series.map((s) => s.series_id));
    return out;
  }
  const gap = ctx.env.PMIC_PATENTSVIEW_GAP_MS !== undefined ? Number(ctx.env.PMIC_PATENTSVIEW_GAP_MS) : 1400;
  let first = true;
  for (const s of series) {
    try {
      const assignees = s.params.assignees || [];
      if (!assignees.length) throw new SchemaError(`patentsview ${s.series_id}: no assignee names configured`);
      const cite = `https://datatool.patentsview.org/#search&asn=${encodeURIComponent(assignees[0])}`;
      for (const m of completeMonths(ctx.since(s), ctx.now)) {
        if (!first) await sleep(gap);
        first = false;
        const q = encodeURIComponent(JSON.stringify(query(assignees, m, addMonths(m, 1))));
        const url = `${BASE}?q=${q}&f=${encodeURIComponent('["patent_id"]')}&o=${encodeURIComponent('{"size":1}')}`;
        const r = await ctx.get(`patentsview:${s.series_id}:${m}`, url, { headers: { "X-Api-Key": key, Accept: "application/json" } });
        const body = parseJson(r.text, `patentsview ${s.series_id}`);
        if (body.error) throw new SchemaError(`patentsview: ${body.error}`);
        const n = typeof body.total_hits === "number" ? body.total_hits : typeof body.count === "number" ? body.count : null;
        if (n === null) throw new SchemaError("patentsview: no total_hits");
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: cite, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, query };
