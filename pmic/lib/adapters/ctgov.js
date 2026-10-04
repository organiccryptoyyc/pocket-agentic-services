// ClinicalTrials.gov API v2. Per company, every study whose lead sponsor matches one of its
// ctgov_sponsors names (query.lead), paged 1,000 at a time with only the status fields. From that
// one list: trials started and completed per month (ACTUAL dates only), trials now terminated,
// withdrawn or suspended by the month of their last update, and today's count of active trials.
"use strict";

const { SchemaError, parseJson, ymd, monthlyCounts } = require("./common");

const BASE = "https://clinicaltrials.gov/api/v2/studies";
const FIELDS = "NCTId,BriefTitle,OverallStatus,StartDate,CompletionDate,LastUpdatePostDate,Phase";
const ACTIVE = new Set(["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION"]);
const STOPPED = new Set(["TERMINATED", "WITHDRAWN", "SUSPENDED"]);
const MAX_PAGES = 30;

// "2025-03" or "2025-03-14" -> "2025-03-01" / "2025-03-14"
function dateOf(struct) {
  const d = struct && struct.date ? String(struct.date) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
  return null;
}

function studyOf(x) {
  const p = (x && x.protocolSection) || {};
  const st = p.statusModule || {};
  return {
    nct: p.identificationModule ? p.identificationModule.nctId : null,
    title: p.identificationModule ? p.identificationModule.briefTitle : null,
    status: st.overallStatus || null,
    start: st.startDateStruct && st.startDateStruct.type === "ACTUAL" ? dateOf(st.startDateStruct) : null,
    completion: st.completionDateStruct && st.completionDateStruct.type === "ACTUAL" ? dateOf(st.completionDateStruct) : null,
    updated: dateOf(st.lastUpdatePostDateStruct),
    phases: (p.designModule && p.designModule.phases) || [],
  };
}

async function studiesFor(ctx, sponsor, ticker) {
  const studies = [];
  let token = null;
  let sha = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE}?query.lead=${encodeURIComponent(sponsor)}&fields=${FIELDS}&pageSize=1000&format=json${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const r = await ctx.get(`ctgov:${ticker}:${sponsor}:p${page}`, url, { headers: { Accept: "application/json" } });
    const body = parseJson(r.text, `ctgov ${sponsor}`);
    if (!Array.isArray(body.studies)) throw new SchemaError(`ctgov ${sponsor}: no studies array`);
    studies.push(...body.studies.map(studyOf));
    sha = r.sha256;
    token = body.nextPageToken || null;
    if (!token) break;
  }
  return { studies, sha };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const byEntity = new Map();
  for (const s of series) {
    if (!byEntity.has(s.entity_id)) byEntity.set(s.entity_id, []);
    byEntity.get(s.entity_id).push(s);
  }
  for (const [entity_id, group] of byEntity) {
    const ticker = entity_id.toUpperCase();
    try {
      const seen = new Map();
      let sha = null;
      for (const sponsor of group[0].params.sponsors) {
        const r = await studiesFor(ctx, sponsor, ticker);
        sha = r.sha;
        for (const st of r.studies) if (st.nct) seen.set(st.nct, st);
      }
      const studies = [...seen.values()];
      const cite = `https://clinicaltrials.gov/search?lead=${encodeURIComponent(group[0].params.sponsors[0])}`;
      for (const s of group) {
        const since = ctx.since(s);
        if (s.metric_name === "active_trials") {
          out.observations.push({ series_id: s.series_id, observation_time: ymd(ctx.now), period: ymd(ctx.now), value: studies.filter((x) => ACTIVE.has(x.status)).length, source_url: cite, raw_sha256: sha });
          continue;
        }
        const pick = {
          trial_starts_monthly: (x) => x.start,
          trial_completions_monthly: (x) => x.completion,
          trial_stops_monthly: (x) => (STOPPED.has(x.status) ? x.updated : null),
        }[s.metric_name];
        if (!pick) continue;
        const dated = studies.map(pick).filter(Boolean).map((d) => [d, 1]);
        for (const [m, n] of monthlyCounts(dated, since, ctx.now)) {
          out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: cite, raw_sha256: sha });
        }
      }
      const eventSince = ctx.eventSince();
      for (const st of studies) {
        if (!STOPPED.has(st.status) || !st.updated || st.updated < eventSince) continue;
        const late = st.phases.some((p) => p === "PHASE3" || p === "PHASE4");
        out.events.push({
          external_id: `trial-stop:${st.nct}:${st.status}`,
          entity_id,
          event_type: "trial_stopped",
          event_time: st.updated,
          title: `${st.status.toLowerCase()} trial ${st.nct}: ${String(st.title || "").slice(0, 160)}`,
          severity: late ? "medium" : "low",
          detail: { nct_id: st.nct, status: st.status, phases: st.phases },
          source_url: `https://clinicaltrials.gov/study/${st.nct}`,
          raw_sha256: sha,
        });
      }
    } catch (e) {
      ctx.fail(group.map((s) => s.series_id), e);
    }
  }
  return out;
}

module.exports = { collect, studyOf, dateOf };
