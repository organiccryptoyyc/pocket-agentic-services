// Federal Register API (federalregister.gov), no key. One count request per complete month and
// series: final rules, proposed rules, and significant rules (Executive Order 12866). New final
// rules in the event window become events (largest agencies first is not available, so newest).
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths, ymd } = require("./common");

const BASE = "https://www.federalregister.gov/api/v1/documents.json";
const CITE = "https://www.federalregister.gov/documents/search";
const FILTER = {
  final_rules: "conditions%5Btype%5D%5B%5D=RULE",
  proposed_rules: "conditions%5Btype%5D%5B%5D=PRORULE",
  significant_rules: "conditions%5Btype%5D%5B%5D=RULE&conditions%5Bsignificant%5D=1",
};

const lastDay = (m) => ymd(new Date(Date.parse(`${addMonths(m, 1)}T00:00:00Z`) - 86400000));

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  for (const s of series) {
    try {
      const f = FILTER[s.params.feed];
      if (!f) throw new SchemaError(`fedreg: unknown feed '${s.params.feed}'`);
      for (const m of completeMonths(ctx.since(s), ctx.now)) {
        const url = `${BASE}?per_page=1&fields%5B%5D=document_number&${f}&conditions%5Bpublication_date%5D%5Bgte%5D=${m}&conditions%5Bpublication_date%5D%5Blte%5D=${lastDay(m)}`;
        const r = await ctx.get(`fedreg:${s.params.feed}:${m}`, url);
        const body = parseJson(r.text, "federal register");
        if (typeof body.count !== "number") throw new SchemaError("federal register: no count");
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: body.count, source_url: CITE, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  try {
    const url = `${BASE}?per_page=50&order=newest&${FILTER.significant_rules}&conditions%5Bpublication_date%5D%5Bgte%5D=${ctx.eventSince()}&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=agencies&fields%5B%5D=html_url`;
    const r = await ctx.get("fedreg:events", url);
    const body = parseJson(r.text, "federal register events");
    for (const d of body.results || []) {
      if (!d.document_number || !d.publication_date) continue;
      out.events.push({
        external_id: `fr:${d.document_number}`,
        entity_id: "us-federal",
        event_type: "significant_rule",
        event_time: d.publication_date,
        title: `Significant final rule: ${String(d.title || "").slice(0, 220)}${d.agencies && d.agencies[0] ? ` (${d.agencies[0].name})` : ""}`.slice(0, 300),
        severity: "medium",
        detail: { document_number: d.document_number, agencies: (d.agencies || []).map((a) => a.name).slice(0, 3) },
        source_url: d.html_url || CITE,
        raw_sha256: r.sha256,
      });
    }
  } catch (e) {
    ctx.fail([], e);
  }
  return out;
}

module.exports = { collect };
