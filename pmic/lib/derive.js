// Derived metrics and scores, recomputed for every series an ingestion batch touched.
// Deterministic: the same stored observations always give the same numbers. Methodology is
// written up in docs/SCORING.md; constants live here.
"use strict";

const { raiseAlert, resolveAlerts } = require("./db");
const { median } = require("./qc");

const TRANSFORM_VERSION = "pmic-derive/1.0";
const DAY = 86400000;
const HORIZONS = [7, 30, 90, 365];
const INTERVAL_DAYS = { daily: 1, weekly: 7, monthly: 31, quarterly: 92, annual: 366 };
// How old the latest observation may be (from its observation_time) before freshness decays:
// one period plus the usual publication lag.
const FRESH_ALLOWANCE_DAYS = { daily: 5, weekly: 17, monthly: 76, quarterly: 212, annual: 916 };
const GAP_FACTOR = { daily: 6, weekly: 2.5, monthly: 2.5, quarterly: 2.5, annual: 2.5 };
const MIN_HISTORY = 4;
const W_LEVEL = 0.6;
const W_MOMENTUM = 0.4;

const t = (iso) => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const round = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// Latest observation at or before a time, but only if it is not too stale for that horizon.
function valueAt(points, targetMs, maxSlackMs) {
  let best = null;
  for (const p of points) {
    if (p.ms <= targetMs) best = p;
    else break;
  }
  return best && targetMs - best.ms <= maxSlackMs ? best : null;
}

function transformed(series, points) {
  const out = [];
  const slack = INTERVAL_DAYS[series.frequency] * 1.5 * DAY;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let v = null;
    if (series.transform === "level") v = p.v;
    else if (series.transform === "diff") v = i > 0 ? p.v - points[i - 1].v : null;
    else if (series.transform === "mom_pct") v = i > 0 && points[i - 1].v !== 0 ? (p.v / points[i - 1].v - 1) * 100 : null;
    else if (series.transform === "yoy_pct") {
      const ref = valueAt(points.slice(0, i), p.ms - 365 * DAY + slack / 3, slack);
      v = ref && ref.v !== 0 ? (p.v / Math.abs(ref.v) - (ref.v < 0 ? -1 : 1)) * 100 : null;
    }
    if (v !== null && Number.isFinite(v)) out.push({ ms: p.ms, time: p.time, v });
  }
  return out;
}

function pctRank(values, x) {
  if (!values.length) return null;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (below + 0.5 * equal) / values.length;
}

function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, sd };
}

function freshness(series, latestMs, nowMs) {
  const age = (nowMs - latestMs) / DAY;
  const allow = FRESH_ALLOWANCE_DAYS[series.frequency];
  if (age <= allow) return 100;
  return Math.max(0, Math.round(100 * (1 - (age - allow) / (1.5 * allow))));
}

function sourceReliability(db, series, base) {
  const recent = db.prepare("SELECT ok FROM fetch_logs WHERE source_id = ? ORDER BY id DESC LIMIT 10").all(series.source_id);
  if (!recent.length) return base;
  const failRate = recent.filter((r) => !r.ok).length / recent.length;
  return Math.max(0, Math.round(base - 30 * failRate));
}

function fmt(v, unit) {
  if (v === null || v === undefined) return "n/a";
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(4);
  return `${s} ${unit.replace(/_/g, " ")}`;
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${s}`;
}

function describeChange(series, current, refValue, days) {
  if (refValue === null) return null;
  if (series.unit === "percent" || series.unit === "percentage_points") {
    const d = current - refValue;
    return `${d >= 0 ? "up" : "down"} ${Math.abs(d).toFixed(2)} pp over ${days} days`;
  }
  if (refValue === 0) return null;
  const pct = (current / Math.abs(refValue) - (refValue < 0 ? -1 : 1)) * 100;
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% over ${days} days`;
}

// Cross-source check: series sharing a cross_check group should report the same value for the
// same observation_time (to 0.5% relative or 0.05 absolute, whichever is larger).
function crossCheck(db, series, nowIso) {
  if (!series.cross_check) return null;
  const peers = db.prepare("SELECT series_id FROM series WHERE cross_check = ? AND series_id <> ? AND enabled = 1").all(series.cross_check, series.series_id);
  for (const peer of peers) {
    const row = db.prepare(`SELECT a.observation_time, a.metric_value av, b.metric_value bv FROM observations a
      JOIN observations b ON b.series_id = ? AND b.observation_time = a.observation_time
      WHERE a.series_id = ? ORDER BY a.observation_time DESC LIMIT 1`).get(peer.series_id, series.series_id);
    if (!row) continue;
    const tol = Math.max(0.05, 0.005 * Math.abs(row.bv));
    const key = `xcheck|${series.cross_check}|${row.observation_time}`;
    if (Math.abs(row.av - row.bv) > tol) {
      raiseAlert(db, { kind: "cross_source_mismatch", series_id: series.series_id, entity_id: series.entity_id, key,
        detail: `${series.series_id}=${row.av} vs ${peer.series_id}=${row.bv} for ${row.observation_time}` }, nowIso);
      return { ok: false, peer: peer.series_id, observation_time: row.observation_time, value: row.av, peer_value: row.bv };
    }
    resolveAlerts(db, { key }, nowIso);
    return { ok: true, peer: peer.series_id, observation_time: row.observation_time };
  }
  return null;
}

function checkGaps(db, series, points, nowIso) {
  const limit = INTERVAL_DAYS[series.frequency] * GAP_FACTOR[series.frequency] * DAY;
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].ms - points[i - 1].ms > limit) gaps.push([points[i - 1].time, points[i].time]);
  }
  for (const [a, b] of gaps.slice(-3)) {
    raiseAlert(db, { kind: "gap", source_id: series.source_id, series_id: series.series_id, entity_id: series.entity_id,
      key: `gap|${series.series_id}|${a}|${b}`, detail: `no observations between ${a} and ${b} (${series.frequency} series)` }, nowIso);
  }
  return gaps;
}

function scoreSeries(db, series, source, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const rows = db.prepare(`SELECT id, metric_value, observation_time, fetch_time, source_url, raw_sha256, qc_flags, revision
    FROM observations WHERE series_id = ? ORDER BY observation_time`).all(series.series_id);
  if (!rows.length) return null;
  const points = rows.map((r) => ({ ms: t(r.observation_time), time: r.observation_time, v: r.metric_value }));
  const latest = rows[rows.length - 1];
  const cur = points[points.length - 1];
  const slackFor = (h) => Math.max(INTERVAL_DAYS[series.frequency] * 1.5, h * 0.25) * DAY;

  // Percent changes on the raw value.
  const pct = {};
  const refs = {};
  // A horizon shorter than the series' own period has no meaning (no 7-day change on a monthly series).
  for (const h of HORIZONS) {
    const ref = h >= 0.8 * INTERVAL_DAYS[series.frequency] ? valueAt(points.slice(0, -1), cur.ms - h * DAY, slackFor(h)) : null;
    refs[h] = ref ? ref.v : null;
    pct[h] = ref && ref.v !== 0 ? round((cur.v / Math.abs(ref.v) - (ref.v < 0 ? -1 : 1)) * 100) : null;
  }

  // Level statistics on the transformed series against the trailing year (or, for slow series,
  // the last 12 transformed points).
  const tr = transformed(series, points);
  const trCur = tr.length && tr[tr.length - 1].time === cur.time ? tr[tr.length - 1] : null;
  const prior = trCur ? tr.slice(0, -1) : tr;
  let window = prior.filter((p) => p.ms >= cur.ms - 365 * DAY);
  if (window.length < 8) window = prior.slice(-12);
  const hist = window.map((p) => p.v);
  let z = null;
  let percentile = null;
  if (trCur && hist.length >= MIN_HISTORY) {
    const st = stats(hist);
    z = st.sd > 0 ? round((trCur.v - st.mean) / st.sd, 3) : 0;
    percentile = round(pctRank(hist, trCur.v), 4);
  }

  // Momentum: change in the transformed value over ~90 days, scaled by its own typical size.
  let momentum = null;
  let scale = null;
  if (trCur) {
    const h = series.frequency === "annual" ? 365 : 90;
    const ref = valueAt(prior, cur.ms - h * DAY, slackFor(h));
    const changes = [];
    for (let i = 0; i < tr.length; i++) {
      const r0 = valueAt(tr.slice(0, i), tr[i].ms - h * DAY, slackFor(h));
      if (r0) changes.push(Math.abs(tr[i].v - r0.v));
    }
    scale = changes.length >= MIN_HISTORY ? median(changes) : null;
    if (ref && scale > 0) momentum = Math.tanh((trCur.v - ref.v) / (1.5 * scale));
  }

  // Trend over the most recent step that is at least ~30 days back.
  let trend = "unknown";
  if (trCur) {
    // Slack of 2.5 periods: SEC quarterly frames usually skip Q4 (it is only reported inside the 10-K year).
    const ref = valueAt(prior, cur.ms - Math.max(30, INTERVAL_DAYS[series.frequency]) * DAY, Math.max(slackFor(30), 2.5 * INTERVAL_DAYS[series.frequency] * DAY));
    if (ref) {
      const d = trCur.v - ref.v;
      const thr = scale ? 0.1 * scale : 1e-9;
      trend = d > thr ? "up" : d < -thr ? "down" : "flat";
    }
  }

  // Composite 0-100.
  const pol = series.polarity || 0;
  let levelPart = null;
  let momPart = null;
  if (percentile !== null) levelPart = pol === 0 ? Math.abs(2 * percentile - 1) : pol > 0 ? percentile : 1 - percentile;
  if (momentum !== null) momPart = pol === 0 ? Math.abs(momentum) : 0.5 + 0.5 * momentum * Math.sign(pol);
  let composite = null;
  if (levelPart !== null && momPart !== null) composite = Math.round(100 * (W_LEVEL * levelPart + W_MOMENTUM * momPart));
  else if (levelPart !== null) composite = Math.round(100 * levelPart);
  else if (momPart !== null) composite = Math.round(100 * momPart);

  const fresh = freshness(series, cur.ms, nowMs);
  const reliability = sourceReliability(db, series, source.reliability_score);
  const depth = Math.min(1, hist.length / 12) * 100;
  const flags = [];
  const qc = JSON.parse(latest.qc_flags);
  const xc = crossCheck(db, series, nowIso);
  if (fresh < 50) flags.push("stale_data");
  if (hist.length < MIN_HISTORY) flags.push("insufficient_history");
  if (qc.includes("outlier")) flags.push("outlier_current");
  if (qc.includes("preliminary")) flags.push("preliminary_value");
  if (qc.includes("revised")) flags.push("revised_by_source");
  if (percentile !== null && (percentile >= 0.95 || percentile <= 0.05)) flags.push("extreme_level");
  if (z !== null && Math.abs(z) >= 2) flags.push("large_deviation");
  if (momentum !== null && Math.abs(momentum) >= 0.9) flags.push("sharp_move");
  if (reliability < source.reliability_score - 10) flags.push("source_fetch_failures");
  if (xc && !xc.ok) flags.push("cross_source_mismatch");
  if (!series.cross_check) flags.push("single_source");
  const recentHigh = db.prepare(`SELECT COUNT(*) n FROM events WHERE entity_id = ? AND severity = 'high' AND event_time >= ?`)
    .get(series.entity_id, new Date(nowMs - 30 * DAY).toISOString().slice(0, 10)).n;
  if (recentHigh > 0) flags.push("high_severity_event_30d");

  let confidence = 0.4 * reliability + 0.35 * fresh + 0.25 * depth;
  if (qc.includes("outlier")) confidence -= 15;
  if (qc.includes("preliminary")) confidence -= 10;
  if (xc && !xc.ok) confidence -= 10;
  if (xc && xc.ok) confidence += 5;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  const label = confidence >= 75 ? "high" : confidence >= 50 ? "medium" : "low";

  // Rationale: deterministic template.
  const changeText = [30, 90, 365].map((h) => describeChange(series, cur.v, refs[h], h)).filter(Boolean)[0];
  const trName = { level: "level", yoy_pct: "year-over-year change", mom_pct: "month-over-month change", diff: "period-over-period change" }[series.transform];
  const parts = [`${series.label} (${series.entity_id}) was ${fmt(cur.v, series.unit)} as of ${cur.time}${changeText ? `, ${changeText}` : ""}.`];
  if (trCur && series.transform !== "level") parts.push(`Its ${trName} is ${trCur.v.toFixed(2)}${series.transform.endsWith("pct") ? "%" : ""}.`);
  if (percentile !== null) parts.push(`That ${trName} sits at the ${ordinal(Math.round(percentile * 100))} percentile of the trailing window (z ${z >= 0 ? "+" : ""}${z.toFixed(2)}, ${hist.length} points).`);
  else parts.push("Not enough history yet for a percentile or z-score.");
  if (composite !== null) parts.push(`Composite ${composite}/100 (${pol > 0 ? "higher reads stronger" : pol < 0 ? "higher reads weaker, so the score is inverted" : "neutral series: the score measures how unusual the reading is"}).`);
  parts.push(`Source ${source.name}; freshness ${fresh}/100.`);
  const rationale = parts.join(" ");

  const fetchRow = latest.raw_sha256 ? db.prepare("SELECT raw_file FROM fetch_logs WHERE raw_sha256 = ? AND raw_file IS NOT NULL ORDER BY id DESC LIMIT 1").get(latest.raw_sha256) : null;
  const provenance = {
    observation_id: latest.id,
    observation_time: latest.observation_time,
    fetch_time: latest.fetch_time,
    raw_sha256: latest.raw_sha256,
    raw_file: fetchRow ? fetchRow.raw_file : null,
    revision: latest.revision,
    transform: series.transform,
    history_points: hist.length,
    window_start: window.length ? window[0].time : null,
    cross_check: xc,
    source_terms_url: source.terms_url || null,
    transform_version: TRANSFORM_VERSION,
  };

  const score = {
    series_id: series.series_id,
    entity_id: series.entity_id,
    metric_name: series.metric_name,
    source_id: series.source_id,
    as_of: cur.time,
    computed_at: nowIso,
    current_value: cur.v,
    unit: series.unit,
    transformed_value: trCur ? round(trCur.v) : null,
    pct_change_7d: pct[7],
    pct_change_30d: pct[30],
    pct_change_90d: pct[90],
    pct_change_365d: pct[365],
    zscore: z,
    percentile,
    freshness_score: fresh,
    reliability_score: reliability,
    composite_score: composite,
    trend,
    confidence_score: confidence,
    confidence_label: label,
    risk_flags: flags,
    rationale,
    citation_url: latest.source_url,
    provenance,
    transform_version: TRANSFORM_VERSION,
  };

  db.prepare(`INSERT INTO scores (series_id, entity_id, metric_name, source_id, as_of, computed_at, current_value, unit, transformed_value,
      pct_change_7d, pct_change_30d, pct_change_90d, pct_change_365d, zscore, percentile, freshness_score, reliability_score, composite_score,
      trend, confidence_score, confidence_label, risk_flags, rationale, citation_url, provenance_json, transform_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (series_id, as_of, transform_version) DO UPDATE SET computed_at=excluded.computed_at, current_value=excluded.current_value,
      transformed_value=excluded.transformed_value, pct_change_7d=excluded.pct_change_7d, pct_change_30d=excluded.pct_change_30d,
      pct_change_90d=excluded.pct_change_90d, pct_change_365d=excluded.pct_change_365d, zscore=excluded.zscore, percentile=excluded.percentile,
      freshness_score=excluded.freshness_score, reliability_score=excluded.reliability_score, composite_score=excluded.composite_score,
      trend=excluded.trend, confidence_score=excluded.confidence_score, confidence_label=excluded.confidence_label, risk_flags=excluded.risk_flags,
      rationale=excluded.rationale, citation_url=excluded.citation_url, provenance_json=excluded.provenance_json`)
    .run(score.series_id, score.entity_id, score.metric_name, score.source_id, score.as_of, score.computed_at, score.current_value, score.unit,
      score.transformed_value, score.pct_change_7d, score.pct_change_30d, score.pct_change_90d, score.pct_change_365d, score.zscore, score.percentile,
      score.freshness_score, score.reliability_score, score.composite_score, score.trend, score.confidence_score, score.confidence_label,
      JSON.stringify(flags), rationale, score.citation_url, JSON.stringify(provenance), TRANSFORM_VERSION);

  const derived = { transformed_value: score.transformed_value, zscore: z, percentile, momentum: round(momentum), momentum_scale: round(scale) };
  for (const h of HORIZONS) derived[`pct_change_${h}d`] = pct[h];
  const ins = db.prepare(`INSERT INTO derived_metrics (series_id, entity_id, metric_name, as_of, derived_name, value, computed_at, transform_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (series_id, as_of, derived_name, transform_version) DO UPDATE SET value=excluded.value, computed_at=excluded.computed_at`);
  for (const [k, v] of Object.entries(derived)) ins.run(series.series_id, series.entity_id, series.metric_name, cur.time, k, v, nowIso, TRANSFORM_VERSION);

  checkGaps(db, series, points.filter((p) => p.ms >= nowMs - 400 * DAY), nowIso);
  if (fresh === 0) {
    raiseAlert(db, { kind: "stale", source_id: series.source_id, series_id: series.series_id, entity_id: series.entity_id,
      detail: `latest observation ${cur.time} is past twice the expected publication allowance for a ${series.frequency} series` }, nowIso);
  } else resolveAlerts(db, { kind: "stale", source_id: series.source_id, series_id: series.series_id, entity_id: series.entity_id }, nowIso);
  return score;
}

// Weekly rollups for daily series (kept 2+ years under the rollup_weekly class).
function rollupWeekly(db, seriesId) {
  db.prepare(`INSERT INTO rollups_weekly (series_id, week_start, n, avg_value, min_value, max_value, last_value)
    SELECT series_id, wk, COUNT(*), AVG(metric_value), MIN(metric_value), MAX(metric_value),
      (SELECT o2.metric_value FROM observations o2 WHERE o2.series_id = o.series_id
         AND date(o2.observation_time, '-' || ((CAST(strftime('%w', o2.observation_time) AS INTEGER) + 6) % 7) || ' days') = wk
       ORDER BY o2.observation_time DESC LIMIT 1)
    FROM (SELECT *, date(observation_time, '-' || ((CAST(strftime('%w', observation_time) AS INTEGER) + 6) % 7) || ' days') wk
          FROM observations WHERE series_id = ?) o
    GROUP BY series_id, wk
    ON CONFLICT (series_id, week_start) DO UPDATE SET n=excluded.n, avg_value=excluded.avg_value, min_value=excluded.min_value,
      max_value=excluded.max_value, last_value=excluded.last_value`).run(seriesId);
}

module.exports = { scoreSeries, rollupWeekly, transformed, freshness, valueAt, pctRank, TRANSFORM_VERSION, HORIZONS, INTERVAL_DAYS, FRESH_ALLOWANCE_DAYS };
