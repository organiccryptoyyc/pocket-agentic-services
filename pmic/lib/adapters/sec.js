// SEC EDGAR. Per company, two requests: XBRL company facts (financial metrics) and
// submissions (filing events + weekly Form 4 counts). Needs PMIC_SEC_USER_AGENT
// ("Name contact@example.com") per SEC fair access; requests are spaced 150 ms apart in lib/net.js.
//
// Metric values come only from facts that carry an XBRL `frame` (CY2025Q2, CY2025, CY2025Q2I):
// SEC assigns a frame to the one fact that best represents that calendar period across all
// filings, which deduplicates restatements and repeated comparatives for us. Each value cites
// the filing (accession) it came from.
"use strict";

const { SchemaError, parseJson, weekStart, completeWeeks } = require("./common");

const Q_FRAME = /^CY(\d{4})Q([1-4])$/;
const FY_FRAME = /^CY(\d{4})$/;
const I_FRAME = /^CY(\d{4})Q([1-4])I$/;

function cikInt(cik) {
  return String(Number(cik));
}

function filingUrl(cik, accn, doc) {
  return `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${String(accn).replace(/-/g, "")}/${doc || ""}`;
}

// For one metric, merge its fallback concepts: per frame, the first concept (in priority order)
// that has a fact for that frame wins.
function framed(facts, concepts, frameRe) {
  const gaap = (facts && facts.facts && facts.facts["us-gaap"]) || {};
  const byFrame = new Map();
  for (const c of concepts) {
    const units = gaap[c] && gaap[c].units;
    const rows = units && (units.USD || units["USD/shares"] || units.shares);
    if (!Array.isArray(rows)) continue;
    for (const f of rows) {
      if (!f.frame || !frameRe.test(f.frame) || byFrame.has(f.frame) || typeof f.val !== "number") continue;
      byFrame.set(f.frame, { frame: f.frame, end: f.end, val: f.val, accn: f.accn, form: f.form, filed: f.filed, concept: c });
    }
  }
  return byFrame;
}

function eventFor(cfg, cik, entity_id, f) {
  const form = f.form;
  let type = null;
  let severity = "low";
  if (form === "10-K") type = "filing_10k";
  else if (form === "10-Q") type = "filing_10q";
  else if (form === "8-K") {
    type = "filing_8k";
    const items = String(f.items || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (items.some((i) => cfg.high_severity_8k_items.includes(i))) severity = "high";
    else if (items.some((i) => cfg.medium_severity_8k_items.includes(i))) severity = "medium";
  } else if (form === "4") type = "insider_form4";
  else if (/13D/.test(form)) { type = "ownership_13d"; severity = "medium"; }
  else if (/13G/.test(form)) type = "ownership_13g";
  if (!type) return null;
  return {
    external_id: f.accn,
    entity_id,
    event_type: type,
    event_time: f.filingDate,
    title: `${form}${f.items ? ` (items ${f.items})` : ""} filed ${f.filingDate}${f.reportDate ? ` for period ${f.reportDate}` : ""}`,
    severity,
    detail: { form, items: f.items || null, report_date: f.reportDate || null, primary_document: f.primaryDocument || null, cik },
    source_url: filingUrl(cik, f.accn, f.primaryDocument),
  };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const ua = ctx.env.PMIC_SEC_USER_AGENT;
  if (!ua) {
    ctx.missingKey("sec", "PMIC_SEC_USER_AGENT", series.map((s) => s.series_id));
    return out;
  }
  const cfg = ctx.catalog.sec;
  const headers = { "User-Agent": ua, Accept: "application/json" };
  const byCik = new Map();
  for (const s of series) {
    if (!byCik.has(s.params.cik)) byCik.set(s.params.cik, []);
    byCik.get(s.params.cik).push(s);
  }

  for (const [cik, group] of byCik) {
    const ticker = group[0].params.ticker;
    const entity_id = group[0].entity_id;
    const want = new Map(group.map((s) => [s.metric_name, s]));
    const factSeries = group.filter((s) => s.metric_name !== "insider_form4_weekly");

    if (factSeries.length) {
      try {
        const r = await ctx.get(`sec:facts:${ticker}`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers });
        const facts = parseJson(r.text, `sec facts ${ticker}`);
        if (!facts.facts || typeof facts.facts !== "object") throw new SchemaError(`sec facts ${ticker}: no facts object`);
        const values = new Map(); // metric_name -> Map(frame -> fact)
        for (const m of cfg.metrics) {
          if (m.kind === "duration") {
            values.set(`${m.metric_name}_q`, framed(facts, m.concepts, Q_FRAME));
            values.set(`${m.metric_name}_fy`, framed(facts, m.concepts, FY_FRAME));
          } else {
            values.set(m.metric_name, framed(facts, m.concepts, I_FRAME));
          }
        }
        for (const ratio of cfg.ratios) {
          const instant = cfg.metrics.find((m) => m.metric_name === ratio.numerator).kind === "instant";
          const num = values.get(instant ? ratio.numerator : `${ratio.numerator}_q`);
          const den = values.get(instant ? ratio.denominator : `${ratio.denominator}_q`);
          const map = new Map();
          for (const [frame, n] of num) {
            const d = den.get(frame);
            if (!d || !(d.val > 0)) continue;
            map.set(frame, { frame, end: n.end, val: n.val / d.val, accn: n.accn, form: n.form, filed: n.filed, concept: `${n.concept}/${d.concept}` });
          }
          values.set(ratio.metric_name, map);
        }
        for (const s of factSeries) {
          const map = values.get(s.metric_name);
          if (!map) continue;
          const since = ctx.since(s);
          if (!map.size) {
            ctx.fail([s.series_id], new SchemaError(`sec ${ticker}: no framed facts for ${s.metric_name} (concept not reported)`), { kind: "empty_response" });
            continue;
          }
          for (const f of map.values()) {
            if (!f.end || f.end < since) continue;
            out.observations.push({
              series_id: s.series_id,
              observation_time: f.end,
              period: f.frame,
              value: f.val,
              source_url: filingUrl(cik, f.accn, ""),
              raw_sha256: r.sha256,
              detail: { concept: f.concept, form: f.form, filed: f.filed, accn: f.accn },
            });
          }
        }
      } catch (e) {
        ctx.fail(factSeries.map((s) => s.series_id), e);
      }
    }

    try {
      const r = await ctx.get(`sec:submissions:${ticker}`, `https://data.sec.gov/submissions/CIK${cik}.json`, { headers });
      const body = parseJson(r.text, `sec submissions ${ticker}`);
      const recent = body.filings && body.filings.recent;
      if (!recent || !Array.isArray(recent.accessionNumber)) throw new SchemaError(`sec submissions ${ticker}: no filings.recent`);
      const filings = recent.accessionNumber.map((accn, i) => ({
        accn,
        form: recent.form[i],
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate ? recent.reportDate[i] : null,
        items: recent.items ? recent.items[i] : null,
        primaryDocument: recent.primaryDocument ? recent.primaryDocument[i] : null,
      }));
      const eventSince = ctx.eventSince();
      for (const f of filings) {
        if (!cfg.event_forms.includes(f.form) || !f.filingDate || f.filingDate < eventSince) continue;
        const ev = eventFor(cfg, cik, entity_id, f);
        if (ev) out.events.push({ ...ev, raw_sha256: r.sha256 });
      }
      const s4 = want.get("insider_form4_weekly");
      if (s4) {
        // filings.recent holds about the last 1,000 filings; weeks older than that window are unknown, not zero.
        const oldest = filings.map((f) => f.filingDate).filter(Boolean).sort()[0] || ctx.since(s4);
        const coveredSince = filings.length >= 1000 ? oldest : ctx.since(s4);
        const from = coveredSince > ctx.since(s4) ? coveredSince : ctx.since(s4);
        const counts = new Map(completeWeeks(from, ctx.now).map((w) => [w, 0]));
        for (const f of filings) {
          if (f.form !== "4" || !f.filingDate) continue;
          const w = weekStart(f.filingDate);
          if (counts.has(w)) counts.set(w, counts.get(w) + 1);
        }
        for (const [w, n] of counts) {
          out.observations.push({
            series_id: s4.series_id,
            observation_time: w,
            period: `week of ${w}`,
            value: n,
            source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=40`,
            raw_sha256: r.sha256,
          });
        }
      }
    } catch (e) {
      ctx.fail(group.filter((s) => s.metric_name === "insider_form4_weekly").map((s) => s.series_id), e, { source_level: true });
    }
  }
  return out;
}

module.exports = { collect, framed, eventFor, filingUrl };
