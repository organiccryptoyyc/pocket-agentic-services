// Test-only upstream stub for the batch 3 sources, in each API's response shape as seen live on
// 2026-10-04: TreasuryDirect auction arrays, OpenFEMA {DisasterDeclarationsSummaries}, USGS
// {count} and GeoJSON events, NWS GeoJSON alerts, the CISA KEV file, NVD {totalResults}, CDC
// Socrata rows.
"use strict";

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function batch3(u, init, now, json) {
  const t = now.getTime();
  if (u.host === "www.treasurydirect.gov") {
    const type = u.searchParams.get("type");
    const days = Number(u.searchParams.get("days") || 30);
    const rows = [];
    for (let k = 0; k * 6 < days; k++) {
      const date = t - (3 + k * 6) * DAY;
      const accepted = 50e9;
      rows.push({
        cusip: `9128${type === "Bond" ? "B" : "N"}${String(k).padStart(4, "0")}`, securityType: type, securityTerm: type === "Bond" ? "30-Year" : "7-Year",
        auctionDate: `${ymd(date)}T00:00:00`, bidToCoverRatio: (2.4 + 0.2 * Math.sin(k / 3)).toFixed(6), highYield: "5.0850", averageMedianYield: (5.02 - 0.01 * (k % 3)).toFixed(6),
        totalAccepted: String(accepted), primaryDealerAccepted: String(accepted * (0.12 + 0.03 * Math.cos(k))), indirectBidderAccepted: String(accepted * (0.55 + 0.05 * Math.sin(k))),
        offeringAmount: "44000000000", tips: k % 9 === 4 ? "Yes" : "No", floatingRate: "No",
      });
    }
    return json(rows);
  }
  if (u.host === "www.fema.gov") {
    const skip = Number(u.searchParams.get("$skip") || 0);
    if (skip > 0) return json({ metadata: {}, DisasterDeclarationsSummaries: [] });
    const rows = [];
    for (let k = 0; k < 120; k++) {
      const date = t - (4 + k * 6) * DAY;
      for (let a = 0; a < 1 + (k % 4); a++) rows.push({ disasterNumber: 4900 - k, declarationDate: `${ymd(date)}T00:00:00.000Z`, declarationType: k % 3 === 0 ? "EM" : "DR", incidentType: k % 2 ? "Severe Storm" : "Flood", declarationTitle: "SEVERE STORMS AND FLOODING", state: ["TX", "FL", "CA", "LA"][k % 4] });
    }
    return json({ metadata: { count: rows.length }, DisasterDeclarationsSummaries: rows });
  }
  if (u.host === "earthquake.usgs.gov") {
    if (u.pathname.endsWith("/count")) return json({ count: 40 + (hash(u.searchParams.get("starttime") + u.searchParams.get("minmagnitude")) % 30), maxAllowed: 20000 });
    return json({ type: "FeatureCollection", features: [
      { id: "us7000test", properties: { mag: 6.8, place: "120 km S of Example, Alaska", time: t - 3 * DAY, url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000test", tsunami: 0, alert: "yellow", felt: 12 } },
    ] });
  }
  if (u.host === "api.weather.gov") {
    const sev = ["Severe", "Extreme", "Moderate", "Minor"];
    return json({ type: "FeatureCollection", features: Array.from({ length: 24 }, (_, k) => ({ properties: { severity: sev[k % 4], event: "Flood Warning" } })) });
  }
  if (u.host === "www.cisa.gov") {
    const vulnerabilities = [];
    for (let k = 0; k < 300; k++) vulnerabilities.push({ cveID: `CVE-2026-${10000 + k}`, vendorProject: `Vendor${k % 9}`, product: `Product${k % 5}`, vulnerabilityName: "Example flaw", dateAdded: ymd(t - (1 + k * 1.4) * DAY), dueDate: ymd(t + 20 * DAY), knownRansomwareCampaignUse: k % 6 === 0 ? "Known" : "Unknown" });
    return json({ title: "CISA Catalog of Known Exploited Vulnerabilities", count: vulnerabilities.length, vulnerabilities });
  }
  if (u.host === "services.nvd.nist.gov") {
    const crit = u.searchParams.get("cvssV3Severity") === "CRITICAL";
    const n = (crit ? 150 : 3500) + (hash(u.searchParams.get("pubStartDate")) % (crit ? 60 : 900));
    return json({ resultsPerPage: 1, startIndex: 0, totalResults: n, format: "NVD_CVE", version: "2.0", vulnerabilities: [] });
  }
  if (u.host === "data.cdc.gov") {
    const rows = [];
    for (let k = 0; k < 60; k++) {
      const week = ymd(t - (8 + k * 7) * DAY);
      for (const [p, base] of [["COVID-19", 1.2], ["Influenza", 0.9], ["RSV", 0.3]]) rows.push({ week_end: `${week}T00:00:00.000`, pathogen: p, geography: "United States", percent_visits: (base * (1 + 0.5 * Math.sin(k / 6))).toFixed(1) });
    }
    return json(rows);
  }
  if (u.host === "www.eia.gov") {
    // dnav history table: a month row, then week-ending MM/DD and value cells.
    const id = u.searchParams.get("s");
    const base = id === "WPULEUS3" ? 90 : id === "WGTSTUS1" ? 210000 : 420000;
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const byMonth = new Map();
    for (let k = 110; k >= 1; k--) {
      const d = new Date(t - (k * 7 + 2) * DAY);
      const key = `${d.getUTCFullYear()}-${MON[d.getUTCMonth()]}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      const v = base * (1 + 0.03 * Math.sin(k / 5));
      byMonth.get(key).push(`<td class='B5'>${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}&nbsp;</td> <td class='B3'>${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}&nbsp;&nbsp;</td>`);
    }
    const rows = [...byMonth.entries()].map(([m, cells]) => `<tr> <td class='B6'>&nbsp;&nbsp;${m}</td> ${cells.join(" ")} </tr>`).join("\n");
    return { status: 200, ok: true, text: `<html><table>${rows}</table></html>`, contentType: "text/html" };
  }
  if (u.host === "www.census.gov") {
    const lines = ["sa,naics_sector,series,geo,year,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec"];
    const y = now.getUTCFullYear();
    const last = now.getUTCMonth() - 1; // last complete month published
    for (const [code, base] of [["BA_BA", 500000], ["BA_HBA", 145000], ["BF_PBF4Q", 29000]]) {
      for (const yr of [y - 2, y - 1, y]) {
        const vals = Array.from({ length: 12 }, (_, m) => (yr < y || m <= last ? String(Math.round(base * (1 + 0.04 * Math.sin((yr * 12 + m) / 4)))) : ""));
        lines.push(`A,TOTAL,${code},US,${yr},${vals.join(",")}`, `U,TOTAL,${code},US,${yr},${vals.join(",")}`, `A,NAICS11,${code},US,${yr},${vals.map((v) => (v ? "10" : "")).join(",")}`);
      }
    }
    return { status: 200, ok: true, text: lines.join("\n") + "\n", contentType: "text/csv" };
  }
  return null;
}

module.exports = { batch3 };
