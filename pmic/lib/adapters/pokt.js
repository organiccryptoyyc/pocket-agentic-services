// Pocket Network (Shannon) indexer, data.pocket.network GraphQL, no key. One request per run:
// per complete week, the sum of estimated relays (the throughput figure PoktScan quotes) and of
// claimed relays, plus the staked supplier and application counts on the last block of the week.
"use strict";

const { SchemaError, parseJson, completeWeeks, ymd } = require("./common");

const URL_GQL = "https://data.pocket.network/graphql";
const CITE = "https://poktscan.com";
const addDays = (d, n) => ymd(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000));
const FIELD = { estimated_relays: "est", claimed_relays: "claimed", staked_suppliers: "suppliers", staked_apps: "apps" };

function weeklyQuery(weeks) {
  const parts = weeks.map((w, i) => {
    const end = addDays(w, 7);
    return `w${i}: blocks(filter:{timestamp:{greaterThanOrEqualTo:"${w}T00:00:00",lessThan:"${end}T00:00:00"}}){ aggregates { sum { totalEstimatedRelays totalRelays } } } ` +
      `l${i}: blocks(filter:{timestamp:{lessThan:"${end}T00:00:00"}}, orderBy: ID_DESC, first: 1){ nodes { stakedSuppliers stakedApps } }`;
  });
  return `{ ${parts.join(" ")} }`;
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const weeks = completeWeeks(since, ctx.now);
    const rows = new Map();
    let sha = null;
    for (let i = 0; i < weeks.length; i += 20) {
      const chunk = weeks.slice(i, i + 20);
      const r = await ctx.get(`pokt:weeks:${chunk[0]}`, URL_GQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: weeklyQuery(chunk) }) });
      sha = r.sha256;
      const body = parseJson(r.text, "pokt graphql");
      if (body.errors) throw new SchemaError(`pokt graphql: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
      chunk.forEach((w, k) => {
        const sum = body.data[`w${k}`] && body.data[`w${k}`].aggregates && body.data[`w${k}`].aggregates.sum;
        const last = body.data[`l${k}`] && body.data[`l${k}`].nodes && body.data[`l${k}`].nodes[0];
        if (!sum || sum.totalEstimatedRelays === null) return;
        rows.set(w, { est: Number(sum.totalEstimatedRelays), claimed: Number(sum.totalRelays), suppliers: last ? last.stakedSuppliers : null, apps: last ? last.stakedApps : null });
      });
    }
    for (const s of series) {
      const f = FIELD[s.params.feed];
      if (!f) throw new SchemaError(`pokt: unknown feed '${s.params.feed}'`);
      const since2 = ctx.since(s);
      for (const [w, v] of rows) {
        if (w < since2 || v[f] === null || !Number.isFinite(v[f])) continue;
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: v[f], source_url: CITE, raw_sha256: sha });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, weeklyQuery };
