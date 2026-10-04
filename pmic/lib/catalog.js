// Loads config/*.json and expands the SEC, World Bank and openFDA templates into one flat
// series catalog. Everything downstream (collector, scoring, query API) works off this list.
"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG_DIR = path.resolve(process.env.PMIC_CONFIG_DIR || path.join(__dirname, "..", "config"));
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), "utf8"));
}

function load() {
  const { sources } = readConfig("sources.json");
  const cfg = readConfig("series.json");
  const retention = readConfig("retention.json");
  const bySource = new Map(sources.map((s) => [s.source_id, s]));
  const entities = cfg.entities.map((e) => ({ ...e }));
  const series = cfg.series.map((s) => ({ ...s }));

  // World Bank: one annual series per (country, indicator).
  const wbSkip = new Set(cfg.worldbank.skip || []);
  for (const country of cfg.worldbank.countries) {
    for (const ind of cfg.worldbank.indicators) {
      if (wbSkip.has(`${country}:${ind.id}`)) continue;
      series.push({
        series_id: `worldbank:${country}:${ind.id}`,
        source_id: "worldbank",
        entity_id: country,
        metric_name: ind.metric_name,
        label: ind.label,
        unit: ind.unit,
        frequency: "annual",
        category: ind.category,
        industry: ind.industry,
        polarity: ind.polarity,
        transform: "level",
        params: { country: country.toUpperCase(), indicator: ind.id },
      });
    }
  }

  // SEC: a company entity per ticker, XBRL metric series, ratio series, and a weekly Form 4 count.
  for (const co of cfg.sec.companies) {
    const entity_id = co.ticker.toLowerCase();
    entities.push({ entity_id, entity_type: "company", name: co.name, ticker: co.ticker, cik: co.cik, geography: "US", industry: co.industry });
    const base = { source_id: "sec", entity_id, category: "market", industry: co.industry, transform: "level", params: { cik: co.cik, ticker: co.ticker } };
    const skip = new Set(co.skip_metrics || []);
    for (const m of cfg.sec.metrics) {
      if (skip.has(m.metric_name)) continue;
      if (m.kind === "duration") {
        series.push({ ...base, series_id: `sec:${co.ticker}:${m.metric_name}_q`, metric_name: `${m.metric_name}_q`, label: `${m.label}, quarterly`, unit: m.unit, frequency: "quarterly", polarity: m.polarity, transform: "yoy_pct" });
        series.push({ ...base, series_id: `sec:${co.ticker}:${m.metric_name}_fy`, metric_name: `${m.metric_name}_fy`, label: `${m.label}, fiscal year`, unit: m.unit, frequency: "annual", polarity: m.polarity, transform: "yoy_pct" });
      } else {
        series.push({ ...base, series_id: `sec:${co.ticker}:${m.metric_name}`, metric_name: m.metric_name, label: m.label, unit: m.unit, frequency: "quarterly", polarity: m.polarity });
      }
    }
    for (const r of cfg.sec.ratios) {
      if (skip.has(r.metric_name) || skip.has(r.numerator) || skip.has(r.denominator)) continue;
      series.push({ ...base, series_id: `sec:${co.ticker}:${r.metric_name}`, metric_name: r.metric_name, label: r.label, unit: r.unit, frequency: "quarterly", polarity: r.polarity });
    }
    series.push({ ...base, series_id: `sec:${co.ticker}:insider_form4_weekly`, metric_name: "insider_form4_weekly", label: "Insider transaction filings (Form 4), weekly", unit: "count", frequency: "weekly", polarity: 0, category: "market" });
    if (co.fda_firm) {
      series.push({ series_id: `openfda:${co.ticker}:drug_recalls_weekly`, source_id: "openfda", entity_id, metric_name: "drug_recalls_weekly", label: `Drug recalls naming ${co.fda_firm}, weekly`, unit: "count", frequency: "weekly", category: "health", industry: "pharma", polarity: -1, transform: "level", params: { feed: "recalls_firm", firm: co.fda_firm } });
    }
  }

  for (const f of cfg.openfda.feeds) {
    series.push({ series_id: `openfda:${f.metric_name}`, source_id: "openfda", entity_id: "us-drug-market", metric_name: f.metric_name, label: f.label, unit: "count", frequency: "weekly", category: "health", industry: "pharma", polarity: f.polarity, transform: "level", params: { feed: f.feed } });
  }

  const entityIds = new Set();
  for (const e of entities) {
    if (!ID_RE.test(e.entity_id)) throw new Error(`entity_id '${e.entity_id}' must match ${ID_RE}`);
    if (entityIds.has(e.entity_id)) throw new Error(`duplicate entity_id '${e.entity_id}'`);
    entityIds.add(e.entity_id);
  }
  const entityById = new Map(entities.map((e) => [e.entity_id, e]));
  const seen = new Set();
  for (const s of series) {
    if (seen.has(s.series_id)) throw new Error(`duplicate series_id '${s.series_id}'`);
    seen.add(s.series_id);
    const src = bySource.get(s.source_id);
    if (!src) throw new Error(`series ${s.series_id}: unknown source_id '${s.source_id}'`);
    if (!entityIds.has(s.entity_id)) throw new Error(`series ${s.series_id}: unknown entity_id '${s.entity_id}'`);
    s.cadence_minutes = s.cadence_minutes || src.cadence_minutes;
    s.retention_class = s.retention_class || retention.default_class_by_frequency[s.frequency] || "standard";
    if (!(s.retention_class in retention.classes)) throw new Error(`series ${s.series_id}: unknown retention_class '${s.retention_class}'`);
    s.geography = s.geography || entityById.get(s.entity_id).geography || null;
    s.params = s.params || {};
  }

  return { sources, entities, series, retention, sec: cfg.sec, openfda: cfg.openfda };
}

module.exports = { load, CONFIG_DIR, ID_RE };
