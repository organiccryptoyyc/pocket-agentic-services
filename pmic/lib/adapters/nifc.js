// National Interagency Fire Center, WFIGS Incident Locations (ArcGIS FeatureServer), no key.
// One statistics request per complete month: the number of wildfire incidents discovered that
// month and the acres they cover (IncidentSize, as last reported). Acres are a moving total for
// fires still burning, so the latest months can be revised upward.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");

const BASE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations/FeatureServer/0/query";
const CITE = "https://data-nifc.opendata.arcgis.com/";
const STATS = encodeURIComponent(JSON.stringify([
  { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" },
  { statisticType: "sum", onStatisticField: "IncidentSize", outStatisticFieldName: "acres" },
]));

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const months = new Map();
    let sha = null;
    for (const m of completeMonths(since, ctx.now)) {
      const where = encodeURIComponent(`FireDiscoveryDateTime >= date '${m}' AND FireDiscoveryDateTime < date '${addMonths(m, 1)}'`);
      const r = await ctx.get(`nifc:${m}`, `${BASE}?where=${where}&outStatistics=${STATS}&f=json`);
      sha = r.sha256;
      const body = parseJson(r.text, "nifc statistics");
      if (body.error) throw new SchemaError(`nifc: ${body.error.message || "error"}`);
      const a = body.features && body.features[0] && body.features[0].attributes;
      if (!a) throw new SchemaError("nifc: no statistics row");
      months.set(m, { incidents: Number(a.n) || 0, acres: Math.round(Number(a.acres) || 0) });
    }
    for (const s of series) {
      const f = s.params.feed;
      if (f !== "incidents" && f !== "acres") throw new SchemaError(`nifc: unknown feed '${f}'`);
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
