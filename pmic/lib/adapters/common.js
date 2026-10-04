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

module.exports = { SchemaError, num, parseJson, pad, ymd, compact, fromCompact, weekStart, completeWeeks, weeklyCounts, quarterStart };
