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
