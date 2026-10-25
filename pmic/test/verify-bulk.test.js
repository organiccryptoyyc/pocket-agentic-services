// Phase 3 bulk-file cross-checks (C1 SEC insider data sets, C2 SEC financial statement data sets,
// P2 Drugs@FDA), against synthetic zips with known answers.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const B = require("../lib/verify-bulk");

const catalog = catalogLib.load();
const NOW = new Date("2026-10-19T12:00:00Z");

// Minimal zip writer (deflate), enough for lib/xlsx.js unzip.
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = zlib.deflateRawSync(raw);
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nameB);
    off += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n") + "\n";

function fresh() {
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-bulk-")) });
  dbLib.syncCatalog(db, catalog);
  return db;
}
function obs(db, sid, t, v) {
  const s = catalog.series.find((x) => x.series_id === sid);
  db.prepare(`INSERT INTO observations (source_id, series_id, entity_id, metric_name, metric_value, unit, observation_time, fetch_time, source_url, transform_version, retention_class, confidence_score, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.source_id, sid, s.entity_id, s.metric_name, v, "x", t, "2026-10-01T00:00:00Z", "u", "1", "standard", 0.9, "2026-10-01T00:00:00Z");
}
function ctxWith(responses) {
  const ctx = { now: NOW, nowIso: NOW.toISOString(), runId: "pmic/2026-10-19T12:00:00Z", env: { PMIC_SEC_USER_AGENT: "test test@example.com" }, rows: [], calls: [], notes: [] };
  ctx.fetchImpl = async (url, init) => {
    const body = responses[url];
    if (body === undefined) return { status: 404, text: "" };
    return { status: 200, text: Buffer.isBuffer(body) ? (init && init.binary ? body.toString("base64") : body.toString()) : body };
  };
  return ctx;
}

test("C1: weekly Form 4 counts and P/S values against the SEC insider data set; a mismatch is reported", async () => {
  const db = fresh();
  // AAPL, Q3 2026: weeks fully inside the quarter start 2026-07-06; we store two of them
  obs(db, "sec:AAPL:insider_form4_weekly", "2026-07-06", 2);
  obs(db, "sec:AAPL:insider_form4_weekly", "2026-07-13", 1);
  obs(db, "sec:AAPL:insider_sell_value_weekly", "2026-07-06", 1000);
  obs(db, "sec:AAPL:insider_sell_value_weekly", "2026-07-13", 0);
  const sub = tsv([["ACCESSION_NUMBER", "FILING_DATE", "DOCUMENT_TYPE", "ISSUERCIK"],
    ["a1", "07-JUL-2026", "4", "0000320193"], ["a2", "08-JUL-2026", "4", "320193"], ["a3", "14-JUL-2026", "4", "320193"],
    ["a4", "14-JUL-2026", "4", "70858"], ["a5", "15-JUL-2026", "4/A", "320193"]]);
  const nd = tsv([["ACCESSION_NUMBER", "TRANS_CODE", "TRANS_SHARES", "TRANS_PRICEPERSHARE"], ["a1", "S", "10", "100"], ["a3", "S", "5", "10"]]);
  const url = "https://www.sec.gov/files/x/2026q3_form345.zip";
  const ctx = ctxWith({ "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets": '<a href="/files/x/2026q3_form345.zip">x</a>',
    [url]: zip({ "SUBMISSION.tsv": sub, "NONDERIV_TRANS.tsv": nd }) });
  await B.checkSecInsider(db, catalog, ctx);
  const byField = Object.fromEntries(ctx.rows.map((r) => [r.field, r]));
  assert.equal(byField["series:sec:AAPL:insider_form4_weekly"].agreement, "agree");
  const sell = byField["series:sec:AAPL:insider_sell_value_weekly"];
  assert.equal(sell.agreement, "disagree", "the week of 07-13 has a $50 sale missing from our series");
  assert.deepEqual(sell.upstream_value.weeks, { "2026-07-06": 1000, "2026-07-13": 50 });
  const before = ctx.rows.length;
  await B.checkSecInsider(db, catalog, ctx);
  assert.equal(ctx.rows.length, before, "each data set file is read once");
});

test("C2: each filing's own-period value in our tag order; comparatives ignored; partial within 1%", async () => {
  const db = fresh();
  obs(db, "sec:AAPL:revenue_q", "2026-06-27", 100000);
  obs(db, "sec:AAPL:cash", "2026-06-27", 5000);
  obs(db, "sec:AAPL:cash", "2026-03-28", 4000);
  const sub = tsv([["adsh", "cik", "form", "period", "filed"], ["q3", "320193", "10-Q", "20260627", "20260801"], ["x", "70858", "10-Q", "20260630", "20260801"]]);
  const num = tsv([["adsh", "tag", "version", "ddate", "qtrs", "uom", "segments", "coreg", "value"],
    ["q3", "Revenues", "us-gaap/2025", "20260627", "1", "USD", "", "", "99999"],
    ["q3", "RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap/2025", "20260627", "1", "USD", "", "", "100500"],
    ["q3", "CashAndCashEquivalentsAtCarryingValue", "us-gaap/2025", "20260627", "0", "USD", "", "", "5000"],
    ["q3", "CashAndCashEquivalentsAtCarryingValue", "us-gaap/2025", "20260328", "0", "USD", "", "", "4100"],
    ["q3", "CashAndCashEquivalentsAtCarryingValue", "us-gaap/2025", "20260627", "0", "USD", "Segment=X", "", "1"]]);
  const url = "https://www.sec.gov/files/dera/data/financial-statement-data-sets/2026q3.zip";
  const ctx = ctxWith({ "https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets": '<a href="/files/dera/data/financial-statement-data-sets/2026q3.zip">q</a>',
    [url]: zip({ "sub.txt": sub, "num.txt": num }) });
  await B.checkSecFsds(db, catalog, ctx);
  const rows = ctx.rows.map((r) => [r.field, r.our_value.period_end, r.agreement, r.upstream_value.tag]);
  assert.deepEqual(rows.sort(), [
    ["series:sec:AAPL:cash", "2026-06-27", "agree", "CashAndCashEquivalentsAtCarryingValue"],
    ["series:sec:AAPL:revenue_q", "2026-06-27", "partial", "RevenueFromContractWithCustomerExcludingAssessedTax"]]);
});

test("P2: Drugs@FDA original approvals per week against our openFDA counts, complete weeks a week old", async () => {
  const db = fresh();
  for (const [w, nda, anda] of [["2026-09-14", 2, 13], ["2026-09-21", 8, 17], ["2026-09-28", 2, 7], ["2026-10-05", 4, 7], ["2026-10-12", 0, 1]]) {
    obs(db, "openfda:approvals_nda_bla_weekly", w, nda);
    obs(db, "openfda:approvals_anda_weekly", w, anda);
  }
  const apps = [["ApplNo", "ApplType", "ApplPublicNotes", "SponsorName"]];
  const subs = [["ApplNo", "SubmissionClassCodeID", "SubmissionType", "SubmissionNo", "SubmissionStatus", "SubmissionStatusDate"]];
  let n = 0;
  const add = (type, date, k) => { for (let i = 0; i < k; i++) { n++; apps.push([`A${n}`, type, "", "X"]); subs.push([`A${n}`, "1", "ORIG", "1", "AP", `${date} 00:00:00`]); } };
  add("NDA", "2026-09-15", 2); add("NDA", "2026-09-22", 8); add("NDA", "2026-09-29", 2); add("BLA", "2026-10-06", 4);
  add("ANDA", "2026-09-15", 13); add("ANDA", "2026-09-22", 17); add("ANDA", "2026-09-29", 7); add("ANDA", "2026-10-06", 6);
  add("NDA", "2026-10-13", 5);
  subs.push(["A1", "1", "SUPPL", "2", "AP", "2026-09-15 00:00:00"]);
  const ctx = ctxWith({ "https://www.fda.gov/media/89850/download?attachment": zip({ "Applications.txt": tsv(apps), "Submissions.txt": tsv(subs) }) });
  await B.checkDrugsFda(db, catalog, ctx);
  const by = Object.fromEntries(ctx.rows.map((r) => [r.field, r]));
  assert.equal(by["series:openfda:approvals_nda_bla_weekly"].agreement, "agree");
  assert.deepEqual(Object.keys(by["series:openfda:approvals_nda_bla_weekly"].our_value.weeks), ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
  assert.equal(by["series:openfda:approvals_anda_weekly"].agreement, "partial", "44 vs 43: within 10%");
  await B.checkDrugsFda(db, catalog, ctx);
  assert.equal(ctx.rows.length, 2, "once a day");
});

test("P3: openFDA label index against our DailyMed series, 4 weeks that ended 6+ weeks ago, 4-week totals", async () => {
  const db = fresh();
  // NOW 2026-10-19: the newest week compared starts 2026-08-31 (7 weeks before this Monday)
  for (const [w, v] of [["2026-08-10", 800], ["2026-08-17", 900], ["2026-08-24", 700], ["2026-08-31", 1000]]) obs(db, "openfda:label_updates_weekly", w, v);
  for (const [w, v] of [["2026-08-10", 5], ["2026-08-17", 3], ["2026-08-24", 0], ["2026-08-31", 2]]) obs(db, "openfda:PFE:label_updates_weekly", w, v);
  const results = (per) => JSON.stringify({ results: ["20260811", "20260818", "20260825", "20260901"].map((t) => ({ time: t, count: per })) });
  const ctx = ctxWith({});
  const seen = [];
  ctx.fetchImpl = async (url) => {
    seen.push(decodeURIComponent(url));
    return { status: 200, text: url.includes("manufacturer_name") ? results(2) : results(820) };
  };
  await B.checkOpenfdaLabels(db, catalog, ctx);
  const by = Object.fromEntries(ctx.rows.map((r) => [r.field, r]));
  assert.equal(by["series:openfda:label_updates_weekly"].agreement, "agree", "3400 vs 3280: 3.7%");
  assert.equal(by["series:openfda:PFE:label_updates_weekly"].agreement, "agree", "10 vs 8: within the 3-label allowance");
  assert.ok(seen.some((u) => u.includes("effective_time:[20260810 TO 20260906]")));
  assert.ok(seen.some((u) => u.includes('openfda.manufacturer_name:"Pfizer"')));
});

test("P4: FAERS cases by initial receipt week against our openFDA count; newest quarter first, then backfill", async () => {
  const db = fresh();
  const sid = "openfda:adverse_event_reports_weekly";
  obs(db, sid, "2026-03-30", 999); // crosses the quarter start: never compared
  obs(db, sid, "2026-04-06", 3);
  obs(db, sid, "2026-04-13", 2);
  const head = "primaryid$caseid$caseversion$i_f_code$event_dt$mfr_dt$init_fda_dt$fda_dt$rept_cod";
  const row = (id, init, fda) => `${id}$${id}$2$F$$$${init}$${fda}$EXP`;
  // fda_dt (latest version) differs from init_fda_dt: only the initial receipt date counts
  const demo = [head, row(1, "20260407", "20260601"), row(2, "20260408", "20260408"), row(3, "20260410", "20260520"),
    row(4, "20260414", "20260414"), row(5, "20260415", "20260616"), row(6, "20260331", "20260402")].join("\r\n") + "\r\n";
  const page = '<a href="https://fis.fda.gov/content/Exports/faers_ascii_2025Q4.zip">x</a><a href="https://fis.fda.gov/content/Exports/faers_ascii_2026q2.zip">x</a>'
    + '<a href="https://fis.fda.gov/content/Exports/faers_ascii_2026q1.zip">x</a>';
  const files = { "https://fis.fda.gov/extensions/FPD-QDE-FAERS/FPD-QDE-FAERS.html": page,
    "https://fis.fda.gov/content/Exports/faers_ascii_2026q2.zip": zip({ "ASCII/DEMO26Q2.txt": demo, "Deleted/DELETE26Q2.txt": "1\n" }) };
  const ctx = ctxWith(files);
  await B.checkFaers(db, catalog, ctx);
  assert.equal(ctx.rows.length, 1);
  const r = ctx.rows[0];
  assert.equal(r.upstream_service, "faers");
  assert.equal(r.agreement, "agree");
  assert.deepEqual(r.our_value.weeks, { "2026-04-06": 3, "2026-04-13": 2 });
  assert.deepEqual(r.upstream_value.weeks, { "2026-04-06": 3, "2026-04-13": 2 });
  assert.equal(r.observed_at, "2026-04-13T00:00:00Z");
  // the next pass takes the previous quarter (not on the stub: a failure, the done list keeps 2026q2)
  const ctx2 = ctxWith(files);
  await assert.rejects(B.checkFaers(db, catalog, ctx2), /HTTP 404/);
  // a 1% gap is partial, a 5% gap disagrees
  for (const [ours, want] of [[101, "partial"], [105, "disagree"]]) {
    const d2 = fresh();
    obs(d2, sid, "2026-04-06", ours);
    const many = [head, ...Array.from({ length: 100 }, (_, k) => row(k + 1, "20260407", "20260407"))].join("\n") + "\n";
    const c3 = ctxWith({ ...files, "https://fis.fda.gov/content/Exports/faers_ascii_2026q2.zip": zip({ "ASCII/DEMO26Q2.txt": many }) });
    await B.checkFaers(d2, catalog, c3);
    assert.equal(c3.rows[0].agreement, want);
  }
});

test("P4: an older quarter counts its cases across its own and every later FAERS file, once each; rechecked when a newer file appears", async () => {
  const db = fresh();
  const sid = "openfda:adverse_event_reports_weekly";
  obs(db, sid, "2026-01-05", 3); // three cases first received that week
  const head = "primaryid$caseid$caseversion$i_f_code$event_dt$mfr_dt$init_fda_dt$fda_dt$rept_cod";
  const row = (id, init, fda) => `${id}0$${id}$1$I$$$${init}$${fda}$EXP`;
  // case 1 is only in Q1; case 2 in both (counted once); case 3's latest version is only in Q2
  const q1 = [head, row(1, "20260106", "20260106"), row(2, "20260107", "20260107")].join("\n") + "\n";
  const q2 = [head, row(2, "20260107", "20260410"), row(3, "20260108", "20260415"), row(9, "20260407", "20260407")].join("\n") + "\n";
  const base = "https://fis.fda.gov/content/Exports/";
  const page = (qs) => qs.map((q) => `<a href="${base}faers_ascii_${q}.zip">x</a>`).join("");
  const files = { "https://fis.fda.gov/extensions/FPD-QDE-FAERS/FPD-QDE-FAERS.html": page(["2026q2", "2026q1"]),
    [`${base}faers_ascii_2026q2.zip`]: zip({ "ASCII/DEMO26Q2.txt": q2 }), [`${base}faers_ascii_2026q1.zip`]: zip({ "ASCII/DEMO26Q1.txt": q1 }) };
  // pass 1: newest quarter (2026q2, nothing of ours inside it), pass 2: 2026q1 across both files
  await B.checkFaers(db, catalog, ctxWith(files));
  const c2 = ctxWith(files);
  await B.checkFaers(db, catalog, c2);
  assert.equal(c2.rows.length, 1);
  assert.equal(c2.rows[0].our_value.quarter, "2026Q1");
  assert.deepEqual(c2.rows[0].upstream_value.files, ["faers_ascii_2026q1.zip", "faers_ascii_2026q2.zip"]);
  assert.deepEqual(c2.rows[0].upstream_value.weeks, { "2026-01-05": 3 });
  assert.equal(c2.rows[0].agreement, "agree");
  // nothing due until a newer file appears; then 2026q3 first, and the older quarters again after it
  const c3 = ctxWith(files);
  await B.checkFaers(db, catalog, c3);
  assert.equal(c3.rows.length, 0);
  const files3 = { ...files, "https://fis.fda.gov/extensions/FPD-QDE-FAERS/FPD-QDE-FAERS.html": page(["2026q3", "2026q2", "2026q1"]),
    [`${base}faers_ascii_2026q3.zip`]: zip({ "ASCII/DEMO26Q3.txt": head + "\n" }) };
  await B.checkFaers(db, catalog, ctxWith(files3)); // 2026q3
  await B.checkFaers(db, catalog, ctxWith(files3)); // 2026q2 again
  const c4 = ctxWith(files3);
  await B.checkFaers(db, catalog, c4); // 2026q1 again, now across three files
  assert.deepEqual(c4.rows[0].upstream_value.files, ["faers_ascii_2026q1.zip", "faers_ascii_2026q2.zip", "faers_ascii_2026q3.zip"]);
});

test("P5: AACT counts per company against our ClinicalTrials.gov series; active snapshot at most a day old; once a day", async () => {
  const pg = require("../lib/pg");
  const real = pg.query;
  const calls = [];
  pg.query = async (cfg, sqls) => {
    calls.push({ cfg, sqls });
    const out = sqls.map((sql) => {
      if (/count\(\*\) n FROM ctgov.studies st JOIN .* WHERE upper\(st.overall_status\) IN \('RECRUITING'/.test(sql) && !/GROUP BY/.test(sql)) return [{ n: /Pfizer/.test(sql) ? "255" : "212" }];
      if (/start_date_type/.test(sql)) return [{ m: "2026-08-01", n: "8" }, { m: "2026-09-01", n: /Pfizer/.test(sql) ? "6" : "5" }];
      return [];
    });
    out.certExpired = true;
    return out;
  };
  try {
    const db = fresh();
    obs(db, "ctgov:PFE:trial_starts_monthly", "2026-08-01", 8);
    obs(db, "ctgov:PFE:trial_starts_monthly", "2026-09-01", 6);
    obs(db, "ctgov:PFE:trial_starts_monthly", "2026-10-01", 1); // current month: never compared
    obs(db, "ctgov:PFE:active_trials", "2026-10-18", 255); // yesterday's snapshot (NOW is 2026-10-19): compared
    obs(db, "ctgov:JNJ:trial_starts_monthly", "2026-08-01", 8);
    obs(db, "ctgov:JNJ:trial_starts_monthly", "2026-09-01", 6);
    obs(db, "ctgov:JNJ:active_trials", "2026-10-17", 222); // two days old: not compared
    const none = ctxWith({});
    await B.checkAact(db, catalog, none);
    assert.equal(calls.length, 0, "no credentials: skipped");
    const ctx = ctxWith({});
    ctx.env = { AACT_USER: "u", AACT_PASSWORD: "p" };
    await B.checkAact(db, catalog, ctx);
    assert.equal(calls[0].cfg.allowExpiredCertificate, true);
    assert.equal(calls[0].cfg.host, "aact-db.ctti-clinicaltrials.org");
    const by = Object.fromEntries(ctx.rows.map((r) => [r.field, r]));
    const pfe = by["series:ctgov:PFE:trial_starts_monthly"];
    assert.equal(pfe.agreement, "agree");
    assert.deepEqual(Object.keys(pfe.our_value.months), ["2026-08-01", "2026-09-01"]);
    assert.equal(pfe.our_value.comparison_transport, "aact_tls_certificate_expired_accepted");
    assert.equal(pfe.observed_at, "2026-09-01T00:00:00Z");
    assert.equal(by["series:ctgov:PFE:active_trials"].agreement, "agree");
    assert.equal(by["series:ctgov:JNJ:trial_starts_monthly"].agreement, "partial", "14 vs 13: within 10%");
    assert.equal(by["series:ctgov:JNJ:active_trials"], undefined);
    assert.ok(ctx.rows.every((r) => r.upstream_service === "aact"));
    const again = ctxWith({});
    again.env = ctx.env;
    const n = calls.length;
    await B.checkAact(db, catalog, again);
    assert.equal(calls.length, n, "once a day");
  } finally {
    pg.query = real;
  }
});
