// Small helpers shared by the source adapters.
"use strict";

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || s === "." || s === "-" || /^\(?NA\)?$/i.test(s) || /^\((D|NA|X|S)\)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaError(`${what}: response is not JSON`);
  }
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.toISOString().slice(0, 10);
const compact = (isoDate) => isoDate.replace(/-/g, "");

// "20260103" -> "2026-01-03"
function fromCompact(s) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Monday (UTC) of the ISO week containing the date, as YYYY-MM-DD.
function weekStart(isoDate) {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return ymd(d);
}

// Complete Monday-start weeks from the first full week on/after `since` to the last week that
// ended before `now`. Count series only emit complete weeks, so a partial week never reads as a drop.
function completeWeeks(since, now) {
  const weeks = [];
  let w = weekStart(since);
  if (w < since) w = ymd(new Date(Date.parse(`${w}T00:00:00Z`) + 7 * 86400000));
  const lastStart = ymd(new Date(Date.parse(`${weekStart(ymd(now))}T00:00:00Z`) - 7 * 86400000));
  while (w <= lastStart) {
    weeks.push(w);
    w = ymd(new Date(Date.parse(`${w}T00:00:00Z`) + 7 * 86400000));
  }
  return weeks;
}

// {date -> count} daily buckets into complete weekly observations (zeros included).
function weeklyCounts(dailyPairs, since, now) {
  const totals = new Map(completeWeeks(since, now).map((w) => [w, 0]));
  for (const [date, count] of dailyPairs) {
    const w = weekStart(date);
    if (totals.has(w)) totals.set(w, totals.get(w) + count);
  }
  return [...totals.entries()];
}

function quarterStart(year, q) {
  return `${year}-${pad((q - 1) * 3 + 1)}-01`;
}

// First day of the month containing the date, as YYYY-MM-DD.
function monthStart(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

function addMonths(isoMonthStart, n) {
  const d = new Date(`${isoMonthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return ymd(d);
}

// Complete calendar months from the first month starting on/after `since` to the month before `now`.
function completeMonths(since, now) {
  const months = [];
  let m = monthStart(since);
  if (m < since) m = addMonths(m, 1);
  const last = addMonths(monthStart(ymd(now)), -1);
  while (m <= last) {
    months.push(m);
    m = addMonths(m, 1);
  }
  return months;
}

// {date -> count} pairs into complete monthly observations (zeros included).
function monthlyCounts(datedPairs, since, now) {
  const totals = new Map(completeMonths(since, now).map((m) => [m, 0]));
  for (const [date, count] of datedPairs) {
    const m = monthStart(date);
    if (totals.has(m)) totals.set(m, totals.get(m) + count);
  }
  return [...totals.entries()];
}

// Calendar quarter start (YYYY-01-01, -04-01, -07-01, -10-01) of a date.
function quarterOfDate(isoDate) {
  const q = Math.floor((Number(isoDate.slice(5, 7)) - 1) / 3) + 1;
  return quarterStart(isoDate.slice(0, 4), q);
}

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. Returns rows of strings.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// CSV with a header row into objects keyed by header name.
function csvObjects(text) {
  const [header, ...rows] = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] === undefined ? "" : r[i]])));
}

// Dates as sources write them: 2026-09-30, 2026-09-30T00:00:00, 9/30/2026, 20260930.
function anyDate(v) {
  const s = String(v || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

module.exports = {
  SchemaError, num, parseJson, pad, ymd, compact, fromCompact, weekStart, completeWeeks, weeklyCounts, quarterStart,
  monthStart, addMonths, completeMonths, monthlyCounts, quarterOfDate, parseCsvRows, csvObjects, anyDate,
};
