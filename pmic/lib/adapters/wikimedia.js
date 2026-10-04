// Wikimedia REST API: daily pageviews (human users, all platforms) and daily edits of each
// company's English Wikipedia article, summed into complete Monday-start weeks. Wikimedia asks
// every client to send a User-Agent with contact details; PMIC_CONTACT (or the SEC User-Agent)
// supplies it. Edit counts come from Wikimedia's monthly history dumps, so they stop at the end of
// the last month loaded (about a month behind); weeks after that are left out, not counted as 0.
"use strict";

const { SchemaError, parseJson, compact, ymd, weeklyCounts, addMonths } = require("./common");

const BASE = "https://wikimedia.org/api/rest_v1/metrics";
const DEFAULT_UA = "PMIC-collector/1.0 (https://github.com/organiccryptoyyc/pocket-agentic-services)";

function title(article) {
  return encodeURIComponent(article).replace(/%2F/g, "/");
}

function pageviewPairs(body) {
  if (!body || !Array.isArray(body.items)) throw new SchemaError("wikimedia pageviews: no items array");
  return body.items.map((x) => [`${String(x.timestamp).slice(0, 4)}-${String(x.timestamp).slice(4, 6)}-${String(x.timestamp).slice(6, 8)}`, Number(x.views) || 0]);
}

function editPairs(body) {
  if (!body || !Array.isArray(body.items)) throw new SchemaError("wikimedia edits: no items array");
  const results = body.items.flatMap((x) => x.results || []);
  return results.map((r) => [String(r.timestamp).slice(0, 10), Number(r.edits) || 0]);
}

// Last day of the latest month the edits dataset has loaded, from the all-wiki monthly aggregate
// (never empty for English Wikipedia). If that call fails: the end of the month before last.
async function editsHorizon(ctx, headers) {
  const now = ymd(ctx.now);
  const fallback = ymd(new Date(Date.parse(`${addMonths(`${now.slice(0, 7)}-01`, -1)}T00:00:00Z`) - 86400000));
  try {
    const from = `${addMonths(`${now.slice(0, 7)}-01`, -6)}`;
    const url = `${BASE}/edits/aggregate/en.wikipedia.org/all-editor-types/all-page-types/monthly/${compact(from)}/${compact(now)}`;
    const r = await ctx.get("wikimedia:edits:horizon", url, { headers }, { allowStatus: [404] });
    const body = r.status === 404 ? null : parseJson(r.text, "wikimedia edits aggregate");
    const months = body ? editPairs(body).filter(([, n]) => n > 0).map(([d]) => d.slice(0, 7)).sort() : [];
    if (!months.length) return fallback;
    const last = months[months.length - 1];
    return ymd(new Date(Date.parse(`${addMonths(`${last}-01`, 1)}T00:00:00Z`) - 86400000));
  } catch {
    return fallback;
  }
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const contact = ctx.env.PMIC_CONTACT || ctx.env.PMIC_SEC_USER_AGENT;
  const headers = { "User-Agent": contact ? `PMIC-collector/1.0 (${contact})` : DEFAULT_UA, Accept: "application/json" };
  const end = ymd(new Date(ctx.now.getTime() - 86400000));
  const horizon = series.some((s) => s.params.feed === "edits") ? await editsHorizon(ctx, headers) : null;
  for (const s of series) {
    const since = ctx.since(s);
    const a = title(s.params.article);
    try {
      let url;
      let cite;
      if (s.params.feed === "pageviews") {
        url = `${BASE}/pageviews/per-article/en.wikipedia/all-access/user/${a}/daily/${compact(since)}00/${compact(end)}00`;
        cite = `https://pageviews.wmcloud.org/?project=en.wikipedia.org&platform=all-access&agent=user&pages=${a}`;
      } else {
        url = `${BASE}/edits/per-page/en.wikipedia.org/${a}/all-editor-types/daily/${compact(since)}/${compact(end)}`;
        cite = `https://en.wikipedia.org/w/index.php?title=${a}&action=history`;
      }
      // 404 on pageviews: no views recorded (or the article was renamed); a rename is an alert.
      const edits = s.params.feed !== "pageviews";
      if (edits) url = url.replace(/\/[0-9]{8}$/, `/${compact(horizon < end ? horizon : end)}`);
      // 404 on edits: no edits in the window, which is a real zero up to the horizon.
      const r = await ctx.get(`wikimedia:${s.series_id}`, url, { headers }, { allowStatus: edits ? [404] : [] });
      const body = r.status === 404 ? { items: [] } : parseJson(r.text, `wikimedia ${s.series_id}`);
      const daily = edits ? editPairs(body) : pageviewPairs(body);
      for (const [w, n] of weeklyCounts(daily, since, ctx.now)) {
        if (edits && ymd(new Date(Date.parse(`${w}T00:00:00Z`) + 6 * 86400000)) > horizon) continue;
        out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: r.sha256 });
      }
    } catch (e) {
      ctx.fail([s.series_id], e);
    }
  }
  return out;
}

module.exports = { collect, pageviewPairs, editPairs, title };
