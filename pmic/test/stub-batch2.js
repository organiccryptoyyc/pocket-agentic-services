// Test-only upstream stub for the batch 2 sources, in each API's documented response shape:
// ECB SDMX csvdata, FDIC BankFind {data:[{data:{}}]}, CFPB Elasticsearch-style hits and
// aggregations, Wikimedia items, ClinicalTrials.gov v2 studies with nextPageToken, CPSC and NHTSA
// arrays, OpenFEC pagination, Senate LDA {count}, USAspending results, the Pink Sheet page and
// an .xlsx workbook built here, and SEC Form 4 XML. Shapes come from the published docs; this build
// container cannot reach the hosts, so the live check is bin/probe.js on the Pi.
"use strict";

const zlib = require("zlib");

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const wave = (i, base, amp = 0.2) => Math.max(0, Math.round(base * (1 + amp * Math.sin(i / 4))));

// Minimal zip writer (deflate) for the test workbook; CRCs are zero because the reader ignores them.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text, "utf8"));
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function pinkSheetXlsx(now) {
  const shared = ["World Bank Commodity Price Data (The Pink Sheet)", "Crude oil, average", "Gold", "Silver", "Platinum", "($/troy oz)"];
  const rows = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
    `<row r="5"><c r="A5"/><c r="B5" t="s"><v>1</v></c><c r="C5" t="s"><v>2</v></c><c r="D5" t="s"><v>4</v></c><c r="E5" t="inlineStr"><is><t>Silver</t></is></c></row>`,
    `<row r="6"><c r="C6" t="s"><v>5</v></c></row>`,
  ];
  let r = 7;
  for (let y = 2022; y <= now.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      if (Date.UTC(y, m - 1, 1) > now.getTime() - 35 * DAY) continue;
      const i = r;
      rows.push(`<row r="${r}"><c r="A${r}" t="str"><v>${y}M${String(m).padStart(2, "0")}</v></c><c r="B${r}"><v>${(75 + Math.sin(i)).toFixed(2)}</v></c><c r="C${r}"><v>${(2000 + 10 * i).toFixed(2)}</v></c><c r="D${r}"><v>${(950 + Math.sin(i) * 20).toFixed(2)}</v></c><c r="E${r}"><v>${(24 + Math.cos(i)).toFixed(3)}</v></c></row>`);
      r++;
    }
  }
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="AFOSHEET" sheetId="1" r:id="rId1"/><sheet name="Monthly Prices" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>other</t></is></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`,
  });
}

function form4Xml(n) {
  const code = n % 3 === 0 ? "P" : "S";
  return `<?xml version="1.0"?><ownershipDocument><issuer><issuerCik>0000320193</issuerCik></issuer><nonDerivativeTable>` +
    `<nonDerivativeTransaction><transactionDate><value>2026-01-02</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>` +
    `<transactionAmounts><transactionShares><value>${100 * (n % 7 + 1)}</value></transactionShares><transactionPricePerShare><value>150.25</value><footnoteId id="F1"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === "P" ? "A" : "D"}</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>` +
    `<nonDerivativeTransaction><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>5000</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>` +
    `</nonDerivativeTable></ownershipDocument>`;
}

// Returns a response for batch 2 hosts, or null when the URL isn't one of them.
function batch2(u, init, now, json) {
  const text = (t, type = "text/plain", status = 200) => ({ status, ok: status < 300, text: t, contentType: type });

  if (u.host === "data-api.ecb.europa.eu") {
    const [, , , flow, key] = u.pathname.split("/");
    const since = u.searchParams.get("startPeriod");
    const monthly = key.startsWith("M.");
    const lines = ["KEY,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE"];
    let i = 0;
    for (let t = Date.parse(`${since}T00:00:00Z`); t < now.getTime() - DAY; t += monthly ? 30 * DAY : DAY) {
      const d = new Date(t);
      if (!monthly && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
      const p = monthly ? ymd(t).slice(0, 7) : ymd(t);
      const v = flow === "EXR" ? 1.1 + 0.02 * Math.sin(i / 20) : 2 + 0.5 * Math.sin(i / 60);
      lines.push(`${flow}.${key},${monthly ? "M" : "D"},U2,${p},${v.toFixed(4)},A,"${flow} series, test"`);
      i++;
    }
    return text(lines.join("\n") + "\n", "text/csv");
  }
  if (u.host === "api.fdic.gov") {
    const data = [];
    for (let k = 0; k < 30; k++) {
      const d = new Date(now.getTime() - (20 + k * 120) * DAY);
      data.push({ data: { CERT: 10000 + k, NAME: `Test Bank ${k}`, CITYST: "TOWN, ST", FAILDATE: `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`, QBFASSET: 50000 * (k + 1), QBFDEP: 40000 * (k + 1), COST: 9000, RESTYPE1: "PA" }, score: 0 });
    }
    return json({ meta: { total: data.length, parameters: {} }, data, totals: { count: data.length } });
  }
  if (u.host === "www.consumerfinance.gov") {
    const min = u.searchParams.get("date_received_min");
    const i = Number(min.slice(5, 7)) + Number(min.slice(0, 4)) * 12;
    const buckets = [["Credit reporting or other personal consumer reports", 90000], ["Credit card", 6000], ["Mortgage", 3000], ["Checking or savings account", 4000], ["Debt collection", 7000]].map(([key, n]) => ({ key, doc_count: wave(i, n) }));
    const total = buckets.reduce((a, b) => a + b.doc_count, 0);
    return json({ _meta: { total_record_count: 5000000 }, hits: { total: { value: Math.min(total, 10000), relation: "gte" }, hits: [{ _source: {} }] }, aggregations: { product: { doc_count: total, product: { doc_count_error_upper_bound: 0, buckets } } } });
  }
  if (u.host === "wikimedia.org") {
    const parts = u.pathname.split("/");
    const start = parts[parts.length - 2].slice(0, 8);
    const from = Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
    if (u.pathname.includes("/pageviews/")) {
      const items = [];
      for (let t = from, i = 0; t < now.getTime() - DAY; t += DAY, i++) items.push({ project: "en.wikipedia", article: parts[8], granularity: "daily", timestamp: `${ymd(t).replace(/-/g, "")}00`, access: "all-access", agent: "user", views: wave(i, 5000) });
      return json({ items });
    }
    const results = [];
    for (let t = from, i = 0; t < now.getTime() - DAY; t += DAY, i++) if (i % 3 === 0) results.push({ timestamp: `${ymd(t)}T00:00:00.000Z`, edits: wave(i, 4) });
    return json({ items: [{ project: "en.wikipedia", "page-title": parts[6], "editor-type": "all-editor-types", granularity: "daily", results }] });
  }
  if (u.host === "clinicaltrials.gov") {
    const sponsor = u.searchParams.get("query.lead");
    const page = u.searchParams.get("pageToken") ? 1 : 0;
    const statuses = ["RECRUITING", "COMPLETED", "TERMINATED", "ACTIVE_NOT_RECRUITING", "WITHDRAWN", "NOT_YET_RECRUITING"];
    const studies = [];
    for (let k = 0; k < 120; k++) {
      const n = page * 1000 + k;
      const start = ymd(now.getTime() - (10 + n * 7) * DAY);
      studies.push({ protocolSection: {
        identificationModule: { nctId: `NCT${String(sponsor.length * 100000 + n).padStart(8, "0")}`, briefTitle: `Study ${n} of ${sponsor}` },
        statusModule: { overallStatus: statuses[n % statuses.length], startDateStruct: { date: n % 2 ? start.slice(0, 7) : start, type: n % 5 === 4 ? "ESTIMATED" : "ACTUAL" }, completionDateStruct: { date: ymd(now.getTime() - n * 5 * DAY), type: n % 6 === 1 ? "ACTUAL" : "ESTIMATED" }, lastUpdatePostDateStruct: { date: ymd(now.getTime() - (n % 300) * DAY), type: "ACTUAL" } },
        designModule: { phases: [n % 4 === 0 ? "PHASE3" : "PHASE2"] },
      } });
    }
    return json({ studies, ...(page === 0 ? { nextPageToken: "NEXT" } : {}) });
  }
  if (u.host === "www.saferproducts.gov") {
    const out = [];
    for (let k = 0; k < 250; k++) {
      const d = ymd(now.getTime() - (2 + k * 1.6) * DAY);
      out.push({ RecallID: 9000 + k, RecallNumber: `26${String(k).padStart(3, "0")}`, RecallDate: `${d}T00:00:00`, Title: `Test product ${k} recalled due to fall hazard`, URL: `https://www.cpsc.gov/Recalls/2026/test-${k}`, Products: [{ Name: `Product ${k}`, NumberOfUnits: k % 10 === 0 ? "About 1.2 million" : `About ${(k + 1) * 100} (in addition, about 50 in Canada)` }], Hazards: [{ Name: "Fall hazard" }], Injuries: k === 3 ? [{ Name: "One death reported" }] : [] });
    }
    return json(out);
  }
  if (u.host === "data.transportation.gov") {
    const offset = Number(u.searchParams.get("$offset") || 0);
    if (offset > 0) return json([]);
    const out = [];
    for (let k = 0; k < 900; k++) {
      out.push({ report_received_date: `${ymd(now.getTime() - (1 + k * 0.45) * DAY)}T00:00:00.000`, nhtsa_id: `26V${String(k).padStart(3, "0")}`, manufacturer: `Maker ${k % 9}`, subject: `Test recall ${k}`, component: "BRAKES", potentially_affected: String(k % 50 === 0 ? 250000 : 500 + k), recall_type: "Vehicle", do_not_drive_advisory: k === 7 ? "Yes" : "No" });
    }
    return json(out);
  }
  if (u.host === "api.open.fec.gov") {
    const m = u.searchParams.get("min_date");
    return json({ api_version: "1.0", pagination: { per_page: 1, count: wave(Number(m.slice(5, 7)), 4000, 0.5), pages: 4000, last_indexes: {} }, results: [{}] });
  }
  if (u.host === "lda.senate.gov") {
    const m = u.searchParams.get("filing_dt_posted_after");
    return json({ count: wave(Number(m.slice(5, 7)), u.searchParams.get("filing_type") ? 300 : 9000), next: "https://lda.senate.gov/api/v1/filings/?page=2", previous: null, results: [{}] });
  }
  if (u.host === "api.usaspending.gov") {
    const body = JSON.parse(init.body);
    if (u.pathname.includes("spending_over_time")) {
      const results = [];
      for (let fy = 2023; fy <= 2027; fy++) for (let fm = 1; fm <= 12; fm++) results.push({ time_period: { fiscal_year: String(fy), month: String(fm) }, aggregated_amount: 300e9 + fm * 1e9 + fy * 1e6, Contract_Obligations: 1 });
      return json({ group: body.group, results, messages: [] });
    }
    const m = body.filters.time_period[0].start_date;
    const names = ["Department of Defense", "Department of Health and Human Services", "Department of Veterans Affairs", "Department of Homeland Security", "Department of Energy", "Department of Transportation", "Department of Education", "Department of Agriculture", "Small Business Administration"];
    return json({ category: "awarding_agency", limit: 50, page_metadata: { page: 1, hasNext: false }, results: names.map((name, k) => ({ amount: (k + 1) * 1e9 + Number(m.slice(5, 7)) * 1e7, name, code: String(k), id: k })) });
  }
  if (u.host === "www.worldbank.org") return text(`<html><a href="https://thedocs.worldbank.org/en/doc/test-0090012026/related/CMO-Historical-Data-Monthly.xlsx">Monthly prices</a></html>`, "text/html");
  if (u.host === "thedocs.worldbank.org") return { status: 200, ok: true, text: init.binary ? pinkSheetXlsx(now).toString("base64") : "binary", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  if (u.host === "www.sec.gov" && /\/Archives\/edgar\/data\/\d+\/\d+\/\d+\.xml$/.test(u.pathname)) {
    const n = Number(/(\d+)\.xml$/.exec(u.pathname)[1]);
    return text(form4Xml(n), "application/xml");
  }
  return null;
}

module.exports = { batch2, pinkSheetXlsx, form4Xml, zip };
