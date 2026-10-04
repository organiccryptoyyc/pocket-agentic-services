// TreasuryDirect auction results (TA_WS securities/auctioned): every Note and Bond auction in the
// window, one request per security type. Monthly averages over that month's auctions: bid-to-cover,
// the indirect bidders' share (mostly foreign and institutional demand), the primary dealers' share
// (what dealers had to take down) and the high yield minus the median yield in basis points (a
// wide spread means bidding was thin at the top). TIPS and FRNs are left out of the yield spread.
"use strict";

const { SchemaError, num, parseJson, anyDate, completeMonths, monthStart } = require("./common");

const BASE = "https://www.treasurydirect.gov/TA_WS/securities/auctioned";
const TYPES = ["Note", "Bond"];
const CITE = "https://www.treasurydirect.gov/auctions/announcements-data-results/";

function auctionsOf(body) {
  if (!Array.isArray(body)) throw new SchemaError("treasurydirect: answer is not a JSON array");
  return body.map((x) => {
    const accepted = num(x.totalAccepted);
    const share = (v) => (accepted > 0 && num(v) !== null ? num(v) / accepted : null);
    const high = num(x.highYield);
    const median = num(x.averageMedianYield);
    const realOrFloating = String(x.tips || "").toLowerCase() === "yes" || String(x.floatingRate || "").toLowerCase() === "yes";
    return {
      cusip: x.cusip,
      date: anyDate(x.auctionDate),
      term: x.securityTerm || null,
      type: x.securityType || null,
      btc: num(x.bidToCoverRatio),
      indirect: share(x.indirectBidderAccepted),
      dealer: share(x.primaryDealerAccepted),
      spread_bp: !realOrFloating && high !== null && median !== null ? Math.round((high - median) * 1000) / 10 : null,
      high,
      offering: num(x.offeringAmount),
    };
  }).filter((a) => a.cusip && a.date);
}

const FIELD = { bid_to_cover: "btc", indirect_share: "indirect", dealer_share: "dealer", yield_spread_bp: "spread_bp" };

// Mean of a field over each complete month's auctions; months with no auction are left out.
function monthlyMeans(auctions, field, since, now) {
  const months = new Set(completeMonths(since, now));
  const acc = new Map();
  for (const a of auctions) {
    const v = a[field];
    if (v === null || v === undefined) continue;
    const m = monthStart(a.date);
    if (!months.has(m)) continue;
    const t = acc.get(m) || { sum: 0, n: 0 };
    t.sum += v;
    t.n++;
    acc.set(m, t);
  }
  return [...acc.entries()].sort().map(([m, t]) => [m, Math.round((t.sum / t.n) * 10000) / 10000]);
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const days = Math.ceil((ctx.now.getTime() - Date.parse(`${since}T00:00:00Z`)) / 86400000) + 7;
    const auctions = [];
    let sha = null;
    for (const t of TYPES) {
      const r = await ctx.get(`treasury:${t}`, `${BASE}?format=json&type=${t}&days=${days}`, { headers: { Accept: "application/json" } });
      sha = r.sha256;
      auctions.push(...auctionsOf(parseJson(r.text, `treasurydirect ${t}`)));
    }
    const seen = new Set();
    const unique = auctions.filter((a) => (seen.has(`${a.cusip}:${a.date}`) ? false : seen.add(`${a.cusip}:${a.date}`)));
    for (const s of series) {
      const field = FIELD[s.params.feed];
      if (!field) throw new SchemaError(`treasury: unknown feed '${s.params.feed}'`);
      for (const [m, v] of monthlyMeans(unique, field, ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: v, source_url: CITE, raw_sha256: sha });
      }
    }
    // A weak auction (bid-to-cover under 2.2 or a high yield 10 bp or more over the median; 5-8 bp is usual) is an event.
    const eventSince = ctx.eventSince();
    for (const a of unique) {
      if (a.date < eventSince) continue;
      const weak = (a.btc !== null && a.btc < 2.2) || (a.spread_bp !== null && a.spread_bp >= 10);
      if (!weak) continue;
      out.events.push({
        external_id: `treasury:${a.cusip}:${a.date}`,
        entity_id: "us-federal",
        event_type: "weak_treasury_auction",
        event_time: a.date,
        title: `Weak ${a.term || ""} ${a.type || ""} auction: bid-to-cover ${a.btc ?? "n/a"}, high yield ${a.high ?? "n/a"}%${a.spread_bp !== null ? `, ${a.spread_bp} bp over median` : ""}`.replace(/\s+/g, " "),
        severity: a.btc !== null && a.btc < 2 ? "high" : "medium",
        detail: { cusip: a.cusip, term: a.term, bid_to_cover: a.btc, indirect_share: a.indirect, dealer_share: a.dealer, spread_bp: a.spread_bp, offering_amount: a.offering },
        source_url: CITE,
        raw_sha256: sha,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, auctionsOf, monthlyMeans };
