// Verified layer, Phase 3 cross-checks from official bulk files (owner approval 2026-10-19: C1, C2, P2).
// Each check compares series we already serve with a second product of the same publisher, so all
// three are republication checks: they confirm our extraction, period mapping and counting, not
// the publisher's figures. Rows go to the confirmations table like every other check in lib/verify.js.
//
//   sec-insider-datasets  (C1) SEC's quarterly Insider Transactions Data Sets (Forms 3/4/5, as filed):
//            per company and week, the number of Form 4 filings and the open-market purchase and sale
//            values (non-derivative P and S, shares x price), against our weekly insider series. Only
//            weeks wholly inside the data set's quarter. Agree when every week matches (counts exactly,
//            values within 0.5% or $1); partial when at least 90% of weeks match; else disagree.
//   sec-fsds  (C2) SEC's Financial Statement Data Sets (num.txt from each 10-Q/10-K as filed): each
//            filing's own-period value of the tag our metric uses (same tag order as lib/adapters/sec.js,
//            USD, no segment, no co-registrant; quarter, fiscal year or instant), against our value
//            for that period. Prior-period comparatives are not compared (a later filing may restate
//            them under another tag). Agree within $1 or 0.01%; partial within 1%; else disagree.
//   drugsfda  (P2) FDA's Drugs@FDA data file: original approvals (ORIG + AP) per week, ANDA and
//            NDA/BLA, against our openFDA weekly approval counts, for the last 4 complete weeks that
//            ended at least 7 days ago (FDA fills the current week in over several days).
//
//   openfda-label  (P3) our label-update series (DailyMed published versions, owner option L1) against
//            openFDA's label index counted by effective date, for the 4 complete weeks that ended at least
//            6 weeks ago (openFDA indexes labels about 5-6 weeks late). Company series match openFDA's
//            manufacturer names (params.firms). Different pipelines and dates, so the rule is on 4-week
//            totals: agree within 15% (or 3 labels), partial within 30% (or 6), else disagree.
//
//   faers  (P4) FDA's FAERS quarterly ASCII files (DEMO, one row per case, its latest version that quarter):
//            cases per week of initial FDA receipt (init_fda_dt), against our openFDA weekly FAERS count
//            (openFDA's receivedate is the date the first version was received). Market series only: the
//            company series use openFDA's harmonized manufacturer names, which FAERS does not carry. Only
//            weeks wholly inside the file's quarter. Agree when every week is within 0.5%, partial within
//            2%, else disagree. Newest file first, then the previous three quarters, one file per pass.
//
//   aact  (P5) CTTI's AACT copy of ClinicalTrials.gov (PostgreSQL, read-only account in AACT_USER /
//            AACT_PASSWORD), queried once a day: per company, lead-sponsor studies matching the same
//            ctgov_sponsors names, counted like lib/adapters/ctgov.js (ACTUAL starts and completions by
//            month, terminated/withdrawn/suspended by last-update month, today's active count), for the
//            last 6 complete months. Agree when every value matches; partial when the totals are within
//            10% (or 2 trials); else disagree. AACT's database certificate expired on 2025-11-20: the
//            owner accepted that one fault (option A, 2026-10-20; see lib/pg.js), and each row records it.
//
// Bulk files are fetched once each (SEC zips once per new quarter, Drugs@FDA once a day) and dropped
// after reading; only the comparison rows are kept. SEC requests carry PMIC_SEC_USER_AGENT.
"use strict";

const { unzip } = require("./xlsx");
const { kvGet, kvSet } = require("./db");
const pg = require("./pg");

const DAY = 86400000;
const BULK_TIMEOUT_MS = 10 * 60 * 1000;
const SEC = "https://www.sec.gov";
const INSIDER_LISTING = `${SEC}/data-research/sec-markets-data/insider-transactions-data-sets`;
const FSDS_LISTING = `${SEC}/data-research/sec-markets-data/financial-statement-data-sets`;
const DRUGSFDA_ZIP = "https://www.fda.gov/media/89850/download?attachment";
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const ymd = (d) => d.toISOString().slice(0, 10);
const weekOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return ymd(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
};
const round4 = (x) => Math.round(x * 10000) / 10000;

async function bulk(ctx, url, headers) {
  const r = await ctx.fetchImpl(url, { binary: true, headers }, { timeoutMs: BULK_TIMEOUT_MS });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return unzip(Buffer.from(r.text, "base64"));
}

async function listing(ctx, url, headers, re) {
  const r = await ctx.fetchImpl(url, { headers });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return [...new Set([...r.text.matchAll(re)].map((m) => m[1]))].map((h) => new URL(h, SEC).toString());
}

// Tab-separated entry -> calls onRow(row, idx) for every data line.
async function eachRow(z, name, onRow) {
  let idx = null;
  await z.eachLine(name, (line) => {
    const c = line.replace(/\r$/, "").split("\t");
    if (!idx) { idx = Object.fromEntries(c.map((h, i) => [h.trim(), i])); return; }
    onRow(c, idx);
  });
  if (!idx) throw new Error(`${name}: empty`);
  return idx;
}

function secCompanies(catalog) {
  const out = new Map(); // cik (number) -> {ticker, entity_id}
  for (const s of catalog.series.filter((x) => x.source_id === "sec" && x.params && x.params.cik)) {
    out.set(Number(s.params.cik), { ticker: s.params.ticker, entity_id: s.entity_id });
  }
  return out;
}

const quarterOfFile = (url) => {
  const m = /(\d{4})q([1-4])/i.exec(url);
  return m ? { y: Number(m[1]), q: Number(m[2]) } : null;
};

// ---- C1: SEC Insider Transactions Data Sets ------------------------------------------------------
async function checkSecInsider(db, catalog, ctx) {
  const ua = ctx.env.PMIC_SEC_USER_AGENT;
  const companies = secCompanies(catalog);
  if (!ua || !companies.size) return;
  const headers = { "User-Agent": ua };
  const done = kvGet(db, "verified:sec345") || {};
  const files = await listing(ctx, INSIDER_LISTING, headers, /href="([^"]*\d{4}q[1-4]_form345\.zip)"/gi);
  const file = files.find((u) => !done[u.split("/").pop()]); // newest first on the page
  if (!file) return;
  const fq = quarterOfFile(file);
  const qStart = new Date(Date.UTC(fq.y, (fq.q - 1) * 3, 1));
  const qEnd = new Date(Date.UTC(fq.y, fq.q * 3, 0));
  const weeks = [];
  for (let w = new Date(weekOf(ymd(qStart))); w.getTime() + 6 * DAY <= qEnd.getTime(); w = new Date(w.getTime() + 7 * DAY)) {
    if (w.getTime() >= qStart.getTime()) weeks.push(ymd(w));
  }
  const z = await bulk(ctx, file, headers);
  const acc = new Map(); // accession -> [ticker, week]
  await eachRow(z, z.names.find((n) => /SUBMISSION\.tsv$/i.test(n)), (c, i) => {
    if (c[i.DOCUMENT_TYPE] !== "4") return;
    const co = companies.get(Number(c[i.ISSUERCIK]));
    const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(c[i.FILING_DATE] || "");
    if (!co || !m) return;
    acc.set(c[i.ACCESSION_NUMBER], [co.ticker, weekOf(ymd(new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toUpperCase()], Number(m[1])))))]);
  });
  const theirs = new Map(); // `${ticker}|${metric}|${week}` -> value
  const add = (k, v) => theirs.set(k, (theirs.get(k) || 0) + v);
  for (const [, [t, w]] of acc) add(`${t}|insider_form4_weekly|${w}`, 1);
  await eachRow(z, z.names.find((n) => /NONDERIV_TRANS\.tsv$/i.test(n)), (c, i) => {
    const a = acc.get(c[i.ACCESSION_NUMBER]);
    if (!a) return;
    const v = Number(c[i.TRANS_SHARES]) * Number(c[i.TRANS_PRICEPERSHARE]);
    if (!Number.isFinite(v)) return;
    if (c[i.TRANS_CODE] === "P") add(`${a[0]}|insider_buy_value_weekly|${a[1]}`, v);
    else if (c[i.TRANS_CODE] === "S") add(`${a[0]}|insider_sell_value_weekly|${a[1]}`, v);
  });
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time >= ? AND observation_time <= ?");
  for (const [, co] of companies) {
    for (const metric of ["insider_form4_weekly", "insider_buy_value_weekly", "insider_sell_value_weekly"]) {
      const sid = `sec:${co.ticker}:${metric}`;
      const mine = new Map(ours.all(sid, weeks[0], weeks[weeks.length - 1]).map((r) => [r.t, r.v]));
      const compared = weeks.filter((w) => mine.has(w));
      if (!compared.length) continue;
      const diff = compared.filter((w) => {
        const a = mine.get(w);
        const b = theirs.get(`${co.ticker}|${metric}|${w}`) || 0;
        return metric === "insider_form4_weekly" ? a !== b : Math.abs(a - b) > Math.max(1, 0.005 * Math.abs(b));
      });
      const share = diff.length / compared.length;
      ctx.rows.push({ run_id: ctx.runId, field: `series:${sid}`, entity_id: co.entity_id,
        our_value: { quarter: `${fq.y}Q${fq.q}`, weeks: Object.fromEntries(compared.map((w) => [w, mine.get(w)])) },
        upstream_service: "sec-insider-datasets",
        upstream_value: { file: file.split("/").pop(), weeks: Object.fromEntries(compared.map((w) => [w, Math.round(theirs.get(`${co.ticker}|${metric}|${w}`) || 0)])) },
        agreement: diff.length === 0 ? "agree" : share <= 0.1 ? "partial" : "disagree", delta_pct: round4(share * 100), tolerance_pct: 0,
        observed_at: `${weeks[weeks.length - 1]}T00:00:00Z` });
      if (diff.length) ctx.notes.push(`sec-insider ${sid}: ${diff.length} of ${compared.length} weeks differ (${diff.slice(0, 3).join(", ")})`);
    }
  }
  ctx.calls.push(["sec-insider-datasets", { latencyMs: null }]);
  done[file.split("/").pop()] = ctx.nowIso;
  kvSet(db, "verified:sec345", done);
}

// ---- C2: SEC Financial Statement Data Sets -------------------------------------------------------
async function checkSecFsds(db, catalog, ctx) {
  const ua = ctx.env.PMIC_SEC_USER_AGENT;
  const companies = secCompanies(catalog);
  const metrics = (catalog.sec && catalog.sec.metrics) || [];
  if (!ua || !companies.size || !metrics.length) return;
  const headers = { "User-Agent": ua };
  const done = kvGet(db, "verified:fsds") || {};
  const files = await listing(ctx, FSDS_LISTING, headers, /href="([^"]*\/\d{4}q[1-4]\.zip)"/gi);
  // newest first; the first pass also backfills the previous three quarters, one file per pass
  const file = files.slice(0, 4).find((u) => !done[u.split("/").pop()]);
  if (!file) return;
  const z = await bulk(ctx, file, headers);
  const sub = new Map(); // adsh -> {co, period (YYYYMMDD), filed, form}
  await eachRow(z, "sub.txt", (c, i) => {
    const co = companies.get(Number(c[i.cik]));
    if (!co || !/^10-[QK](\/A)?$/.test(c[i.form])) return;
    sub.set(c[i.adsh], { co, period: c[i.period], filed: c[i.filed], form: c[i.form] });
  });
  const tags = new Set(metrics.flatMap((m) => m.concepts));
  const vals = new Map(); // `${ticker}|${tag}|${ddate}|${qtrs}` -> {value, adsh, filed}
  await eachRow(z, "num.txt", (c, i) => {
    const s = sub.get(c[i.adsh]);
    if (!s || !tags.has(c[i.tag]) || c[i.uom] !== "USD" || c[i.coreg] || (i.segments !== undefined && c[i.segments])) return;
    if (c[i.ddate] !== s.period) return; // the filing's own period only, never its comparatives
    const k = `${s.co.ticker}|${c[i.tag]}|${c[i.ddate]}|${c[i.qtrs]}`;
    const prev = vals.get(k);
    if (!prev || s.filed > prev.filed) vals.set(k, { value: Number(c[i.value]), adsh: c[i.adsh], filed: s.filed });
  });
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time = ?");
  for (const [, co] of companies) {
    for (const m of metrics) {
      const variants = m.kind === "duration" ? [[`${m.metric_name}_q`, "1"], [`${m.metric_name}_fy`, "4"]] : [[m.metric_name, "0"]];
      for (const [metric, qtrs] of variants) {
        const sid = `sec:${co.ticker}:${metric}`;
        for (const [k, v] of vals) {
          const [t, , ddate, q] = k.split("|");
          if (t !== co.ticker || q !== qtrs) continue;
          // the first of our tags this filing reports for the period, in our tag order
          const tag = m.concepts.find((c) => vals.has(`${t}|${c}|${ddate}|${q}`));
          if (k !== `${t}|${tag}|${ddate}|${q}`) continue;
          const end = `${ddate.slice(0, 4)}-${ddate.slice(4, 6)}-${ddate.slice(6, 8)}`;
          const mine = ours.get(sid, end);
          if (!mine) continue;
          const diff = Math.abs(mine.v - v.value);
          const rel = v.value ? diff / Math.abs(v.value) : (diff ? 1 : 0);
          ctx.rows.push({ run_id: ctx.runId, field: `series:${sid}`, entity_id: co.entity_id,
            our_value: { period_end: end, value: mine.v },
            upstream_service: "sec-fsds",
            upstream_value: { file: file.split("/").pop(), adsh: v.adsh, tag, value: v.value },
            agreement: diff <= Math.max(1, 1e-4 * Math.abs(v.value)) ? "agree" : rel <= 0.01 ? "partial" : "disagree",
            delta_pct: round4(rel * 100), tolerance_pct: 0.01, observed_at: `${end}T00:00:00Z` });
        }
      }
    }
  }
  ctx.calls.push(["sec-fsds", { latencyMs: null }]);
  done[file.split("/").pop()] = ctx.nowIso;
  kvSet(db, "verified:fsds", done);
}

// ---- P2: Drugs@FDA data file ---------------------------------------------------------------------
async function checkDrugsFda(db, catalog, ctx) {
  const byFeed = new Map(catalog.series.filter((s) => s.source_id === "openfda" && s.params).map((s) => [s.params.feed, s]));
  const series = [["approvals_nda_bla", false], ["approvals_anda", true]].map(([f, g]) => [byFeed.get(f), g]).filter(([s]) => s);
  const today = ymd(ctx.now);
  if (!series.length || kvGet(db, "verified:drugsfda") === today) return;
  // the 4 complete weeks that ended at least 7 days ago: the newest starts two Mondays back
  const newest = Date.parse(`${weekOf(today)}T00:00:00Z`) - 14 * DAY;
  const weeks = [3, 2, 1, 0].map((n) => ymd(new Date(newest - n * 7 * DAY)));
  const z = await bulk(ctx, DRUGSFDA_ZIP, {});
  const type = new Map();
  await eachRow(z, "Applications.txt", (c, i) => type.set(c[i.ApplNo], c[i.ApplType]));
  const counts = new Map();
  await eachRow(z, "Submissions.txt", (c, i) => {
    if (c[i.SubmissionType] !== "ORIG" || c[i.SubmissionStatus] !== "AP" || !c[i.SubmissionStatusDate]) return;
    const w = weekOf(c[i.SubmissionStatusDate].slice(0, 10));
    if (!weeks.includes(w)) return;
    const k = `${type.get(c[i.ApplNo]) === "ANDA"}|${w}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time >= ? AND observation_time <= ?");
  for (const [s, generic] of series) {
    const mine = new Map(ours.all(s.series_id, weeks[0], weeks[weeks.length - 1]).map((r) => [r.t, r.v]));
    const compared = weeks.filter((w) => mine.has(w));
    if (!compared.length) continue;
    const a = compared.reduce((x, w) => x + mine.get(w), 0);
    const b = compared.reduce((x, w) => x + (counts.get(`${generic}|${w}`) || 0), 0);
    const exact = compared.every((w) => mine.get(w) === (counts.get(`${generic}|${w}`) || 0));
    const rel = b ? Math.abs(a - b) / b : (a ? 1 : 0);
    ctx.rows.push({ run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id,
      our_value: { weeks: Object.fromEntries(compared.map((w) => [w, mine.get(w)])) },
      upstream_service: "drugsfda",
      upstream_value: { weeks: Object.fromEntries(compared.map((w) => [w, counts.get(`${generic}|${w}`) || 0])) },
      agreement: exact ? "agree" : rel <= 0.1 ? "partial" : "disagree", delta_pct: round4(rel * 100), tolerance_pct: 0,
      observed_at: `${compared[compared.length - 1]}T00:00:00Z` });
  }
  ctx.calls.push(["drugsfda", { latencyMs: null }]);
  kvSet(db, "verified:drugsfda", today);
}

// ---- P3: openFDA label index against our DailyMed label series -----------------------------------
async function checkOpenfdaLabels(db, catalog, ctx) {
  const series = catalog.series.filter((s) => s.source_id === "openfda" && s.params && (s.params.feed === "labels" || s.params.feed === "labels_firm"));
  const today = ymd(ctx.now);
  if (!series.length || kvGet(db, "verified:openfda_labels") === today) return;
  const newest = Date.parse(`${weekOf(today)}T00:00:00Z`) - 7 * 7 * DAY; // ended at least 6 weeks ago
  const weeks = [3, 2, 1, 0].map((n) => ymd(new Date(newest - n * 7 * DAY)));
  const last = ymd(new Date(Date.parse(`${weeks[3]}T00:00:00Z`) + 6 * DAY));
  const compact = (d) => d.replace(/-/g, "");
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time >= ? AND observation_time <= ?");
  for (const s of series) {
    const mine = new Map(ours.all(s.series_id, weeks[0], weeks[3]).map((r) => [r.t, r.v]));
    if (weeks.some((w) => !mine.has(w))) continue; // our series must cover all 4 weeks
    let search = `effective_time:[${compact(weeks[0])} TO ${compact(last)}]`;
    if (s.params.feed === "labels_firm") search += ` AND (${s.params.firms.map((f) => `openfda.manufacturer_name:"${f}"`).join(" OR ")})`;
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(search)}&count=effective_time`;
    const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id, our_value: { weeks: Object.fromEntries(weeks.map((w) => [w, mine.get(w)])) },
      upstream_service: "openfda-label", tolerance_pct: 15, observed_at: `${weeks[3]}T00:00:00Z` };
    try {
      const r = await ctx.fetchImpl(url, {});
      let results = [];
      if (r.status >= 200 && r.status < 300) results = JSON.parse(r.text).results || [];
      else if (r.status !== 404) throw new Error(`api.fda.gov: HTTP ${r.status}`);
      const theirs = new Map(weeks.map((w) => [w, 0]));
      for (const x of results) {
        const d = `${x.time.slice(0, 4)}-${x.time.slice(4, 6)}-${x.time.slice(6, 8)}`;
        const w = weekOf(d);
        if (theirs.has(w)) theirs.set(w, theirs.get(w) + (Number(x.count) || 0));
      }
      const a = weeks.reduce((x, w) => x + mine.get(w), 0);
      const b = weeks.reduce((x, w) => x + theirs.get(w), 0);
      const diff = Math.abs(a - b);
      const rel = b ? diff / b : (a ? 1 : 0);
      ctx.rows.push({ ...row, upstream_value: { weeks: Object.fromEntries(theirs) },
        agreement: diff <= Math.max(0.15 * b, 3) ? "agree" : diff <= Math.max(0.3 * b, 6) ? "partial" : "disagree", delta_pct: round4(rel * 100) });
      ctx.calls.push(["openfda-label", { disagreed: diff > Math.max(0.3 * b, 6), latencyMs: null }]);
    } catch (e) {
      ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
      ctx.calls.push(["openfda-label", { ok: false }]);
      ctx.notes.push(`openfda-label ${s.series_id}: ${String(e.message).slice(0, 120)}`);
    }
  }
  kvSet(db, "verified:openfda_labels", today);
}

// ---- P4: FAERS quarterly files against our openFDA FAERS weekly count ----------------------------
const FAERS_LISTING = "https://fis.fda.gov/extensions/FPD-QDE-FAERS/FPD-QDE-FAERS.html";
const FAERS_AGREE = 0.005;
const FAERS_PARTIAL = 0.02;

async function checkFaers(db, catalog, ctx) {
  const s = catalog.series.find((x) => x.source_id === "openfda" && x.params && x.params.feed === "faers");
  if (!s) return;
  const headers = { "User-Agent": "pmic-collector" };
  const done = kvGet(db, "verified:faers") || {};
  const r = await ctx.fetchImpl(FAERS_LISTING, { headers });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`fis.fda.gov: HTTP ${r.status}`);
  const files = [...new Set([...r.text.matchAll(/href="([^"]*faers_ascii_\d{4}q[1-4]\.zip)"/gi)].map((m) => new URL(m[1], FAERS_LISTING).toString()))]
    .map((u) => ({ u, q: quarterOfFile(u) })).sort((a, b) => b.q.y - a.q.y || b.q.q - a.q.q);
  const key = (f) => `${f.q.y}q${f.q.q}`;
  const file = files.slice(0, 4).find((f) => !done[key(f)]); // newest first, then backfill three quarters
  if (!file) return;
  const qStart = new Date(Date.UTC(file.q.y, (file.q.q - 1) * 3, 1));
  const qEnd = new Date(Date.UTC(file.q.y, file.q.q * 3, 0));
  const weeks = [];
  for (let w = new Date(weekOf(ymd(qStart))); w.getTime() + 6 * DAY <= qEnd.getTime(); w = new Date(w.getTime() + 7 * DAY)) {
    if (w.getTime() >= qStart.getTime()) weeks.push(ymd(w));
  }
  const z = await bulk(ctx, file.u, headers);
  const demo = z.names.find((n) => /DEMO\d{2}Q[1-4]\.txt$/i.test(n));
  if (!demo) throw new Error(`${key(file)}: no DEMO file`);
  const theirs = new Map();
  let idx = null;
  await z.eachLine(demo, (line) => {
    const c = line.replace(/\r$/, "").split("$");
    if (!idx) { idx = Object.fromEntries(c.map((h, i) => [h.trim().toLowerCase(), i])); return; }
    const d = c[idx.init_fda_dt];
    if (!/^\d{8}$/.test(d || "")) return;
    const w = weekOf(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    theirs.set(w, (theirs.get(w) || 0) + 1);
  });
  if (!idx || idx.init_fda_dt === undefined) throw new Error(`${key(file)}: DEMO has no init_fda_dt`);
  const mine = new Map(db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time >= ? AND observation_time <= ?")
    .all(s.series_id, weeks[0], weeks[weeks.length - 1]).map((x) => [x.t, x.v]));
  const compared = weeks.filter((w) => mine.has(w));
  if (compared.length) {
    const rel = (w) => { const b = theirs.get(w) || 0; return b ? Math.abs(mine.get(w) - b) / b : (mine.get(w) ? 1 : 0); };
    const worst = Math.max(...compared.map(rel));
    ctx.rows.push({ run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id,
      our_value: { quarter: `${file.q.y}Q${file.q.q}`, weeks: Object.fromEntries(compared.map((w) => [w, mine.get(w)])) },
      upstream_service: "faers",
      upstream_value: { file: file.u.split("/").pop(), weeks: Object.fromEntries(compared.map((w) => [w, theirs.get(w) || 0])) },
      agreement: worst <= FAERS_AGREE ? "agree" : worst <= FAERS_PARTIAL ? "partial" : "disagree", delta_pct: round4(worst * 100),
      tolerance_pct: FAERS_AGREE * 100, observed_at: `${compared[compared.length - 1]}T00:00:00Z` });
    if (worst > FAERS_AGREE) ctx.notes.push(`faers ${key(file)}: largest weekly difference ${round4(worst * 100)}%`);
  }
  ctx.calls.push(["faers", { latencyMs: null }]);
  done[key(file)] = ctx.nowIso;
  kvSet(db, "verified:faers", done);
}

// ---- P5: AACT (CTTI's copy of ClinicalTrials.gov) against our ClinicalTrials.gov series ------------
const AACT = { host: "aact-db.ctti-clinicaltrials.org", port: 5432, database: "aact", allowExpiredCertificate: true };
const AACT_MONTHS = 6;
const AACT_PARTIAL = 0.1;
const AACT_PARTIAL_ABS = 2;

function aactSql(sponsors, firstMonth) {
  // Sponsor names come from config/series.json (ctgov_sponsors); only quotes need escaping.
  const like = sponsors.map((n) => `s.name ILIKE '%${String(n).replace(/'/g, "''")}%'`).join(" OR ");
  const base = `FROM ctgov.studies st JOIN (SELECT DISTINCT s.nct_id FROM ctgov.sponsors s WHERE s.lead_or_collaborator = 'lead' AND (${like})) l ON l.nct_id = st.nct_id`;
  const month = (col) => `to_char(date_trunc('month', st.${col}), 'YYYY-MM-DD')`;
  return {
    trial_starts_monthly: `SELECT ${month("start_date")} m, count(*) n ${base} WHERE upper(st.start_date_type) = 'ACTUAL' AND st.start_date >= '${firstMonth}' GROUP BY 1`,
    trial_completions_monthly: `SELECT ${month("completion_date")} m, count(*) n ${base} WHERE upper(st.completion_date_type) = 'ACTUAL' AND st.completion_date >= '${firstMonth}' GROUP BY 1`,
    trial_stops_monthly: `SELECT ${month("last_update_posted_date")} m, count(*) n ${base} WHERE upper(st.overall_status) IN ('TERMINATED','WITHDRAWN','SUSPENDED') AND st.last_update_posted_date >= '${firstMonth}' GROUP BY 1`,
    active_trials: `SELECT count(*) n ${base} WHERE upper(st.overall_status) IN ('RECRUITING','NOT_YET_RECRUITING','ACTIVE_NOT_RECRUITING','ENROLLING_BY_INVITATION')`,
  };
}

async function checkAact(db, catalog, ctx) {
  const user = ctx.env.AACT_USER;
  const password = ctx.env.AACT_PASSWORD;
  const today = ymd(ctx.now);
  if (!user || !password || kvGet(db, "verified:aact") === today) return;
  const byEntity = new Map();
  for (const s of catalog.series.filter((x) => x.source_id === "ctgov" && x.params && x.params.sponsors)) {
    if (!byEntity.has(s.entity_id)) byEntity.set(s.entity_id, []);
    byEntity.get(s.entity_id).push(s);
  }
  if (!byEntity.size) return;
  const cur = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  const months = [];
  for (let k = AACT_MONTHS; k >= 1; k--) months.push(ymd(new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - k, 1))));
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? AND observation_time >= ? AND observation_time <= ?");
  const latest = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1");
  const t0 = Date.now();
  for (const [, group] of byEntity) {
    const sql = aactSql(group[0].params.sponsors, months[0]);
    const metrics = group.map((s) => s.metric_name).filter((m) => sql[m]);
    const res = await pg.query({ ...AACT, user, password }, metrics.map((m) => sql[m]));
    const transport = res.certExpired ? { comparison_transport: "aact_tls_certificate_expired_accepted" } : {};
    metrics.forEach((metric, i) => {
      const s = group.find((x) => x.metric_name === metric);
      let mine;
      let theirs;
      let observed;
      if (metric === "active_trials") {
        const l = latest.get(s.series_id);
        if (!l || l.t !== today) return; // compare same-day snapshots only
        mine = { [l.t]: l.v };
        theirs = { [l.t]: Number(res[i][0].n) };
        observed = l.t;
      } else {
        const got = new Map(ours.all(s.series_id, months[0], months[months.length - 1]).map((r) => [r.t, r.v]));
        const compared = months.filter((m) => got.has(m));
        if (!compared.length) return;
        const counts = new Map(res[i].map((r) => [r.m, Number(r.n)]));
        mine = Object.fromEntries(compared.map((m) => [m, got.get(m)]));
        theirs = Object.fromEntries(compared.map((m) => [m, counts.get(m) || 0]));
        observed = compared[compared.length - 1];
      }
      const keys = Object.keys(mine);
      const a = keys.reduce((x, k) => x + mine[k], 0);
      const b = keys.reduce((x, k) => x + theirs[k], 0);
      const exact = keys.every((k) => mine[k] === theirs[k]);
      const gap = Math.abs(a - b);
      const rel = b ? gap / b : (a ? 1 : 0);
      ctx.rows.push({ run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id,
        our_value: { ...(metric === "active_trials" ? { snapshot: mine } : { months: mine }), ...transport },
        upstream_service: "aact", upstream_value: { months_or_snapshot: theirs },
        agreement: exact ? "agree" : (rel <= AACT_PARTIAL || gap <= AACT_PARTIAL_ABS) ? "partial" : "disagree",
        delta_pct: round4(rel * 100), tolerance_pct: 0, observed_at: `${observed}T00:00:00Z` });
      if (!exact) ctx.notes.push(`aact ${s.series_id}: ours ${a} vs AACT ${b}`);
    });
    if (res.certExpired && !ctx.notes.some((n) => n.startsWith("aact: database certificate"))) ctx.notes.push("aact: database certificate expired (accepted, owner option A)");
  }
  ctx.calls.push(["aact", { latencyMs: Date.now() - t0 }]);
  kvSet(db, "verified:aact", today);
}

module.exports = { checkSecInsider, checkSecFsds, checkDrugsFda, checkOpenfdaLabels, checkFaers, checkAact, aactSql, weekOf };
