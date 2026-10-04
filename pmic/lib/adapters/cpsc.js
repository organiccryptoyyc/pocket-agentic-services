// CPSC Recalls API (SaferProducts.gov): every recall announced in the window, one request.
// Counted by recall date into complete weeks, with the units covered (parsed from each product's
// NumberOfUnits text, "About 12,000", so approximate). Each recall is also an event.
"use strict";

const { SchemaError, parseJson, anyDate, ymd, weeklyCounts } = require("./common");

const BASE = "https://www.saferproducts.gov/RestWebServices/Recall";

// "About 1.2 million", "About 12,000 (in addition, about 500 were sold in Canada)" -> US units.
function units(text) {
  const s = String(text || "").toLowerCase().split(/\(|;/)[0];
  const m = /([\d.,]+)\s*(million|thousand)?/.exec(s);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (m[2] === "million" ? 1e6 : m[2] === "thousand" ? 1e3 : 1));
}

function recallsOf(body) {
  if (!Array.isArray(body)) throw new SchemaError("cpsc recalls: answer is not a JSON array");
  return body.map((x) => ({
    id: x.RecallNumber || x.RecallID,
    date: anyDate(x.RecallDate),
    title: x.Title || (x.Products && x.Products[0] && x.Products[0].Name) || "recall",
    url: x.URL || null,
    units: (x.Products || []).reduce((a, p) => a + units(p.NumberOfUnits), 0),
    hazards: (x.Hazards || []).map((h) => h.Name).filter(Boolean),
    injuries: (x.Injuries || []).map((h) => h.Name).filter(Boolean),
  })).filter((x) => x.id && x.date);
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const url = `${BASE}?format=json&RecallDateStart=${since}&RecallDateEnd=${ymd(ctx.now)}`;
    const r = await ctx.get("cpsc:recalls", url, { headers: { Accept: "application/json" } });
    const recalls = recallsOf(parseJson(r.text, "cpsc recalls"));
    const cite = "https://www.cpsc.gov/Recalls";
    for (const s of series) {
      const pairs = recalls.map((x) => [x.date, s.params.feed === "units" ? x.units : 1]);
      for (const [w, n] of weeklyCounts(pairs, ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: r.sha256 });
      }
    }
    const eventSince = ctx.eventSince();
    for (const x of recalls) {
      if (x.date < eventSince) continue;
      const serious = x.injuries.some((i) => /death|died|fatal/i.test(i)) || x.units >= 1e6;
      out.events.push({
        external_id: `cpsc:${x.id}`,
        entity_id: "us-consumer-products",
        event_type: "product_recall",
        event_time: x.date,
        title: `${String(x.title).slice(0, 200)}${x.units ? ` (about ${x.units.toLocaleString("en-US")} units)` : ""}`,
        severity: serious ? "high" : "medium",
        detail: { recall_number: x.id, units: x.units, hazards: x.hazards.slice(0, 5), injuries: x.injuries.slice(0, 3).map((i) => String(i).slice(0, 300)) },
        source_url: x.url || cite,
        raw_sha256: r.sha256,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, units, recallsOf };
