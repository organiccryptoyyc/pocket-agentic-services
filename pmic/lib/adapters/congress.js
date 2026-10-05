// Congress.gov API (Library of Congress), api.data.gov key in CONGRESS_API_KEY (or FEC_API_KEY;
// the same api.data.gov key works for both). Monthly counts of House and Senate bills introduced
// (H.R. and S., not resolutions) and of public laws enacted, over the current and previous
// Congress. New public laws become events. DEMO_KEY allows only 10 requests an hour, so without
// a key only the short law lists are read and the bill count is skipped.
"use strict";

const { SchemaError, parseJson, monthlyCounts } = require("./common");

const API = "https://api.congress.gov/v3";
const CITE = "https://www.congress.gov/";

// The Congress in session on a date: the 1st began in 1789, a new one every odd year on January 3.
function congressOf(date) {
  const y = Number(date.slice(0, 4)) - (date.slice(5) < "01-03" ? 1 : 0);
  return Math.floor((y - 1789) / 2) + 1;
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const SLUG = { HR: "house-bill", S: "senate-bill", HJRES: "house-joint-resolution", SJRES: "senate-joint-resolution" };

async function pages(ctx, jobKey, path, key, listKey) {
  const items = [];
  let sha = null;
  for (let offset = 0; offset < 40000; offset += 250) {
    const r = await ctx.get(`${jobKey}:${offset}`, `${API}${path}?format=json&limit=250&offset=${offset}&api_key=${encodeURIComponent(key)}`);
    sha = sha || r.sha256;
    const body = parseJson(r.text, `congress ${path}`);
    const list = body[listKey];
    if (!Array.isArray(list)) throw new SchemaError(`congress ${path}: no ${listKey} array`);
    items.push(...list);
    if (list.length < 250) break;
  }
  return { items, sha };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const key = ctx.env.CONGRESS_API_KEY || ctx.env.FEC_API_KEY || null;
  const since = series.map((s) => ctx.since(s)).sort()[0];
  const first = congressOf(since);
  const last = congressOf(ctx.now.toISOString().slice(0, 10));
  const congresses = [];
  for (let c = first; c <= last; c++) congresses.push(c);
  for (const s of series) {
    try {
      if (s.params.feed === "bills") {
        if (!key) { ctx.missingKey("congress", "CONGRESS_API_KEY", [s.series_id]); continue; }
        const dates = [];
        let sha = null;
        for (const c of congresses) {
          for (const type of ["hr", "s"]) {
            const p = await pages(ctx, `congress:${c}:${type}`, `/bill/${c}/${type}`, key, "bills");
            sha = sha || p.sha;
            for (const b of p.items) if (b.introducedDate) dates.push([b.introducedDate, 1]);
          }
        }
        for (const [m, n] of monthlyCounts(dates, ctx.since(s), ctx.now)) out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: CITE, raw_sha256: sha });
      } else if (s.params.feed === "laws") {
        const laws = [];
        let sha = null;
        for (const c of congresses) {
          const p = await pages(ctx, `congress:${c}:laws`, `/law/${c}`, key || "DEMO_KEY", "bills");
          sha = sha || p.sha;
          for (const b of p.items) {
            const a = b.latestAction || {};
            const law = (b.laws || []).find((l) => /public/i.test(l.type || ""));
            if (!law || !a.actionDate || !/Became Public Law/i.test(a.text || "")) continue;
            laws.push({ date: a.actionDate, number: law.number, title: b.title, type: b.type, bill: b.number, congress: b.congress || c });
          }
        }
        for (const [m, n] of monthlyCounts(laws.map((l) => [l.date, 1]), ctx.since(s), ctx.now)) out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: CITE, raw_sha256: sha });
        const evSince = ctx.eventSince();
        for (const l of laws) {
          if (l.date < evSince) continue;
          out.events.push({
            external_id: `plaw:${l.number}`,
            entity_id: "us-congress",
            event_type: "public_law",
            event_time: l.date,
            title: `Public Law ${l.number}: ${String(l.title || "").slice(0, 240)}`.slice(0, 300),
            severity: "medium",
            detail: { law: l.number, bill: `${l.type} ${l.bill}`, congress: l.congress },
            source_url: SLUG[l.type] ? `https://www.congress.gov/bill/${ordinal(l.congress)}-congress/${SLUG[l.type]}/${l.bill}` : CITE,
            raw_sha256: sha,
          });
        }
      } else {
        throw new SchemaError(`congress: unknown feed '${s.params.feed}'`);
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, congressOf };
