// Test-only upstream stub for the batch 4 sources, in each API's response shape as seen live on
// 2026-10-04: the Pocket indexer's GraphQL aliases, DefiLlama chart arrays, ArcGIS statistics,
// NOAA Climate at a Glance {data}, FBI CDE {offenses: {rates}}, the TSA passenger table, IMF
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
  if (u.host === "api.usa.gov") {
    const offense = u.pathname.split("/").pop();
    const rates = {};
    for (const { y, m } of monthsSince(2019, now)) rates[`${String(m).padStart(2, "0")}-${y}`] = Number(((offense === "violent-crime" ? 30 : 160) * (1 + 0.1 * Math.sin((y * 12 + m) / 5))).toFixed(2));
    return json({ offenses: { rates: { "United States Offenses": rates, "United States Clearances": {} }, actuals: {} }, tooltips: {} });
  }
  if (u.host === "www.tsa.gov") {
    const yr = /\/(\d{4})$/.exec(u.pathname);
    const year = yr ? Number(yr[1]) : now.getUTCFullYear();
    const rows = [];
    for (let d = Date.UTC(year, 11, 31); d >= Date.UTC(year, 0, 1); d -= DAY) {
      if (d >= t - DAY) continue;
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
  return null;
}

module.exports = { batch4, ftdText };
