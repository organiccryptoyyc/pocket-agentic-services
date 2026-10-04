// NHTSA safety recalls from the U.S. DOT open data portal (Socrata dataset 6axg-epim, "Recalls
// Data"), paged 5,000 rows at a time with SoQL. Counted by report received date into complete
// weeks, with the units potentially affected. Large or do-not-drive recalls become events.
"use strict";

const { SchemaError, num, parseJson, anyDate, weeklyCounts } = require("./common");

const BASE = "https://data.transportation.gov/resource/6axg-epim.json";
const PAGE = 5000;

function rowOf(x) {
  return {
    id: x.nhtsa_id || x.campno || x.nhtsa_campaign_number,
    date: anyDate(x.report_received_date || x.rcdate),
    manufacturer: x.manufacturer || x.mfgname || null,
    subject: x.subject || x.component || null,
    component: x.component || null,
    units: num(x.potentially_affected) || 0,
    do_not_drive: String(x.do_not_drive_advisory || "").toLowerCase() === "yes",
    type: x.recall_type || null,
  };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const rows = [];
    let sha = null;
    for (let offset = 0; offset < 50000; offset += PAGE) {
      const where = encodeURIComponent(`report_received_date >= '${since}T00:00:00'`);
      const url = `${BASE}?$where=${where}&$order=report_received_date%20DESC&$limit=${PAGE}&$offset=${offset}`;
      const r = await ctx.get(`nhtsa:recalls:${offset}`, url, { headers: { Accept: "application/json" } });
      const body = parseJson(r.text, "nhtsa recalls");
      if (!Array.isArray(body)) throw new SchemaError(`nhtsa recalls: ${body && body.message ? body.message : "answer is not a JSON array"}`);
      rows.push(...body.map(rowOf));
      sha = r.sha256;
      if (body.length < PAGE) break;
    }
    const recalls = rows.filter((x) => x.id && x.date);
    if (rows.length && !recalls.length) throw new SchemaError("nhtsa recalls: rows have no nhtsa_id/report_received_date");
    const cite = "https://www.nhtsa.gov/recalls";
    for (const s of series) {
      const pairs = recalls.map((x) => [x.date, s.params.feed === "units" ? x.units : 1]);
      for (const [w, n] of weeklyCounts(pairs, ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: sha });
      }
    }
    const eventSince = ctx.eventSince();
    for (const x of recalls) {
      if (x.date < eventSince || !(x.do_not_drive || x.units >= 100000)) continue;
      out.events.push({
        external_id: `nhtsa:${x.id}`,
        entity_id: "us-vehicles",
        event_type: "vehicle_recall",
        event_time: x.date,
        title: `${x.manufacturer || "Manufacturer"} recall ${x.id}: ${String(x.subject || x.component || "").slice(0, 160)} (${x.units.toLocaleString("en-US")} units${x.do_not_drive ? ", do not drive" : ""})`,
        severity: x.do_not_drive || x.units >= 1e6 ? "high" : "medium",
        detail: { nhtsa_id: x.id, manufacturer: x.manufacturer, component: x.component, potentially_affected: x.units, do_not_drive: x.do_not_drive, recall_type: x.type },
        source_url: `https://www.nhtsa.gov/?nhtsaId=${encodeURIComponent(x.id)}`,
        raw_sha256: sha,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, rowOf };
