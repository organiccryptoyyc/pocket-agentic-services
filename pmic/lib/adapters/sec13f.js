// SEC Form 13F data sets (public domain; SEC fair access needs PMIC_SEC_USER_AGENT). Each filing
// window (about three months, an 85 MB zip) is downloaded once: SUBMISSION.tsv gives each 13F-HR
// filing's report period, and INFOTABLE.tsv (about 350 MB) is streamed for the configured
// CUSIPs. A window is credited to the report quarter most of its filings cover (the quarter whose
// filing deadline falls in it); late filers for other quarters are left out. Per company and
// quarter: the number of filers holding common shares (puts and calls left out) and the dollar
// value they report. Windows already read are not downloaded again. Only the dated windows
// (2024 onward, the current file layout) are read: 11 windows, about 950 MB, on the first run.
"use strict";

const { SchemaError } = require("./common");
const { unzip } = require("../xlsx");

const LISTING = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

// 30-JUN-2026 -> 2026-06-30
function secDate(s) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(String(s || "").trim().toUpperCase());
  return m && MONTHS[m[2]] ? `${m[3]}-${MONTHS[m[2]]}-${m[1]}` : null;
}

// Window zips listed on the data set page, with the window's last day (2024 onward use dated names).
function windowsOf(html) {
  const out = [];
  for (const m of html.matchAll(/href="([^"]*\/(\d{2})([a-z]{3})(\d{4})-(\d{2})([a-z]{3})(\d{4})_form13f\.zip)"/gi)) {
    const end = `${m[7]}-${MONTHS[m[6].toUpperCase()]}-${m[5]}`;
    out.push({ url: new URL(m[1], "https://www.sec.gov").toString(), name: m[1].split("/").pop(), end });
  }
  return out;
}

const quarterStartOf = (periodEnd) => `${periodEnd.slice(0, 4)}-${String(Number(periodEnd.slice(5, 7)) - 2).padStart(2, "0")}-01`;

async function windowTotals(text, cusips) {
  const z = unzip(Buffer.from(text, "base64"));
  const sub = z.names.find((n) => /SUBMISSION\.tsv$/i.test(n));
  const info = z.names.find((n) => /INFOTABLE\.tsv$/i.test(n));
  if (!sub || !info) throw new SchemaError("sec13f: zip has no SUBMISSION.tsv or INFOTABLE.tsv");
  // accession -> report period, 13F-HR holdings reports only (not notices or amendments)
  const period = new Map();
  const perCount = new Map();
  let head = null;
  await z.eachLine(sub, (line) => {
    const c = line.split("\t");
    if (!head) { head = Object.fromEntries(c.map((h, i) => [h.trim(), i])); return; }
    if (c[head.SUBMISSIONTYPE] !== "13F-HR") return;
    const p = secDate(c[head.PERIODOFREPORT]);
    if (!p) return;
    period.set(c[head.ACCESSION_NUMBER], p);
    perCount.set(p, (perCount.get(p) || 0) + 1);
  });
  if (!perCount.size) throw new SchemaError("sec13f: no 13F-HR filings in SUBMISSION.tsv");
  const main = [...perCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const want = new Set(cusips);
  const holders = new Map(cusips.map((c) => [c, new Set()]));
  const value = new Map(cusips.map((c) => [c, 0]));
  head = null;
  await z.eachLine(info, (line) => {
    const c = line.split("\t");
    if (!head) {
      head = Object.fromEntries(c.map((h, i) => [h.trim(), i]));
      for (const k of ["ACCESSION_NUMBER", "CUSIP", "VALUE", "SSHPRNAMTTYPE", "PUTCALL"]) if (head[k] === undefined) throw new SchemaError(`sec13f: INFOTABLE has no ${k}`);
      return;
    }
    const cusip = (c[head.CUSIP] || "").toUpperCase();
    if (!want.has(cusip) || c[head.SSHPRNAMTTYPE] !== "SH" || c[head.PUTCALL]) return;
    const acc = c[head.ACCESSION_NUMBER];
    if (period.get(acc) !== main) return;
    holders.get(cusip).add(acc);
    value.set(cusip, value.get(cusip) + (Number(c[head.VALUE]) || 0));
  });
  return { quarter: quarterStartOf(main), period_end: main, filers: perCount.get(main), holders: Object.fromEntries([...holders].map(([k, v]) => [k, v.size])), value: Object.fromEntries(value) };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const ua = ctx.env.PMIC_SEC_USER_AGENT;
  if (!ua) {
    ctx.missingKey("sec13f", "PMIC_SEC_USER_AGENT", series.map((s) => s.series_id));
    return out;
  }
  try {
    const since = series.map((s) => ctx.since(s)).sort()[0];
    const page = await ctx.get("sec13f:listing", LISTING, { headers: { "User-Agent": ua } });
    const windows = windowsOf(page.text).filter((w) => w.end >= since);
    if (!windows.length) throw new SchemaError("sec13f: no dated 13F data set links on the listing page");
    const cusips = [...new Set(series.map((s) => s.params.cusip.toUpperCase()))];
    const done = ctx.kvGet("windows") || {};
    for (const w of windows) {
      if (done[w.name] && cusips.every((c) => c in done[w.name].holders)) continue;
      const r = await ctx.get(`sec13f:${w.name}`, w.url, { headers: { "User-Agent": ua }, binary: true, bulk: true });
      done[w.name] = { ...(await windowTotals(r.text, cusips)), sha256: r.sha256 };
      ctx.kvSet("windows", done);
    }
    for (const s of series) {
      const cusip = s.params.cusip.toUpperCase();
      for (const t of Object.values(done)) {
        if (t.quarter < ctx.since(s) || !(cusip in t.holders)) continue;
        const v = s.params.feed === "holders" ? t.holders[cusip] : Math.round(t.value[cusip]);
        out.observations.push({ series_id: s.series_id, observation_time: t.quarter, period: `quarter ending ${t.period_end}`, value: v, source_url: LISTING, raw_sha256: t.sha256 });
      }
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, windowsOf, windowTotals, secDate };
