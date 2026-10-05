// Test-only upstream stub. Answers every source URL the adapters build with a deterministic
// payload in that API's documented response shape (field names, string-typed values, "."
// missing values, BLS footnotes, BEA thousands separators, SEC frames, openFDA NOT_FOUND, World
// Bank [meta, rows]). Shapes follow each API's published docs; they were not captured live from
// this build container, whose network policy blocks these hosts (see README "Verification").
"use strict";

const { batch2 } = require("./stub-batch2");
const { batch3 } = require("./stub-batch3");
const { batch4 } = require("./stub-batch4");

const DAY = 86400000;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

// Smooth deterministic path: base * (1 + drift*t + wiggle).
function val(key, i, base, drift = 0.002) {
  const ph = hash(key) * 6.28;
  return base * (1 + drift * i + 0.01 * Math.sin(i / 3 + ph));
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthly(fromYear, now) {
  const out = [];
  for (let y = fromYear; y <= now.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      const d = `${y}-${String(m).padStart(2, "0")}-01`;
      if (Date.parse(d) < now.getTime() - 40 * DAY) out.push(d);
    }
  }
  return out;
}

function daily(fromMs, now) {
  const out = [];
  for (let t = fromMs; t < now.getTime() - DAY; t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(ymd(t));
  }
  return out;
}

function weeklyDates(fromMs, now) {
  const out = [];
  for (let t = fromMs; t < now.getTime() - 3 * DAY; t += 7 * DAY) out.push(ymd(t));
  return out;
}

function quarterly(fromYear, now) {
  return monthly(fromYear, new Date(now.getTime() - 60 * DAY)).filter((d) => ["01", "04", "07", "10"].includes(d.slice(5, 7)));
}

const BASES = { percent: 4, percentage_points: 0.5, index: 300, thousands: 158000, usd_millions: 700000, usd_billions: 17000, usd_per_barrel: 75, usd_per_mmbtu: 3, usd_per_metric_ton: 9000, usd: 30 };

function makeFetch(catalog, opts = {}) {
  const now = opts.now || new Date("2026-10-04T06:00:00Z");
  const bump = opts.bump || {}; // series key -> multiplier on the latest value (to force revisions)
  const calls = [];
  const fredFreq = new Map(catalog.series.filter((s) => s.source_id === "fred").map((s) => [s.params.id, s]));
  const blsSeries = new Map(catalog.series.filter((s) => s.source_id === "bls").map((s) => [s.params.id, s]));

  function fredRows(id) {
    const s = fredFreq.get(id);
    const dates = s.frequency === "daily" ? daily(now.getTime() - 900 * DAY, now)
      : s.frequency === "weekly" ? weeklyDates(Date.parse("2024-01-03"), now)
      : s.frequency === "quarterly" ? quarterly(2016, now)
      : monthly(2023, now);
    const base = BASES[s.unit] || 100;
    return dates.map((d, i) => {
      let v = val(id, i, base);
      if (i === dates.length - 1 && bump[id]) v *= bump[id];
      // FRED marks holidays with "."; counts (business applications) are whole numbers.
      return { date: d, value: i % 97 === 5 ? "." : s.unit === "count" ? String(Math.round(v * 1000)) : v.toFixed(3) };
    });
  }

  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const u = new URL(url);
    const json = (obj, status = 200) => ({ status, ok: status < 300, text: JSON.stringify(obj), contentType: "application/json" });
    if (opts.fail && opts.fail(u)) return { status: 503, ok: false, text: "upstream unavailable", contentType: "text/plain" };

    if (u.host === "fred.stlouisfed.org") {
      const id = u.searchParams.get("id");
      if (!fredFreq.has(id)) return { status: 404, ok: false, text: "not found" };
      const header = opts.oldFredHeader ? "DATE" : "observation_date";
      const since = u.searchParams.get("cosd") || "0000";
      const rows = fredRows(id).filter((r) => r.date >= since);
      return { status: 200, ok: true, text: `${header},${id}\n${rows.map((r) => `${r.date},${r.value}`).join("\n")}\n`, contentType: "text/csv" };
    }
    if (u.host === "api.stlouisfed.org") {
      const id = u.searchParams.get("series_id");
      const since = u.searchParams.get("observation_start") || "0000";
      return json({ realtime_start: "2026-10-04", observations: fredRows(id).filter((r) => r.date >= since).map((r) => ({ realtime_start: "2026-10-04", realtime_end: "2026-10-04", ...r })) });
    }
    if (u.host === "api.bls.gov") {
      const body = JSON.parse(init.body);
      const series = body.seriesid.map((id) => {
        const s = blsSeries.get(id);
        const dates = monthly(Number(body.startyear), now);
        // BLS values for the series that cross-check against FRED mirror FRED's path when asked.
        // Otherwise twins are pushed 10% away from FRED so the cross-source check must fire.
        const fredTwin = { LNS14000000: "UNRATE", CES0000000001: "PAYEMS", JTS000000000000000JOL: "JTSJOL" }[id];
        const twinRows = fredTwin ? new Map(fredRows(fredTwin).map((r) => [r.date, opts.blsMirrorsFred ? r.value : r.value === "." ? "." : String(Number(r.value) * 1.1)])) : null;
        const data = dates.map((d, i) => {
          const v = twinRows && twinRows.get(d) && twinRows.get(d) !== "." ? Number(twinRows.get(d)) : val(id, i, BASES[s.unit] || 100);
          return {
            year: d.slice(0, 4),
            period: `M${d.slice(5, 7)}`,
            periodName: "Month",
            value: v.toFixed(1),
            footnotes: i === dates.length - 1 ? [{ code: "P", text: "preliminary" }] : [{}],
          };
        }).reverse();
        data.push({ year: body.startyear, period: "M13", periodName: "Annual", value: "1.0", footnotes: [{}] });
        return { seriesID: id, data };
      });
      return json({ status: "REQUEST_SUCCEEDED", responseTime: 120, message: [], Results: { series } });
    }
    if (u.host === "apps.bea.gov") {
      const ds = u.searchParams.get("datasetname");
      const qs = quarterly(2017, now);
      if (ds === "NIPA") {
        const Data = [];
        qs.forEach((d, i) => {
          const tp = `${d.slice(0, 4)}Q${(Number(d.slice(5, 7)) + 2) / 3}`;
          Data.push({ TableName: "T10101", SeriesCode: "A191RL", LineNumber: "1", LineDescription: "Gross domestic product", TimePeriod: tp, METRIC_NAME: "Fisher Quantity Index", CL_UNIT: "Percent change, annual rate", UNIT_MULT: "0", DataValue: (2 + Math.sin(i)).toFixed(1), NoteRef: "T10101" });
          Data.push({ TableName: "T10101", SeriesCode: "DPCERL", LineNumber: "2", LineDescription: "Personal consumption expenditures", TimePeriod: tp, CL_UNIT: "Percent change, annual rate", UNIT_MULT: "0", DataValue: "2.1", NoteRef: "T10101" });
        });
        return json({ BEAAPI: { Request: {}, Results: { Statistic: "NIPA Table", UTCProductionTime: "2026-09-25T12:00:00.000", Data } } });
      }
      if (ds === "GDPbyIndustry") {
        const inds = u.searchParams.get("Industry").split(",");
        const Data = [];
        for (const ind of inds) {
          qs.forEach((d, i) => {
            const q = ["I", "II", "III", "IV"][(Number(d.slice(5, 7)) - 1) / 3];
            Data.push({ TableID: "1", Frequency: "Q", Year: d.slice(0, 4), Quarter: q, Industry: ind, IndustrYDescription: `Industry ${ind}`, DataValue: val(ind, i, 2500).toLocaleString("en-US", { maximumFractionDigits: 1 }), NoteRef: "1" });
          });
        }
        // GDPbyIndustry answers Results as an array of result blocks, unlike NIPA.
        return json({ BEAAPI: { Request: {}, Results: [{ Statistic: "Value Added by Industry", UTCProductionTime: "2026-09-25T12:00:00.000", Data }] } });
      }
    }
    if (u.host === "data.sec.gov") {
      const m = /CIK(\d{10})\.json$/.exec(u.pathname);
      const cik = m[1];
      if (!init.headers || !init.headers["User-Agent"]) return { status: 403, ok: false, text: "Undeclared Automated Tool" };
      if (u.pathname.includes("companyfacts")) {
        const usd = (concept, base, instant) => {
          const rows = [];
          for (let y = 2022; y <= 2026; y++) {
            for (let q = 1; q <= 4; q++) {
              const endMonth = q * 3;
              const end = `${y}-${String(endMonth).padStart(2, "0")}-${[31, 30, 30, 31][q - 1]}`;
              if (Date.parse(end) > now.getTime() - 60 * DAY) continue;
              const i = (y - 2022) * 4 + q;
              const v = Math.round(val(cik + concept, i, base, 0.01));
              const accn = `0000${cik.slice(-6)}-${String(y).slice(2)}-0000${q}`;
              const filed = new Date(Date.parse(end) + 35 * DAY).toISOString().slice(0, 10);
              if (instant) rows.push({ end, val: v, accn, fy: y, fp: `Q${q}`, form: q === 4 ? "10-K" : "10-Q", filed, frame: `CY${y}Q${q}I` });
              else {
                // Quarterly fact with frame, plus a repeated comparative (no frame) that must be ignored.
                rows.push({ start: `${y}-${String(endMonth - 2).padStart(2, "0")}-01`, end, val: v, accn, fy: y, fp: `Q${q}`, form: "10-Q", filed, frame: q === 4 ? undefined : `CY${y}Q${q}` });
                rows.push({ start: `${y}-${String(endMonth - 2).padStart(2, "0")}-01`, end, val: v + 999, accn: `${accn}9`, fy: y + 1, fp: `Q${q}`, form: "10-Q", filed });
              }
            }
            const fyEnd = `${y}-12-31`;
            if (!instant && Date.parse(fyEnd) < now.getTime() - 60 * DAY) rows.push({ start: `${y}-01-01`, end: fyEnd, val: Math.round(val(cik + concept, y, base * 4, 0.05)), accn: `0000${cik.slice(-6)}-${String(y + 1).slice(2)}-00010`, fy: y, fp: "FY", form: "10-K", filed: `${y + 1}-02-10`, frame: `CY${y}` });
          }
          return { label: concept, description: concept, units: { USD: rows } };
        };
        const gaap = {
          // Older periods on Revenues, newer on the ASC 606 concept: exercises the fallback merge.
          RevenueFromContractWithCustomerExcludingAssessedTax: usd("rev", 9e10, false),
          Revenues: usd("rev-old", 8e10, false),
          OperatingIncomeLoss: usd("opinc", 2.5e10, false),
          NetIncomeLoss: usd("ni", 2e10, false),
          NetCashProvidedByUsedInOperatingActivities: usd("ocf", 2.8e10, false),
          CashAndCashEquivalentsAtCarryingValue: usd("cash", 3e10, true),
          LongTermDebtNoncurrent: usd("ltd", 9e10, true),
          AssetsCurrent: usd("ac", 1.4e11, true),
          LiabilitiesCurrent: usd("lc", 1.3e11, true),
          Assets: usd("assets", 3.5e11, true),
          PaymentsToAcquirePropertyPlantAndEquipment: usd("capex", 3e9, false),
          PaymentsForRepurchaseOfCommonStock: usd("buyback", 2e10, false),
          PaymentsOfDividendsCommonStock: usd("div", 4e9, false),
          // Interest on the nonoperating concept (as Amazon reports it): exercises the concept fallback.
          InterestExpenseNonoperating: usd("int", 1e9, false),
        };
        return json({ cik: Number(cik), entityName: `Company ${cik}`, facts: { dei: {}, "us-gaap": gaap } });
      }
      if (u.pathname.includes("submissions")) {
        const recent = { accessionNumber: [], filingDate: [], reportDate: [], form: [], items: [], primaryDocument: [] };
        const add = (accn, date, form, items = "", doc = "doc.htm") => {
          recent.accessionNumber.push(accn);
          recent.filingDate.push(date);
          recent.reportDate.push(date);
          recent.form.push(form);
          recent.items.push(items);
          recent.primaryDocument.push(doc);
        };
        let n = 0;
        for (let t = now.getTime() - 3 * DAY; t > now.getTime() - 420 * DAY; t -= 5 * DAY) {
          n++;
          const form = n % 9 === 0 ? "8-K" : n % 23 === 0 ? "10-Q" : n % 41 === 0 ? "SC 13G/A" : "4";
          const items = form === "8-K" ? (n === 9 ? "4.02,9.01" : "2.02,9.01") : "";
          add(`0000${cik.slice(-6)}-26-${String(n).padStart(6, "0")}`, ymd(t), form, items, `xslF345X05/${n}.xml`);
        }
        add(`0000${cik.slice(-6)}-26-999999`, ymd(now.getTime() - 10 * DAY), "S-8");
        return json({ cik, name: `Company ${cik}`, tickers: [], filings: { recent, files: [] } });
      }
    }
    if (u.host === "api.fda.gov") {
      const search = u.searchParams.get("search") || "";
      const count = u.searchParams.get("count");
      if (/recalling_firm:"Eli Lilly"/.test(search)) return json({ error: { code: "NOT_FOUND", message: "No matches found!" } }, 404);
      if (u.pathname.endsWith("shortages.json")) {
        // Drug shortages: MM/DD/YYYY dates, about one new posting every 3 days for 400 days.
        const us = (ms) => { const d = ymd(ms); return `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`; };
        const results = [];
        for (let k = 0; k < 140; k++) {
          const posted = now.getTime() - (2 + k * 3) * DAY;
          const status = k % 7 === 0 ? "To Be Discontinued" : k % 11 === 0 ? "Resolved" : "Current";
          results.push({ status, initial_posting_date: us(posted), update_date: us(posted + 20 * DAY), company_name: k % 5 === 0 ? "Pfizer Laboratories Div Pfizer Inc" : `Maker ${k}`, generic_name: `Drug ${k}`, availability: k % 4 === 0 ? "Unavailable" : "Limited Availability", therapeutic_category: ["Anesthesia"], shortage_reason: "Demand increase for the drug" });
        }
        const skip = Number(u.searchParams.get("skip") || 0);
        return json({ meta: { results: { skip, limit: 1000, total: results.length } }, results: results.slice(skip, skip + 1000) });
      }
      if (count) {
        const results = [];
        for (let t = now.getTime() - 405 * DAY; t < now.getTime() - DAY; t += DAY) {
          const i = Math.round((t - now.getTime()) / DAY);
          const n = Math.max(0, Math.round(5 + 3 * Math.sin(i / 7) + (/Class I/.test(search) ? -4 : 0) + (/receivedate/.test(count) ? 1200 : 0)));
          if (n > 0) results.push({ time: ymd(t).replace(/-/g, ""), count: n });
        }
        return json({ meta: { disclaimer: "Do not rely on openFDA to make decisions regarding medical care.", terms: "https://open.fda.gov/terms/", license: "https://open.fda.gov/license/", last_updated: "2026-09-30" }, results });
      }
      if (u.pathname.endsWith("enforcement.json")) {
        const skip = Number(u.searchParams.get("skip") || 0);
        if (skip > 0) return json({ error: { code: "NOT_FOUND", message: "No matches found!" } }, 404);
        return json({ meta: { results: { skip: 0, limit: 100, total: 3 } }, results: [
          { recall_number: "D-0001-2027", report_date: ymd(now.getTime() - 4 * DAY).replace(/-/g, ""), recall_initiation_date: "20260915", classification: "Class I", recalling_firm: "Pfizer Laboratories Div Pfizer Inc", product_description: "Example injectable, 10 mL vial", reason_for_recall: "Lack of assurance of sterility", status: "Ongoing", distribution_pattern: "Nationwide" },
          { recall_number: "D-0002-2027", report_date: ymd(now.getTime() - 6 * DAY).replace(/-/g, ""), recall_initiation_date: "20260901", classification: "Class II", recalling_firm: "Generic Pharma LLC", product_description: "Example tablets 20 mg", reason_for_recall: "Failed dissolution specifications", status: "Ongoing", distribution_pattern: "US" },
          { recall_number: "D-0003-2027", report_date: ymd(now.getTime() - 8 * DAY).replace(/-/g, ""), classification: "Class III", recalling_firm: "Another Firm", product_description: "Example cream", reason_for_recall: "Labeling", status: "Terminated" },
        ] });
      }
      if (u.pathname.endsWith("drugsfda.json")) {
        const results = [];
        for (let k = 0; k < 40; k++) {
          const date = ymd(now.getTime() - (5 + k * 9) * DAY).replace(/-/g, "");
          const generic = k % 3 !== 0;
          results.push({
            application_number: `${generic ? "ANDA" : k % 2 ? "BLA" : "NDA"}${String(200000 + k)}`,
            sponsor_name: k === 3 ? "ELI LILLY AND CO" : `SPONSOR ${k}`,
            openfda: generic ? {} : { brand_name: [`BRAND${k}`] },
            products: [{ brand_name: `PRODUCT${k}` }],
            submissions: [
              { submission_type: "ORIG", submission_number: "1", submission_status: "AP", submission_status_date: date, review_priority: k % 2 ? "PRIORITY" : "STANDARD" },
              { submission_type: "SUPPL", submission_number: "2", submission_status: "AP", submission_status_date: date },
            ],
          });
        }
        return json({ meta: { results: { skip: 0, limit: 1000, total: results.length } }, results });
      }
    }
    if (u.host === "api.worldbank.org") {
      const m = /\/country\/([^/]+)\/indicator\/([^/?]+)/.exec(u.pathname);
      const countries = m[1].split(";");
      const indicator = decodeURIComponent(m[2]);
      if (indicator === "BAD.INDICATOR") return json([{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }]);
      const [from, to] = u.searchParams.get("date").split(":").map(Number);
      const rows = [];
      for (const c of countries) {
        for (let y = to; y >= from; y--) {
          rows.push({ indicator: { id: indicator, value: indicator }, country: { id: c, value: c }, countryiso3code: `${c}X`, date: String(y), value: y >= to - 1 ? null : Number(val(c + indicator, y - from, 3, 0.01).toFixed(3)), unit: "", obs_status: "", decimal: 1 });
        }
      }
      return json([{ page: 1, pages: 1, per_page: 1000, total: rows.length, sourceid: "2", lastupdated: "2026-09-19" }, rows]);
    }
    const b2 = batch2(u, init, now, json);
    if (b2) return b2;
    const b3 = batch3(u, init, now, json);
    if (b3) return b3;
    const b4 = batch4(u, init, now, json);
    if (b4) return b4;
    return { status: 404, ok: false, text: `stub has no route for ${url}` };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

module.exports = { makeFetch };
