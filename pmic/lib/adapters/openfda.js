// openFDA drug endpoints, plus food enforcement reports. Count series use the `count=<date field>`
// aggregation (one request returns daily buckets for the whole window) and are summed into
// complete Monday-start weeks.
// Recalls and original NDA/BLA approvals also become events. FAERS lags: the FDA loads reports in
// batches, so the newest weeks read low or zero until they arrive. FAERS series therefore stop at
// the last complete week that has reports, and empty weeks are left out rather than stored as 0.
// openFDA answers 404
// {"error":{"code":"NOT_FOUND"}} when nothing matches; that is a valid zero, not a failure.
"use strict";

const { SchemaError, parseJson, ymd, compact, fromCompact, weeklyCounts } = require("./common");

const BASE = "https://api.fda.gov/drug";
const RECALL_SEVERITY = { "Class I": "high", "Class II": "medium", "Class III": "low" };

function q(s) {
  // openFDA wants spaces as '+', and quotes/brackets literal.
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/%22/g, '"').replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%3A/g, ":");
}

function addDays(isoDate, n) {
  return ymd(new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000));
}

function withKey(url, key) {
  return key ? `${url}&api_key=${encodeURIComponent(key)}` : url;
}

function range(field, since, now) {
  return `${field}:[${compact(since)} TO ${compact(ymd(now))}]`;
}

function bodyOrEmpty(r, what) {
  const body = parseJson(r.text, what);
  if (r.status === 404 && body.error && body.error.code === "NOT_FOUND") return { results: [] };
  if (body.error) throw new SchemaError(`${what}: ${body.error.code} ${body.error.message || ""}`);
  if (!Array.isArray(body.results)) throw new SchemaError(`${what}: no results array`);
  return body;
}

async function countSeries(ctx, s, endpoint, search, field, key, { lagged = false } = {}) {
  const since = ctx.since(s);
  // "food/enforcement" and other non-drug endpoints are given with their category.
  const cite = `${endpoint.includes("/") ? "https://api.fda.gov" : BASE}/${endpoint}.json?search=${q(search)}&count=${field}`;
  const r = await ctx.get(`openfda:${s.series_id}`, withKey(cite, key), {}, { allowStatus: [404] });
  const body = bodyOrEmpty(r, `openfda ${s.series_id}`);
  const daily = body.results.map((b) => [fromCompact(b.time), Number(b.count) || 0]).filter(([d]) => d);
  let weeks = weeklyCounts(daily, since, ctx.now);
  if (lagged) {
    const last = daily.filter(([, n]) => n > 0).map(([d]) => d).sort().pop();
    weeks = last ? weeks.filter(([w, n]) => n > 0 && addDays(w, 6) <= last) : [];
  }
  return weeks.map(([w, n]) => ({
    series_id: s.series_id,
    observation_time: w,
    period: `week of ${w}`,
    value: n,
    source_url: cite,
    raw_sha256: r.sha256,
  }));
}

function firmEntity(ctx, firm) {
  const f = String(firm || "").toLowerCase();
  for (const co of ctx.catalog.sec.companies) {
    if (!co.fda_firm) continue;
    if ([co.fda_firm, ...(co.fda_aliases || [])].some((n) => f.includes(n.toLowerCase()))) return co.ticker.toLowerCase();
  }
  return "us-drug-market";
}

async function recallEvents(ctx, key) {
  const since = ctx.eventSince();
  const events = [];
  for (let skip = 0; skip < 1000; skip += 100) {
    const cite = `${BASE}/enforcement.json?search=${q(range("report_date", since, ctx.now))}&sort=report_date:desc&limit=100&skip=${skip}`;
    const r = await ctx.get(`openfda:recall-events:${skip}`, withKey(cite, key), {}, { allowStatus: [404] });
    const body = bodyOrEmpty(r, "openfda recall events");
    for (const x of body.results) {
      if (!x.recall_number) continue;
      const date = fromCompact(x.report_date);
      events.push({
        external_id: `recall:${x.recall_number}`,
        entity_id: firmEntity(ctx, x.recalling_firm),
        event_type: "drug_recall",
        event_time: date,
        title: `${x.classification || "Unclassified"} recall by ${x.recalling_firm || "unknown firm"}: ${String(x.product_description || "").slice(0, 160)}`,
        severity: RECALL_SEVERITY[x.classification] || "medium",
        detail: {
          recall_number: x.recall_number,
          classification: x.classification || null,
          recalling_firm: x.recalling_firm || null,
          reason_for_recall: String(x.reason_for_recall || "").slice(0, 500),
          status: x.status || null,
          recall_initiation_date: fromCompact(x.recall_initiation_date),
          distribution_pattern: String(x.distribution_pattern || "").slice(0, 200),
        },
        source_url: `${BASE}/enforcement.json?search=recall_number:"${x.recall_number}"`,
        raw_sha256: r.sha256,
      });
    }
    if (body.results.length < 100) break;
  }
  return events;
}

// Original approvals: drugsfda returns whole applications; walk each application's submissions
// for ORIG + AP inside the window. NDA/BLA and ANDA (generic) are counted separately.
async function approvals(ctx, key, since) {
  const found = [];
  let sha = null;
  for (let skip = 0; skip < 25000; skip += 1000) {
    const search = `${range("submissions.submission_status_date", since, ctx.now)} AND submissions.submission_type:"ORIG" AND submissions.submission_status:"AP"`;
    const cite = `${BASE}/drugsfda.json?search=${q(search)}&limit=1000&skip=${skip}`;
    const r = await ctx.get(`openfda:approvals:${skip}`, withKey(cite, key), {}, { allowStatus: [404] });
    sha = r.sha256;
    const body = bodyOrEmpty(r, "openfda approvals");
    for (const app of body.results) {
      for (const sub of app.submissions || []) {
        const date = fromCompact(sub.submission_status_date);
        if (sub.submission_type !== "ORIG" || sub.submission_status !== "AP" || !date || date < since) continue;
        found.push({ app, sub, date });
      }
    }
    if (body.results.length < 1000) break;
  }
  return { found, sha };
}

async function collect(series, ctx) {
  const key = ctx.env.OPENFDA_API_KEY;
  const out = { observations: [], events: [] };
  const byFeed = new Map(series.map((s) => [s.params.feed, s]));
  const run = async (ids, fn) => {
    try {
      await fn();
    } catch (e) {
      ctx.fail(ids, e);
    }
  };

  const plain = {
    recalls: ["enforcement", (s) => range("report_date", ctx.since(s), ctx.now), "report_date"],
    recalls_class1: ["enforcement", (s) => `${range("report_date", ctx.since(s), ctx.now)} AND classification:"Class I"`, "report_date"],
    faers: ["event", (s) => range("receivedate", ctx.since(s), ctx.now), "receivedate"],
    labels: ["label", (s) => range("effective_time", ctx.since(s), ctx.now), "effective_time"],
    food_recalls: ["food/enforcement", (s) => range("report_date", ctx.since(s), ctx.now), "report_date"],
    food_recalls_class1: ["food/enforcement", (s) => `${range("report_date", ctx.since(s), ctx.now)} AND classification:"Class I"`, "report_date"],
  };
  for (const [feed, [endpoint, search, field]] of Object.entries(plain)) {
    const s = byFeed.get(feed);
    if (s) await run([s.series_id], async () => out.observations.push(...(await countSeries(ctx, s, endpoint, search(s), field, key, { lagged: feed === "faers" }))));
  }
  // A company's products can be listed under other names (J&J's drugs under Janssen), so match any.
  const anyOf = (field, s) => {
    const names = s.params.firms || [s.params.firm];
    return names.length === 1 ? `${field}:"${names[0]}"` : `(${names.map((n) => `${field}:"${n}"`).join(" OR ")})`;
  };
  const firm = {
    recalls_firm: (s) => ["enforcement", `${range("report_date", ctx.since(s), ctx.now)} AND ${anyOf("recalling_firm", s)}`, "report_date"],
    faers_firm: (s) => ["event", `${range("receivedate", ctx.since(s), ctx.now)} AND ${anyOf("patient.drug.openfda.manufacturer_name", s)}`, "receivedate"],
    labels_firm: (s) => ["label", `${range("effective_time", ctx.since(s), ctx.now)} AND ${anyOf("openfda.manufacturer_name", s)}`, "effective_time"],
  };
  for (const s of series.filter((x) => firm[x.params.feed])) {
    const [endpoint, search, field] = firm[s.params.feed](s);
    await run([s.series_id], async () => out.observations.push(...(await countSeries(ctx, s, endpoint, search, field, key, { lagged: s.params.feed === "faers_firm" }))));
  }

  const nda = byFeed.get("approvals_nda_bla");
  const anda = byFeed.get("approvals_anda");
  const firmApprovals = series.filter((x) => x.params.feed === "approvals_firm");
  if (nda || anda || firmApprovals.length) {
    const ids = [nda, anda, ...firmApprovals].filter(Boolean).map((s) => s.series_id);
    await run(ids, async () => {
      const since = [nda, anda, ...firmApprovals].filter(Boolean).map((s) => ctx.since(s)).sort()[0];
      const { found, sha } = await approvals(ctx, key, since);
      const cite = `${BASE}/drugsfda.json?search=${q(`submissions.submission_type:"ORIG" AND submissions.submission_status:"AP"`)}`;
      for (const [s, isGeneric] of [[nda, false], [anda, true]]) {
        if (!s) continue;
        const daily = found.filter((f) => /^ANDA/.test(f.app.application_number || "") === isGeneric).map((f) => [f.date, 1]);
        for (const [w, n] of weeklyCounts(daily, ctx.since(s), ctx.now)) {
          out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: sha });
        }
      }
      for (const s of firmApprovals) {
        const daily = found.filter((f) => firmEntity(ctx, f.app.sponsor_name) === s.entity_id).map((f) => [f.date, 1]);
        for (const [w, n] of weeklyCounts(daily, ctx.since(s), ctx.now)) {
          out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: sha });
        }
      }
      const eventSince = ctx.eventSince();
      for (const { app, sub, date } of found) {
        if (/^ANDA/.test(app.application_number || "") || date < eventSince) continue;
        const brand = (app.openfda && app.openfda.brand_name && app.openfda.brand_name[0]) || (app.products && app.products[0] && app.products[0].brand_name) || app.application_number;
        out.events.push({
          external_id: `approval:${app.application_number}:${sub.submission_number || "1"}`,
          entity_id: firmEntity(ctx, app.sponsor_name),
          event_type: "drug_approval",
          event_time: date,
          title: `Original approval of ${brand} (${app.application_number}) for ${app.sponsor_name || "unknown sponsor"}`,
          severity: "medium",
          detail: { application_number: app.application_number, sponsor_name: app.sponsor_name || null, brand_name: brand, review_priority: sub.review_priority || null, submission_class: sub.submission_class_code_description || null },
          source_url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${String(app.application_number).replace(/\D/g, "")}`,
          raw_sha256: sha,
        });
      }
    });
  }

  const shortFeeds = ["shortages_new", "shortages_discontinued", "shortages_resolved"].map((f) => byFeed.get(f)).filter(Boolean);
  if (shortFeeds.length) {
    const ids = shortFeeds.map((s) => s.series_id);
    await run(ids, async () => {
      const { rows, sha } = await shortages(ctx, key);
      const cite = "https://www.accessdata.fda.gov/scripts/drugshortages/default.cfm";
      // New shortages: by first posting date (all statuses but discontinuations). Discontinuations:
      // status "To Be Discontinued", by first posting. Resolved: by last update (the FDA keeps few).
      const pick = {
        shortages_new: (x) => (x.status !== "To Be Discontinued" ? x.posted : null),
        shortages_discontinued: (x) => (x.status === "To Be Discontinued" ? x.posted : null),
        shortages_resolved: (x) => (x.status === "Resolved" ? x.updated : null),
      };
      for (const s of shortFeeds) {
        const daily = rows.map(pick[s.params.feed]).filter(Boolean).map((d) => [d, 1]);
        for (const [w, n] of weeklyCounts(daily, ctx.since(s), ctx.now)) {
          out.observations.push({ series_id: s.series_id, observation_time: w, period: `week of ${w}`, value: n, source_url: cite, raw_sha256: sha });
        }
      }
      const eventSince = ctx.eventSince();
      const seen = new Set();
      for (const x of rows) {
        if (!x.posted || x.posted < eventSince || x.status === "Resolved") continue;
        const key2 = `${x.generic}|${x.company}`;
        if (seen.has(key2)) continue; // one event per drug and company, not per package
        seen.add(key2);
        out.events.push({
          external_id: `shortage:${x.posted}:${key2}`.slice(0, 200),
          entity_id: firmEntity(ctx, x.company),
          event_type: "drug_shortage",
          event_time: x.posted,
          title: `Drug shortage posted: ${x.generic || "unknown drug"} (${x.company || "unknown company"})${x.availability ? `, ${x.availability}` : ""}`.slice(0, 300),
          severity: /unavailable/i.test(x.availability || "") ? "high" : "medium",
          detail: { generic_name: x.generic, company_name: x.company, availability: x.availability, therapeutic_category: x.category, shortage_reason: x.reason },
          source_url: cite,
          raw_sha256: sha,
        });
      }
    });
  }

  if (byFeed.get("recalls") || series.some((s) => s.params.feed === "recalls_firm")) {
    await run([], async () => out.events.push(...(await recallEvents(ctx, key))));
  }
  return out;
}

// openFDA drug shortages: every record (about 1,600), paged 1,000 at a time. Dates are MM/DD/YYYY.
function usDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

async function shortages(ctx, key) {
  const rows = [];
  let sha = null;
  for (let skip = 0; skip < 25000; skip += 1000) {
    const r = await ctx.get(`openfda:shortages:${skip}`, withKey(`${BASE}/shortages.json?limit=1000&skip=${skip}`, key), {}, { allowStatus: [404] });
    sha = r.sha256;
    const body = bodyOrEmpty(r, "openfda shortages");
    for (const x of body.results) {
      rows.push({
        status: x.status || null,
        posted: usDate(x.initial_posting_date),
        updated: usDate(x.update_date),
        company: x.company_name || null,
        generic: x.generic_name || null,
        availability: x.availability || null,
        category: Array.isArray(x.therapeutic_category) ? x.therapeutic_category.join(", ") : x.therapeutic_category || null,
        reason: x.shortage_reason || null,
      });
    }
    if (body.results.length < 1000) break;
  }
  return { rows, sha };
}

module.exports = { collect, q, firmEntity, usDate };
