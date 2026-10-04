// FDIC BankFind Suite: the failures dataset, newest first. Failures are rare (a handful a year),
// so they are counted by calendar quarter over the slow (ten-year) window, zeros included, with
// the failed banks' total assets alongside. Each failure is also a high-severity event.
// The API moved from banks.data.fdic.gov/api to api.fdic.gov/banks; the old host is the fallback.
"use strict";

const { SchemaError, num, parseJson, anyDate, quarterOfDate, ymd } = require("./common");

const HOSTS = ["https://api.fdic.gov/banks", "https://banks.data.fdic.gov/api"];
const FIELDS = "CERT,NAME,CITYST,FAILDATE,QBFASSET,QBFDEP,COST,RESTYPE,RESTYPE1,SAVR";

function rowsOf(body) {
  if (!body || !Array.isArray(body.data)) throw new SchemaError("fdic failures: no data array");
  return body.data.map((r) => (r && r.data ? r.data : r));
}

// Calendar quarters from the one containing `since` up to the last complete quarter before now.
function completeQuarters(since, now) {
  const out = [];
  let q = quarterOfDate(since);
  const current = quarterOfDate(ymd(now));
  while (q < current) {
    out.push(q);
    const d = new Date(`${q}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 3);
    q = ymd(d);
  }
  return out;
}

async function fetchFailures(ctx) {
  let lastErr;
  for (const host of HOSTS) {
    const url = `${host}/failures?fields=${FIELDS}&sort_by=FAILDATE&sort_order=DESC&limit=500&format=json`;
    try {
      const r = await ctx.get("fdic:failures", url, { headers: { Accept: "application/json" } });
      return { rows: rowsOf(parseJson(r.text, "fdic failures")), sha: r.sha256 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const { rows, sha } = await fetchFailures(ctx);
    const failures = rows
      .map((x) => ({ ...x, date: anyDate(x.FAILDATE) }))
      .filter((x) => x.date);
    if (rows.length && !failures.length) throw new SchemaError("fdic failures: no row has a readable FAILDATE");
    const cite = "https://banks.data.fdic.gov/bankfind-suite/failures";
    for (const s of series) {
      const since = ctx.since(s);
      const totals = new Map(completeQuarters(since, ctx.now).map((q) => [q, 0]));
      for (const f of failures) {
        const q = quarterOfDate(f.date);
        if (!totals.has(q)) continue;
        totals.set(q, totals.get(q) + (s.params.feed === "assets" ? num(f.QBFASSET) || 0 : 1));
      }
      for (const [q, v] of totals) {
        out.observations.push({ series_id: s.series_id, observation_time: q, period: `${q.slice(0, 4)}Q${(Number(q.slice(5, 7)) + 2) / 3}`, value: v, source_url: cite, raw_sha256: sha });
      }
    }
    const eventSince = ctx.eventSince();
    for (const f of failures) {
      if (f.date < eventSince) continue;
      const assets = num(f.QBFASSET);
      out.events.push({
        external_id: `failure:${f.CERT || f.NAME}:${f.date}`,
        entity_id: "us-banking",
        event_type: "bank_failure",
        event_time: f.date,
        title: `Bank failure: ${f.NAME || "unknown bank"}${f.CITYST ? `, ${f.CITYST}` : ""}${assets ? ` (assets about $${Math.round(assets / 1000).toLocaleString("en-US")} million)` : ""}`,
        severity: "high",
        detail: { cert: f.CERT || null, name: f.NAME || null, city_state: f.CITYST || null, total_assets_thousands: assets, total_deposits_thousands: num(f.QBFDEP), estimated_cost_thousands: num(f.COST), resolution: f.RESTYPE1 || f.RESTYPE || null },
        source_url: cite,
        raw_sha256: sha,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, completeQuarters, rowsOf };
