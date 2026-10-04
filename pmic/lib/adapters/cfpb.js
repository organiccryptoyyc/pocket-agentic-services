// CFPB Consumer Complaint Database search API. One request per calendar month (size=1, the
// product aggregation carries exact counts): the total and the count per product family. Months
// already read are remembered and only the latest three are re-read, since complaints arrive late.
"use strict";

const { SchemaError, parseJson, completeMonths, addMonths } = require("./common");

const BASE = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/";
const REFRESH_MONTHS = 3;

function lastDay(monthStart) {
  return new Date(Date.parse(`${addMonths(monthStart, 1)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

// The product aggregation is nested one or two levels deep depending on the API version.
function findBuckets(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  if (Array.isArray(node.buckets)) return node.buckets;
  for (const v of Object.values(node)) {
    const b = findBuckets(v, depth + 1);
    if (b) return b;
  }
  return null;
}

function monthCounts(body) {
  const buckets = findBuckets(body.aggregations && body.aggregations.product);
  const products = {};
  for (const b of buckets || []) if (b && typeof b.key === "string") products[b.key] = Number(b.doc_count) || 0;
  const hits = body.hits && body.hits.total;
  const hitTotal = typeof hits === "number" ? hits : hits && typeof hits.value === "number" && hits.relation !== "gte" ? hits.value : null;
  const bucketTotal = buckets ? Object.values(products).reduce((a, b) => a + b, 0) : null;
  const total = bucketTotal !== null ? Math.max(bucketTotal, hitTotal || 0) : hitTotal;
  if (total === null) throw new SchemaError("cfpb: answer has neither hits.total nor a product aggregation");
  return { total, products };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const months = completeMonths(since, ctx.now);
    const cache = ctx.kvGet("months") || {};
    const refresh = new Set(months.slice(-REFRESH_MONTHS));
    let sha = null;
    for (const m of months) {
      if (cache[m] && !refresh.has(m)) continue;
      const url = `${BASE}?date_received_min=${m}&date_received_max=${lastDay(m)}&size=1&no_highlight=true`;
      const r = await ctx.get(`cfpb:${m}`, url, { headers: { Accept: "application/json" } });
      cache[m] = monthCounts(parseJson(r.text, `cfpb ${m}`));
      sha = r.sha256;
      ctx.kvSet("months", cache);
    }
    for (const k of Object.keys(cache)) if (!months.includes(k)) delete cache[k];
    ctx.kvSet("months", cache);
    for (const s of series) {
      const want = s.params.product ? s.params.product.toLowerCase() : null;
      if (want && !months.some((m) => cache[m] && Object.keys(cache[m].products).some((k) => k.toLowerCase().includes(want)))) {
        ctx.fail([s.series_id], new SchemaError(`cfpb: no product name contains '${want}'`), { kind: "empty_response" });
        continue;
      }
      for (const m of months) {
        const c = cache[m];
        if (!c) continue;
        const v = want ? Object.entries(c.products).filter(([k]) => k.toLowerCase().includes(want)).reduce((a, [, n]) => a + n, 0) : c.total;
        out.observations.push({
          series_id: s.series_id,
          observation_time: m,
          period: m.slice(0, 7),
          value: v,
          source_url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/?date_received_min=${m}&date_received_max=${lastDay(m)}`,
          raw_sha256: sha,
        });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, monthCounts, findBuckets };
