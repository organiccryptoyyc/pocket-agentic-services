// Test-only upstream stub for the batch 4 sources, in each API's response shape as seen live on
// 2026-10-04: the Pocket indexer's GraphQL aliases, DefiLlama chart arrays, ArcGIS statistics,
// NOAA Climate at a Glance {data}, the TSA passenger table, IMF
// SDMX XML, Federal Register {count}, data.cms.gov rows and SEC fails-to-deliver zips.
"use strict";

const { zip } = require("./stub-batch2");

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Months from Jan of `fromYear` up to (not including) the month of `now`.
function monthsSince(fromYear, now) {
  const out = [];
  for (let y = fromYear; y <= now.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === now.getUTCFullYear() && m > now.getUTCMonth()) break;
      out.push({ y, m });
    }
  }
  return out;
}

function ftdText(ym, half, now) {
  const lines = ["SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE"];
  const days = half === "a" ? [2, 9] : [17, 24];
  for (const d of days) {
    for (const sym of ["AAPL", "MSFT", "NVDA", "AMZN", "WMT", "JPM", "BAC", "XOM", "PFE", "LLY", "JNJ", "UNH", "NFLX", "DIS", "ZZZZ"]) {
      const q = 1000 + (hash(sym + ym + d) % 50000);
      lines.push(`${ym}${String(d).padStart(2, "0")}|000000000|${sym}|${q}|${sym} INC COM|${(50 + (hash(sym) % 400)).toFixed(2)}`);
    }
  }
  lines.push(`${ym}30|000000000|AAPL|.|APPLE INC|.`, "Trailer record count 61");
  return lines.join("\n") + "\n";
}

function batch4(u, init, now, json) {
  const t = now.getTime();
  if (u.host === "data.pocket.network") {
    const q = JSON.parse(init.body).query;
    const data = {};
    for (const m of q.matchAll(/(w|l)(\d+): blocks\(filter:\{timestamp:\{(?:greaterThanOrEqualTo:"([^"]+)",)?lessThan:"([^"]+)"/g)) {
      const k = Number(m[2]);
      const end = Date.parse(m[4] + "Z");
      const wk = Math.round((t - end) / (7 * DAY));
      if (m[1] === "w") data[`w${k}`] = { aggregates: { sum: { totalEstimatedRelays: String(Math.round(1e10 * (1 + 0.1 * Math.sin(wk / 4)))), totalRelays: String(Math.round(9e6 * (1 + 0.1 * Math.cos(wk / 4)))) } } };
      else data[`l${k}`] = { nodes: [{ stakedSuppliers: 4400 + (wk % 50), stakedApps: 30 + (wk % 5) }] };
    }
    return json({ data });
  }
  if (u.host === "stablecoins.llama.fi" || u.host === "api.llama.fi") {
    const rows = [];
    for (let k = 800; k >= 0; k--) {
      const date = Math.floor((t - k * DAY) / DAY) * 86400;
      const v = (u.host === "api.llama.fi" ? 9e10 : 3e11) * (1 + 0.05 * Math.sin(k / 30));
      rows.push(u.host === "api.llama.fi" ? { date, tvl: v } : { date: String(date), totalCirculating: { peggedUSD: v }, totalCirculatingUSD: { peggedUSD: v } });
    }
    return json(rows);
  }
  if (u.host === "services3.arcgis.com") {
    const where = u.searchParams.get("where") || "";
    const m = /date '(\d{4}-\d{2})/.exec(where);
    const month = m ? Number(m[1].slice(5, 7)) : 1;
    const season = 1 + Math.sin(((month - 4) / 12) * 2 * Math.PI);
    return json({ features: [{ attributes: { n: Math.round(1000 + 2000 * season), acres: 50000 + 200000 * season + 0.37 } }] });
  }
  if (u.host === "www.ncei.noaa.gov") {
    const elem = /\/110\/(\w+)\//.exec(u.pathname)[1];
    const data = {};
    for (const { y, m } of monthsSince(2018, now)) {
      const i = y * 12 + m;
      data[`${y}${String(m).padStart(2, "0")}`] = { value: 55 + 20 * Math.sin(i / 2), anomaly: 0, departure: Number(((elem === "pcp" ? 0.4 : 2) * Math.sin(i / 3.3)).toFixed(2)) };
    }
    return json({ description: { title: "Contiguous U.S.", units: elem === "pcp" ? "Inches" : "Degrees Fahrenheit", base_period: "1991-2020" }, data });
  }
  if (u.host === "www.tsa.gov") {
    const yr = /\/(\d{4})$/.exec(u.pathname);
    const year = yr ? Number(yr[1]) : now.getUTCFullYear();
    const rows = [];
    for (let d = Date.UTC(year, 11, 31); d >= Date.UTC(year, 0, 1); d -= DAY) {
      if (d >= t - 3 * DAY) continue; // TSA posts a few days behind
      const x = new Date(d);
      rows.push(`<tr><td class="views-field">${x.getUTCMonth() + 1}/${x.getUTCDate()}/${year}</td><td class="views-field">${(2400000 + (hash(d) % 400000)).toLocaleString("en-US")}</td></tr>`);
    }
    return { status: 200, ok: true, text: `<html><table><thead><tr><th>Date</th><th>Numbers</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></html>`, contentType: "text/html" };
  }
  if (u.host === "api.imf.org") {
    const [countries, indicator] = u.pathname.split("/").pop().split(".");
    const series = countries.split("+").map((c) => {
      const obs = [];
      for (let y = 2000; y <= now.getUTCFullYear() + 5; y++) obs.push(`<Obs TIME_PERIOD="${y}" OBS_VALUE="${(2 + (hash(c + indicator + y) % 600) / 100).toFixed(3)}"/>`);
      return `<Series COUNTRY="${c}" INDICATOR="${indicator}" FREQUENCY="A" SCALE="0">${obs.join("")}</Series>`;
    });
    return { status: 200, ok: true, text: `<?xml version="1.0"?><message:StructureSpecificData><message:DataSet>${series.join("")}</message:DataSet></message:StructureSpecificData>`, contentType: "application/xml" };
  }
  if (u.host === "www.federalregister.gov") {
    if (u.searchParams.get("per_page") === "50") {
      return json({ count: 2, results: [
        { document_number: "2026-19001", title: "Example Significant Rule on Emissions", publication_date: ymd(t - 5 * DAY), agencies: [{ name: "Environmental Protection Agency" }], html_url: "https://www.federalregister.gov/documents/2026/09/29/2026-19001/example" },
        { document_number: "2026-18002", title: "Example Health Coverage Rule", publication_date: ymd(t - 12 * DAY), agencies: [{ name: "Health and Human Services Department" }], html_url: "https://www.federalregister.gov/documents/2026/09/22/2026-18002/example" },
      ] });
    }
    const q = decodeURIComponent(u.search);
    const base = /significant/.test(q) ? 25 : /PRORULE/.test(q) ? 160 : 230;
    return json({ count: base + (hash(q) % 40), total_pages: 1, results: [{ document_number: "x" }] });
  }
  if (u.host === "data.cms.gov") {
    const offset = Number(u.searchParams.get("offset") || 0);
    if (offset > 0) return json([]);
    const rows = [];
    let i = 0;
    for (const { y, m } of monthsSince(2013, now)) {
      if (y === now.getUTCFullYear() && m > now.getUTCMonth() - 3) break; // CMS lags about 3 months
      const total = Math.round(52e6 * (1 + 0.025 * i / 12));
      const ma = Math.round(total * (0.3 + 0.002 * i));
      rows.push({ YEAR: String(y), MONTH: MONTHS[m - 1], BENE_GEO_LVL: "National", BENE_STATE_ABRVTN: "US", TOT_BENES: String(total), ORGNL_MDCR_BENES: String(total - ma), MA_AND_OTH_BENES: String(ma) });
      if (m === 12) rows.push({ YEAR: String(y), MONTH: "Year", BENE_GEO_LVL: "National", BENE_STATE_ABRVTN: "US", TOT_BENES: String(total), ORGNL_MDCR_BENES: "*", MA_AND_OTH_BENES: "*" });
      i++;
    }
    return json(rows);
  }
  if (u.host === "www.sec.gov" && u.pathname.startsWith("/files/data/fails-deliver-data/")) {
    const m = /cnsfails(\d{6})([ab])\.zip$/.exec(u.pathname);
    // The current month's second half is not out yet; the "b" file appears after month end.
    const ym = m[1];
    const cur = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    if (ym >= cur) return { status: 404, ok: false, text: "Not Found" };
    return { status: 200, ok: true, text: init.binary ? zip({ [`cnsfails${ym}${m[2]}.txt`]: ftdText(ym, m[2], now) }).toString("base64") : "binary", contentType: "application/zip" };
  }
  return batch4b(u, init, now, json);
}

// The second half of batch 4: release calendars, OECD, FDA warning letters, Congress.gov, EPA
// ECHO, IRS Form 990 extracts and SEC 13F data sets.
const CUSIPS = { AAPL: "037833100", MSFT: "594918104", NVDA: "67066G104", AMZN: "023135106", WMT: "931142103", JPM: "46625H100", BAC: "060505104", XOM: "30231G102", PFE: "717081103", LLY: "532457108", JNJ: "478160104", UNH: "91324P102", NFLX: "64110L106", DIS: "254687106" };
const MON3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const ics = (t) => new Date(t).toISOString().replace(/[-:]/g, "").slice(0, 15);

function icsFeed(agency, now) {
  const t = now.getTime();
  const ev = [];
  const titles = agency === "bls" ? ["Employment Situation", "Consumer Price Index", "Real Earnings", "State Employment and Unemployment (Monthly)"] : ["Gross Domestic Product\\, 3rd Quarter 2026 (Advance Estimate)", "Personal Income and Outlays\\, September 2026", "U.S. International Trade in Goods and Services\\, August 2026"];
  for (let k = -60; k <= 80; k += 4) {
    const when = t + k * DAY;
    const title = titles[(k + 60) / 4 % titles.length];
    if (agency === "bls") ev.push(["BEGIN:VEVENT", `UID:bls-${k}`, `DTSTART;TZID=US-Eastern:${ics(when).slice(0, 8)}T083000`, "DURATION:PT0M", `SUMMARY:${title}`, "END:VEVENT"].join("\r\n"));
    else ev.push(["BEGIN:VEVENT", `SUMMARY:${title.slice(0, 40)}`, ` ${title.slice(40)}`, `DTSTART;VALUE=DATE-TIME:${ics(when).slice(0, 8)}T123000Z`, `UID:bea-${k}`, "END:VEVENT"].join("\r\n"));
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

function f13Zip(name, now) {
  // Window 01jun2026-31aug2026 -> report period 30-JUN-2026; one late filer for March.
  const m = /(\d{2})([a-z]{3})(\d{4})-/.exec(name);
  const startMonth = MON3.indexOf(m[2].toUpperCase());
  const y = Number(m[3]);
  const qEndMonth = startMonth - ((startMonth + 1) % 3); // jun -> jun, jan -> previous dec
  const pe = new Date(Date.UTC(y, qEndMonth + 1, 0));
  const period = `${String(pe.getUTCDate()).padStart(2, "0")}-${MON3[pe.getUTCMonth()]}-${pe.getUTCFullYear()}`;
  const sub = ["ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT"];
  const info = ["ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tFIGI\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL\tINVESTMENTDISCRETION\tOTHERMANAGER\tVOTING_AUTH_SOLE\tVOTING_AUTH_SHARED\tVOTING_AUTH_NONE"];
  const filers = 300 + (hash(name) % 40);
  for (let f = 0; f < filers; f++) {
    const acc = `000${f}-${y}-${name.slice(0, 5)}`;
    sub.push(`${acc}\t15-JUL-${y}\t13F-HR\t000${f}\t${period}`);
    for (const [sym, cusip] of Object.entries(CUSIPS)) {
      if ((f + hash(sym)) % 3 === 0) continue;
      info.push(`${acc}\t${f}\t${sym} INC\tCOM\t${cusip}\t\t${1000 * (f + 1)}\t${10 * (f + 1)}\tSH\t\tSOLE\t0\t0\t0\t0`);
      if (f % 10 === 0) info.push(`${acc}\t${f}\t${sym} INC\tCALL\t${cusip}\t\t999999\t100\tSH\tCall\tSOLE\t0\t0\t0\t0`);
    }
  }
  sub.push(`9999-${y}-late\t15-JUL-${y}\t13F-HR\t0009999\t31-MAR-${y}`, `8888-${y}-nt\t15-JUL-${y}\t13F-NT\t0008888\t${period}`);
  info.push(`9999-${y}-late\t1\tAPPLE INC\tCOM\t037833100\t\t5\t5\tSH\t\tSOLE\t0\t0\t0\t0`);
  const dir = name.replace(/_form13f\.zip$/, "_form13f").toUpperCase();
  return zip({ [`${dir}/SUBMISSION.tsv`]: sub.join("\n") + "\n", [`${dir}/INFOTABLE.tsv`]: info.join("\n") + "\n", [`${dir}/COVERPAGE.tsv`]: "ACCESSION_NUMBER\n" });
}

function f13Listing(now) {
  const links = [];
  const ends = [["01jun2026-31aug2026", "datastandardsinnovation"], ["01mar2026-31may2026", "structureddata"], ["01dec2025-28feb2026", "structureddata"], ["01sep2025-30nov2025", "structureddata"], ["01jun2025-31aug2025", "structureddata"], ["01mar2025-31may2025", "structureddata"], ["01dec2024-28feb2025", "structureddata"], ["01sep2024-30nov2024", "structureddata"], ["01jun2024-31aug2024", "structureddata"], ["01mar2024-31may2024", "structureddata"], ["01jan2024-29feb2024", "structureddata"]];
  for (const [w, dir] of ends) links.push(`<a href="/files/${dir}/data/form-13f-data-sets/${w}_form13f.zip">${w}</a>`);
  links.push('<a href="/files/structureddata/data/form-13f-data-sets/2023q4_form13f.zip">2023 Q4</a>');
  return `<html><body>${links.join("\n")}</body></html>`;
}

function irsCsv(yy) {
  const cols = ["efile", "EIN", "tax_pd", "subseccd", "totrevenue", "totcntrbgfts", "totfuncexpns", "totassetsend"];
  const lines = [cols.join(",")];
  const n = 2000 + Number(yy) * 10;
  for (let i = 0; i < n; i++) lines.push(["Y", String(100000000 + i), `20${yy}06`, "3", 1000000 + i * Number(yy), 400000 + i, 900000 + i, 3000000 + i * 2].join(","));
  return lines.join("\n") + "\n";
}

function batch4b(u, init, now, json) {
  const t = now.getTime();
  if (u.host === "www.bls.gov" && u.pathname.endsWith(".ics")) return { status: 200, ok: true, text: icsFeed("bls", now), contentType: "text/calendar" };
  if (u.host === "www.bea.gov" && u.pathname.endsWith(".ics")) return { status: 200, ok: true, text: icsFeed("bea", now), contentType: "text/calendar" };
  if (u.host === "sdmx.oecd.org") {
    const key = u.pathname.split("/").pop();
    const lines = ["DATAFLOW,REF_AREA,FREQ,MEASURE,UNIT_MEASURE,ACTIVITY,ADJUSTMENT,TRANSFORMATION,TIME_HORIZ,METHODOLOGY,TIME_PERIOD,OBS_VALUE,OBS_STATUS,UNIT_MULT,DECIMALS,BASE_PER"];
    for (const c of key.split(".")[0].split("+")) {
      for (const { y, m } of monthsSince(2023, now)) {
        if (y === now.getUTCFullYear() && m > now.getUTCMonth() - 1) continue; // about two months behind
        const v = (100 + 1.5 * Math.sin((y * 12 + m) / 6 + hash(c) % 7)).toFixed(4);
        lines.push(`OECD.SDD.STES:DSD_STES@DF_CLI(4.1),${c},M,LI,IX,_Z,AA,IX,_Z,H,${y}-${String(m).padStart(2, "0")},${v},A,0,2,`);
        lines.push(`OECD.SDD.STES:DSD_STES@DF_CLI(4.1),${c},M,LI,IX,_Z,NOR,IX,_Z,H,${y}-${String(m).padStart(2, "0")},1.0,A,0,2,`);
      }
    }
    return { status: 200, ok: true, text: lines.join("\n") + "\n", contentType: "application/vnd.sdmx.data+csv" };
  }
  if (u.host === "www.fda.gov" && u.pathname === "/datatables/views/ajax") {
    const start = Number(u.searchParams.get("start") || 0);
    const length = Number(u.searchParams.get("length") || 10);
    const offices = ["Center for Drug Evaluation and Research (CDER)", "Center for Devices and Radiological Health", "Center for Tobacco Products", "Human Foods Program", "Center for Biologics Evaluation and Research (CBER)"];
    const all = [];
    for (let k = 0; k < 1300; k++) {
      const posted = new Date(t - (1 + k * 0.6) * DAY);
      const d = ymd(posted.getTime());
      const us = `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
      const company = k === 5 ? "Pfizer Inc." : `Company ${k} LLC`;
      all.push([`<time datetime="${d}T04:00:00Z">${us}</time>\n`, `<time datetime="${d}T04:00:00Z">${us}</time>\n`, `<a href="/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/company-${k}">${company}</a>`, offices[k % offices.length], k % 2 ? "CGMP/Finished Pharmaceuticals/Adulterated" : "Misbranded", "", "", ""]);
    }
    return json({ draw: 1, recordsTotal: all.length, recordsFiltered: all.length, data: all.slice(start, start + length) });
  }
  if (u.host === "api.congress.gov") {
    const offset = Number(u.searchParams.get("offset") || 0);
    const parts = u.pathname.split("/"); // /v3/bill/119/hr or /v3/law/119
    const congress = Number(parts[3]);
    const startYear = 1789 + 2 * (congress - 1);
    if (parts[2] === "law") {
      const bills = [];
      for (let k = 0; k < 60; k++) {
        const d = ymd(Math.min(t - 2 * DAY, Date.UTC(startYear, 0, 20) + k * 12 * DAY));
        bills.push({ congress, latestAction: { actionDate: d, text: `Became Public Law No: ${congress}-${k + 1}.` }, laws: [{ number: `${congress}-${k + 1}`, type: "Public Law" }], number: String(100 + k), title: `Example Act ${k}`, type: k % 2 ? "S" : "HR" });
      }
      return json({ bills: bills.slice(offset, offset + 250), pagination: { count: bills.length } });
    }
    const type = parts[4];
    const n = type === "hr" ? 700 : 400;
    const bills = [];
    for (let k = 0; k < n; k++) {
      const d = Date.UTC(startYear, 0, 3) + k * (700 / n) * DAY;
      if (d >= t) break;
      bills.push({ congress, introducedDate: ymd(d), number: String(k + 1), type: type.toUpperCase(), title: `Bill ${k}` });
    }
    return json({ bills: bills.slice(offset, offset + 250), pagination: { count: bills.length } });
  }
  if (u.host === "echodata.epa.gov") {
    if (u.pathname.endsWith(".get_cases")) {
      const from = u.searchParams.get("p_from_date") || "01/01/2026";
      const h = hash(from);
      const pen = u.searchParams.get("p_fed_penalty") === "ANY";
      const rows = pen ? 150 + (h % 60) : 1400 + (h % 300);
      return json({ Results: { Message: "Success", QueryRows: String(rows), JDCRows: String(20 + (h % 15)), AFRRows: String(rows - 20), FedPenRows: String(150 + (h % 60)), QueryID: `${pen ? "P" : "A"}${from.replace(/\//g, "")}` } });
    }
    if (u.pathname.endsWith(".get_qid")) {
      const qid = u.searchParams.get("qid");
      const page = Number(u.searchParams.get("pageno") || 1);
      const mm = qid.slice(1, 3);
      const yyyy = qid.slice(5, 9);
      const cases = [];
      if (page === 1) {
        for (let k = 0; k < 180; k++) cases.push({ CaseNumber: `0${k}-${yyyy}`, CaseName: `FACILITY ${k}`, SettlementDate: k % 5 === 0 ? "11/10/2016" : `${mm}/${String(1 + (k % 28)).padStart(2, "0")}/${yyyy}`, FedPenalty: `$${(1000 + k * 37).toLocaleString("en-US")}.00` });
      }
      return json({ Results: { Message: "Working", QueryRows: "180", QueryID: qid, PageNo: String(page), Cases: cases } });
    }
  }
  if (u.host === "www.irs.gov") {
    const m = /\/(\d{2})eoextract990\.zip$/.exec(u.pathname);
    if (!m || Number(m[1]) > 24) return { status: 404, ok: false, text: "Not Found" };
    return { status: 200, ok: true, text: init.binary ? zip({ [`${m[1]}eoextract990.csv`]: irsCsv(m[1]) }).toString("base64") : "binary", contentType: "application/zip" };
  }
  if (u.host === "www.sec.gov" && u.pathname === "/data-research/sec-markets-data/form-13f-data-sets") {
    return { status: 200, ok: true, text: f13Listing(now), contentType: "text/html" };
  }
  if (u.host === "www.sec.gov" && /_form13f\.zip$/.test(u.pathname)) {
    return { status: 200, ok: true, text: init.binary ? f13Zip(u.pathname.split("/").pop(), now).toString("base64") : "binary", contentType: "application/zip" };
  }
  return null;
}

module.exports = { batch4, ftdText };
