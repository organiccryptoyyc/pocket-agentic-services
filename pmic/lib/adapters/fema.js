// OpenFEMA DisasterDeclarationsSummaries v2: one row per declared county or tribal area, so rows
// are grouped by disasterNumber first. Counted by declaration date into complete months: all
// declarations, and major disasters (type DR) only. Each declaration is also an event.
"use strict";

const { SchemaError, parseJson, anyDate, monthlyCounts } = require("./common");

const BASE = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";
const CITE = "https://www.fema.gov/disaster/declarations";
const PAGE = 10000;

function declarationsOf(rows) {
  const byNumber = new Map();
  for (const x of rows) {
    const n = x.disasterNumber;
    const date = anyDate(x.declarationDate);
    if (n === undefined || n === null || !date) continue;
    const d = byNumber.get(n) || { number: n, date, type: x.declarationType || null, incident: x.incidentType || null, title: x.declarationTitle || null, states: new Set(), areas: 0 };
    if (x.state) d.states.add(x.state);
    d.areas++;
    byNumber.set(n, d);
  }
  return [...byNumber.values()].map((d) => ({ ...d, states: [...d.states].sort() }));
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const rows = [];
    let sha = null;
    for (let skip = 0; skip < 200000; skip += PAGE) {
      const filter = encodeURIComponent(`declarationDate ge '${since}T00:00:00.000Z'`);
      const select = "disasterNumber,declarationDate,declarationType,incidentType,declarationTitle,state";
      const url = `${BASE}?$filter=${filter}&$select=${select}&$orderby=declarationDate&$top=${PAGE}&$skip=${skip}`;
      const r = await ctx.get(`fema:declarations:${skip}`, url, { headers: { Accept: "application/json" } });
      sha = r.sha256;
      const body = parseJson(r.text, "openfema declarations");
      const page = body.DisasterDeclarationsSummaries;
      if (!Array.isArray(page)) throw new SchemaError("openfema: no DisasterDeclarationsSummaries array");
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    const decl = declarationsOf(rows);
    const pick = { all: () => true, major: (d) => d.type === "DR" };
    for (const s of series) {
      const keep = pick[s.params.feed];
      if (!keep) throw new SchemaError(`fema: unknown feed '${s.params.feed}'`);
      for (const [m, n] of monthlyCounts(decl.filter(keep).map((d) => [d.date, 1]), ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: CITE, raw_sha256: sha });
      }
    }
    const eventSince = ctx.eventSince();
    for (const d of decl) {
      if (d.date < eventSince) continue;
      out.events.push({
        external_id: `fema:${d.number}`,
        entity_id: "us-hazards",
        event_type: "disaster_declaration",
        event_time: d.date,
        title: `${d.type === "DR" ? "Major disaster" : d.type === "EM" ? "Emergency" : "Fire management"} declaration ${d.number}: ${d.title || d.incident || "incident"} (${d.states.join(", ") || "n/a"})`.slice(0, 300),
        severity: d.type === "DR" ? "high" : "medium",
        detail: { disaster_number: d.number, declaration_type: d.type, incident_type: d.incident, states: d.states, designated_areas: d.areas },
        source_url: `https://www.fema.gov/disaster/${d.number}`,
        raw_sha256: sha,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, declarationsOf };
