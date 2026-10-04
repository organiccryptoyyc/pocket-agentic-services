// USGS earthquake catalog (FDSN event service). One count request per complete month and series:
// global quakes of magnitude 6 or more, and magnitude 4 or more inside a box around the US
// (lower 48, Alaska, Hawaii, Puerto Rico; it also catches nearby Canada and Mexico). Quakes of
// magnitude 6.5 or more anywhere in the event window become events.
"use strict";

const { SchemaError, parseJson, ymd, completeMonths, addMonths } = require("./common");

const BASE = "https://earthquake.usgs.gov/fdsnws/event/1";
const CITE = "https://earthquake.usgs.gov/earthquakes/search/";
const REGION = { us: "&minlatitude=17&maxlatitude=72&minlongitude=-180&maxlongitude=-64", global: "" };

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    try {
      const region = REGION[s.params.region];
      if (region === undefined) throw new SchemaError(`usgs: unknown region '${s.params.region}'`);
      for (const m of completeMonths(ctx.since(s), ctx.now)) {
        const url = `${BASE}/count?format=geojson&starttime=${m}&endtime=${addMonths(m, 1)}&minmagnitude=${s.params.min_magnitude}${region}`;
        const r = await ctx.get(`usgs:${s.series_id}:${m}`, url);
        const body = parseJson(r.text, `usgs ${s.series_id}`);
        if (typeof body.count !== "number") throw new SchemaError("usgs count: no count field");
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: body.count, source_url: CITE, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  try {
    const url = `${BASE}/query?format=geojson&starttime=${ctx.eventSince()}&endtime=${ymd(ctx.now)}&minmagnitude=6.5&orderby=time`;
    const r = await ctx.get("usgs:events", url);
    const body = parseJson(r.text, "usgs events");
    for (const f of body.features || []) {
      const p = f.properties || {};
      if (!f.id || !p.time) continue;
      out.events.push({
        external_id: `usgs:${f.id}`,
        entity_id: "us-hazards",
        event_type: "earthquake",
        event_time: ymd(new Date(p.time)),
        title: `Magnitude ${p.mag} earthquake: ${p.place || "unknown location"}`.slice(0, 300),
        severity: p.mag >= 7 || p.alert === "red" || p.alert === "orange" ? "high" : "medium",
        detail: { magnitude: p.mag, place: p.place, tsunami: p.tsunami === 1, pager_alert: p.alert || null, felt_reports: p.felt || null },
        source_url: p.url || CITE,
        raw_sha256: r.sha256,
      });
    }
  } catch (e) {
    ctx.fail([], e);
  }
  return out;
}

module.exports = { collect };
