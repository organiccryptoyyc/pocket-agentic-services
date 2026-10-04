// CISA Known Exploited Vulnerabilities catalog: the whole catalog is one JSON file. Counted by
// dateAdded into complete weeks: all additions, and those CISA marks as used in ransomware
// campaigns. Each addition in the event window is an event.
"use strict";

const { SchemaError, parseJson, anyDate, weeklyCounts } = require("./common");

const URL_KEV = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const CITE = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";

function kevOf(body) {
  if (!body || !Array.isArray(body.vulnerabilities)) throw new SchemaError("cisa kev: no vulnerabilities array");
  return body.vulnerabilities.map((v) => ({
    cve: v.cveID,
    added: anyDate(v.dateAdded),
    vendor: v.vendorProject || null,
    product: v.product || null,
    name: v.vulnerabilityName || null,
    ransomware: String(v.knownRansomwareCampaignUse || "").toLowerCase() === "known",
    due: anyDate(v.dueDate),
  })).filter((v) => v.cve && v.added);
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const r = await ctx.get("cisa:kev", URL_KEV, { headers: { Accept: "application/json" } });
    const kev = kevOf(parseJson(r.text, "cisa kev"));
    const pick = { added: () => true, ransomware: (v) => v.ransomware };
    for (const s of series) {
      const keep = pick[s.params.feed];
      if (!keep) throw new SchemaError(`cisa: unknown feed '${s.params.feed}'`);
      for (const [w, n] of weeklyCounts(kev.filter(keep).map((v) => [v.added, 1]), ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: CITE, raw_sha256: r.sha256 });
      }
    }
    const eventSince = ctx.eventSince();
    for (const v of kev) {
      if (v.added < eventSince) continue;
      out.events.push({
        external_id: `kev:${v.cve}`,
        entity_id: "us-cyber",
        event_type: "exploited_vulnerability",
        event_time: v.added,
        title: `${v.cve} added to CISA KEV: ${v.vendor || ""} ${v.product || ""}${v.ransomware ? " (used in ransomware)" : ""}`.replace(/\s+/g, " ").slice(0, 300),
        severity: v.ransomware ? "high" : "medium",
        detail: { cve: v.cve, vendor: v.vendor, product: v.product, name: v.name, ransomware: v.ransomware, remediation_due: v.due },
        source_url: `https://nvd.nist.gov/vuln/detail/${v.cve}`,
        raw_sha256: r.sha256,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, kevOf };
