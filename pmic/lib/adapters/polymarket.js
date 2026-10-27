// Polymarket Gamma API (public, no key): the Fed rate-decision markets ("Fed Decision in October?"),
// one event per FOMC meeting with one Yes/No market per outcome (50+ bps decrease ... 50+ bps
// increase). Each pass reads them once. Every upcoming meeting becomes an event on us-fomc whose
// detail carries the latest odds (updated in place); the next meeting's odds of a cut, a hold and a
// hike, and the implied change in basis points, are daily snapshots. Yes prices are normalized to
// sum to 1 across the outcomes; the raw sum is kept in the event detail. Used by the macro pack's
// fed-consensus brief next to the bond market (2-year yield vs fed funds) and the data.
"use strict";

const { SchemaError, num, parseJson, ymd } = require("./common");

const URL = "https://gamma-api.polymarket.com/events?closed=false&limit=100&tag_slug=fed-rates";
const CITE = "https://polymarket.com/predictions/fed-rates";
// Outcome titles Polymarket uses for a meeting's markets, with the change each one stands for.
// "50+ bps" counts as 50 in the implied change.
const OUTCOMES = [
  [/^50\+ bps decrease$/i, -50],
  [/^25 bps decrease$/i, -25],
  [/^no change$/i, 0],
  [/^25 bps increase$/i, 25],
  [/^50\+ bps increase$/i, 50],
];
const FEED = { p_cut: "p_cut", p_hold: "p_hold", p_hike: "p_hike", implied_change_bp: "implied_change_bp" };

const bpsOf = (title) => {
  const hit = OUTCOMES.find(([re]) => re.test(String(title || "").trim()));
  return hit ? hit[1] : null;
};

function yesPrice(market) {
  let outcomes = market.outcomes;
  let prices = market.outcomePrices;
  try {
    if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
    if (typeof prices === "string") prices = JSON.parse(prices);
  } catch {
    return null;
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;
  const i = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  return i < 0 ? null : num(prices[i]);
}

// One FOMC meeting from a Polymarket event, or null if it isn't a rate-decision event we can read.
function meetingOf(ev) {
  if (!/^fed-decision-in-/.test(String(ev.slug || "")) || !Array.isArray(ev.markets)) return null;
  const outcomes = [];
  const unknown = [];
  for (const m of ev.markets) {
    if (m.closed) continue;
    const bps = bpsOf(m.groupItemTitle);
    const p = yesPrice(m);
    if (bps === null || p === null) {
      unknown.push(String(m.groupItemTitle || m.question || "").slice(0, 80));
      continue;
    }
    outcomes.push({ outcome: m.groupItemTitle, bps, p_yes: p });
  }
  const sum = outcomes.reduce((a, o) => a + o.p_yes, 0);
  if (outcomes.length < 3 || !(sum > 0)) return null;
  const p = (pred) => Math.round((outcomes.filter((o) => pred(o.bps)).reduce((a, o) => a + o.p_yes, 0) / sum) * 10000) / 10000;
  return {
    slug: ev.slug,
    title: ev.title,
    closes_at: ev.endDate,
    outcomes: outcomes.sort((a, b) => a.bps - b.bps).map((o) => ({ ...o, p: Math.round((o.p_yes / sum) * 10000) / 10000 })),
    unknown_outcomes: unknown,
    raw_sum: Math.round(sum * 10000) / 10000,
    p_cut: p((b) => b < 0),
    p_hold: p((b) => b === 0),
    p_hike: p((b) => b > 0),
    implied_change_bp: Math.round((outcomes.reduce((a, o) => a + o.p_yes * o.bps, 0) / sum) * 10) / 10,
    volume_24h_usd: num(ev.volume24hr),
    url: `https://polymarket.com/event/${ev.slug}`,
  };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  let r;
  try {
    r = await ctx.get("polymarket:fed-rates", URL, { headers: { Accept: "application/json" } });
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
    return out;
  }
  const body = parseJson(r.text, "polymarket fed-rates");
  if (!Array.isArray(body)) throw new SchemaError("polymarket: answer is not a JSON array of events");
  const now = ctx.now.getTime();
  const meetings = body.map(meetingOf).filter((m) => m && Date.parse(m.closes_at) > now).sort((a, b) => a.closes_at.localeCompare(b.closes_at));
  if (!meetings.length) {
    ctx.fail(series.map((s) => s.series_id), new SchemaError("polymarket: no open Fed decision market found under tag fed-rates"));
    return out;
  }
  for (const m of meetings) {
    out.events.push({
      external_id: m.slug,
      entity_id: "us-fomc",
      event_type: "fed_decision_market",
      event_time: new Date(Date.parse(m.closes_at)).toISOString().replace(".000Z", "Z"),
      title: `Polymarket: ${m.title} (market closes ${m.closes_at.slice(0, 10)})`,
      severity: "low",
      detail: { ...m, observed_at: ctx.nowIso },
      source_url: m.url,
      raw_sha256: r.sha256,
    });
  }
  const next = meetings[0];
  const today = ymd(ctx.now);
  for (const s of series) {
    const key = FEED[s.params.feed];
    if (!key) throw new SchemaError(`polymarket: unknown feed '${s.params.feed}'`);
    out.observations.push({ series_id: s.series_id, observation_time: today, period: today, value: next[key], source_url: CITE, raw_sha256: r.sha256 });
  }
  return out;
}

module.exports = { collect, meetingOf, bpsOf };
