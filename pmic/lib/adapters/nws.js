// National Weather Service active alerts (api.weather.gov). The API only serves what is active
// now, so this is a daily snapshot: active warnings of Severe or Extreme severity. History builds
// one point a day from the first run, so the series starts as a watch item.
"use strict";

const { SchemaError, parseJson, ymd } = require("./common");

const URL_ACTIVE = "https://api.weather.gov/alerts/active?status=actual&message_type=alert,update";
const CITE = "https://www.weather.gov/alerts";

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const contact = ctx.env.PMIC_SEC_USER_AGENT || "PMIC-collector/1.0 (https://github.com/organiccryptoyyc/pocket-agentic-services)";
    const r = await ctx.get("nws:active", URL_ACTIVE, { headers: { "User-Agent": contact, Accept: "application/geo+json" } });
    const body = parseJson(r.text, "nws alerts");
    if (!Array.isArray(body.features)) throw new SchemaError("nws alerts: no features array");
    const props = body.features.map((f) => f.properties || {});
    const count = { severe: props.filter((p) => p.severity === "Severe" || p.severity === "Extreme").length, extreme: props.filter((p) => p.severity === "Extreme").length };
    for (const s of series) {
      if (!(s.params.feed in count)) throw new SchemaError(`nws: unknown feed '${s.params.feed}'`);
      out.observations.push({ series_id: s.series_id, observation_time: ymd(ctx.now), period: ymd(ctx.now), value: count[s.params.feed], source_url: CITE, raw_sha256: r.sha256 });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect };
