// Vertical scoring for the PMIC service packs. Pure functions: hub answers in, one brief out.
// A brief combines several hub series into one 0-100 reading with a label, a trend versus the
// horizon, the inputs that drive it, risk flags, confidence and a citation for every input.
// No language model: every sentence is a template filled from the numbers.
"use strict";

const VERSION = "pmic-vertical/1.0";
const HIGH = 60;
const LOW = 40;
const TREND_BAND = 5; // points of vertical score change that count as a move
const MIXED_STDEV = 20;
const VOTE_BAND = 0.25; // net share of input weight trending one way that counts as a move

const round = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x));
const fromPercentile = (p, dir) => (p === null || p === undefined ? null : Math.round(100 * (dir > 0 ? p : 1 - p)));

function confidenceLabel(score) {
  if (score === null) return "low";
  return score >= 75 ? "high" : score >= 50 ? "medium" : "low";
}

function labelFor(score, labels) {
  if (score === null) return null;
  return score >= HIGH ? labels.high : score <= LOW ? labels.low : labels.mid;
}

function trendWord(delta, words = {}) {
  if (delta === null) return "unknown";
  if (delta >= TREND_BAND) return words.up || "rising";
  if (delta <= -TREND_BAND) return words.down || "falling";
  return "steady";
}

// One input of a vertical. `current` and `previous` come from the hub's /v1/explain answer.
// The member is directional (averaged into the score) unless its direction is 0, in which case
// it is a watch item whose score reads "how unusual", not "how strong".
function scoreMember(cfg, current, previous) {
  const hubPolarity = current.metric.polarity;
  const dir = cfg.direction === undefined ? hubPolarity : cfg.direction;
  const base = {
    series_id: current.series_id,
    label: current.metric.label,
    entity_id: current.entity ? current.entity.entity_id : null,
    weight: cfg.weight || 1,
    direction: dir,
    value: current.value || null,
    changes_pct: current.changes_pct || null,
    hub_trend: current.trend,
    confidence: current.confidence,
    risk_flags: current.risk_flags || [],
    summary: current.summary,
    citation_url: current.provenance ? current.provenance.citation_url || null : null,
    source: current.provenance && current.provenance.source ? current.provenance.source.id : null,
  };
  // no_data: the hub knows the series but has never collected it (a new input not yet backfilled).
  if (current.status !== "ok") return { ...base, role: dir === 0 && !cfg.score_unusualness ? "watch" : "input", scoring: null, score: null, previous_score: null, ...(current.status === "no_data" ? { pending: true } : {}) };
  // score_unusualness: a neutral series (a departure from normal) counted as an input, scored
  // 100 - the hub's unusualness, so "near normal" reads high and "extreme either way" low.
  if (dir === 0 && cfg.score_unusualness) {
    const inv = (v) => (v === null || v === undefined ? null : 100 - v);
    return { ...base, direction: 1, role: "input", scoring: "unusualness_inverted", score: inv(current.composite_score), previous_score: previous ? inv(previous.composite_score) : null };
  }
  if (dir === 0) return { ...base, role: "watch", scoring: "hub_unusualness", score: current.composite_score, previous_score: previous ? previous.composite_score : null };
  if (dir === hubPolarity) return { ...base, role: "input", scoring: "hub_composite", score: current.composite_score, previous_score: previous ? previous.composite_score : null };
  const score = fromPercentile(current.percentile, dir);
  return {
    ...base,
    // The hub's text quotes its own composite in its own direction; restate it in this vertical's.
    summary: restate(base.summary, score, dir),
    role: "input",
    scoring: dir > 0 ? "percentile" : "percentile_inverted",
    score,
    previous_score: previous ? fromPercentile(previous.percentile, dir) : null,
  };
}

function restate(summary, score, dir) {
  if (typeof summary !== "string") return summary;
  const note = `Scored ${score}/100 in this brief (${dir > 0 ? "a higher reading" : "a lower reading"} scores higher here).`;
  const out = summary.replace(/Composite \d+\/100 \([^)]*\)\./, note);
  return out === summary ? `${summary} ${note}` : out;
}

function weightedMean(items, key) {
  let num = 0;
  let den = 0;
  for (const m of items) {
    const v = m[key];
    if (v === null || v === undefined) continue;
    num += v * m.weight;
    den += m.weight;
  }
  return den ? num / den : null;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

// members: output of scoreMember for every input that exists for this vertical (or entity).
function combine(vertical, members, { horizon, entity = null } = {}) {
  // Inputs never collected yet are listed as pending and left out of coverage, so adding an input
  // to a vertical doesn't blank its score until the collector has backfilled it.
  const pending = members.filter((m) => m.pending);
  const inputs = members.filter((m) => m.role === "input" && !m.pending);
  const watch = members.filter((m) => m.role === "watch" && !m.pending);
  const scored = inputs.filter((m) => m.score !== null);
  const totalWeight = inputs.reduce((a, m) => a + m.weight, 0);
  const scoredWeight = scored.reduce((a, m) => a + m.weight, 0);
  const coverage = totalWeight ? scoredWeight / totalWeight : 0;
  const enough = scored.length > 0 && coverage >= 0.5;

  const score = enough ? round(weightedMean(scored, "score")) : null;
  const withPrev = scored.filter((m) => m.previous_score !== null);
  // Previous score uses the same inputs that have both readings, so a new input can't fake a move.
  const prevWeight = withPrev.reduce((a, m) => a + m.weight, 0);
  const previous = enough && prevWeight >= scoredWeight / 2 ? round(weightedMean(withPrev, "previous_score")) : null;
  const nowSame = previous !== null ? round(weightedMean(withPrev, "score")) : null;
  const change = previous !== null ? nowSame - previous : null;

  const flags = new Set();
  if (!enough) flags.add("insufficient_data");
  if (pending.length) flags.add("inputs_pending");
  else if (coverage < 0.75) flags.add("partial_coverage");
  if (scored.length >= 3 && stdev(scored.map((m) => m.score)) > MIXED_STDEV) flags.add("mixed_signals");
  for (const m of inputs) for (const f of m.risk_flags) if (["stale_data", "cross_source_mismatch", "outlier_current", "sharp_move", "extreme_level", "high_severity_event_30d"].includes(f)) flags.add(f);

  const confScore = scored.length ? round(weightedMean(scored.map((m) => ({ ...m, c: m.confidence ? m.confidence.score : null })), "c") * Math.min(1, coverage / 0.75)) : 0;

  const ranked = [...scored].sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50) || b.weight - a.weight);
  const strongest = scored.length ? scored.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  const weakest = scored.length ? scored.reduce((a, b) => (b.score < a.score ? b : a)) : null;

  // Until the hub has a stored score from the start of the horizon, the trend comes from each
  // input's own recent direction (the hub's trend over about one period), weighted and signed so
  // that "up" always means toward a higher vertical score.
  let trend;
  let trendBasis;
  if (change !== null) {
    trend = trendWord(change, vertical.trend_words);
    trendBasis = "score_history";
  } else if (enough) {
    let net = 0;
    let den = 0;
    for (const m of scored) {
      if (!["up", "down", "flat"].includes(m.hub_trend)) continue;
      den += m.weight;
      if (m.hub_trend !== "flat") net += m.weight * (m.hub_trend === "up" ? 1 : -1) * Math.sign(m.direction);
    }
    const share = den ? net / den : null;
    trend = share === null ? "unknown" : share >= VOTE_BAND ? (vertical.trend_words || {}).up || "rising" : share <= -VOTE_BAND ? (vertical.trend_words || {}).down || "falling" : "steady";
    trendBasis = share === null ? null : "input_trends";
  } else {
    trend = "unknown";
    trendBasis = null;
  }
  const label = labelFor(score, vertical.labels);
  const subject = entity ? `${vertical.title} for ${entity.name || entity.entity_id}` : vertical.title;
  const parts = [];
  if (score === null) {
    parts.push(`${subject}: not enough current data to score (${scored.length} of ${inputs.length} inputs have a reading).`);
  } else {
    const how = change !== null ? `, ${trend} over ${horizon.replace("d", " days")} (from ${previous})` : trendBasis === "input_trends" ? `, trend ${trend} (from its inputs' latest moves)` : "";
    parts.push(`${subject}: ${score}/100, ${label}${how}.`);
    if (strongest && weakest && strongest !== weakest) parts.push(`Strongest input: ${strongest.label} at ${strongest.score}; weakest: ${weakest.label} at ${weakest.score}.`);
    parts.push(`Based on ${scored.length} of ${inputs.length} inputs${flags.has("mixed_signals") ? "; the inputs disagree, so read the drivers" : ""}.`);
  }
  const unusual = watch.filter((w) => w.score !== null && w.score >= 75);
  if (unusual.length) parts.push(`Unusual readings to watch: ${unusual.map((w) => `${w.label} (${w.score})`).join(", ")}.`);

  return {
    vertical: vertical.id,
    title: vertical.title,
    question: vertical.question,
    entity,
    horizon,
    status: score === null ? "insufficient_data" : "ok",
    score,
    label,
    previous_score: previous,
    change,
    trend,
    trend_basis: trendBasis,
    summary: parts.join(" "),
    scale: { high: `${HIGH}+ = ${vertical.labels.high}`, mid: `${LOW + 1}-${HIGH - 1} = ${vertical.labels.mid}`, low: `${LOW} or less = ${vertical.labels.low}`, note: vertical.note || "Higher score = stronger than this input's own recent history; 50 is ordinary." },
    drivers: ranked.slice(0, 3).map((m) => ({ series_id: m.series_id, label: m.label, score: m.score, summary: m.summary, citation_url: m.citation_url })),
    risk_flags: [...flags],
    confidence: { score: confScore, label: confidenceLabel(confScore) },
    coverage: { scored: scored.length, inputs: inputs.length, weight_share: Math.round(coverage * 100) / 100 },
    inputs,
    watch,
    ...(pending.length ? { pending_inputs: pending.map((m) => ({ series_id: m.series_id, label: m.label, note: "not collected yet; excluded from the score" })) } : {}),
    citations: members.filter((m) => m.citation_url).map((m) => ({ series_id: m.series_id, label: m.label, as_of: m.value ? m.value.as_of : null, url: m.citation_url, source: m.source })),
    method: { version: VERSION, docs: "https://github.com/organiccryptoyyc/pocket-agentic-services/blob/main/pmic/packs/README.md" },
  };
}

// Filing risk from the company's events in the window.
function filingRisk(vertical, events, { horizon, entity, watch = [] }) {
  const p = vertical.penalties;
  const counted = [];
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const e of events) {
    let weight = 0;
    if (e.event_type === "filing_8k" && e.severity === "high") { high++; weight = p.high; }
    else if ((e.event_type === "filing_8k" && e.severity === "medium") || e.event_type === "ownership_13d") { medium++; weight = p.medium; }
    else if (e.event_type === "filing_8k") { low++; weight = p.low_8k; }
    if (weight) counted.push({ ...e, penalty: weight });
  }
  const score = Math.max(0, 100 - high * p.high - medium * p.medium - low * p.low_8k);
  const label = labelFor(score, vertical.labels);
  const flags = [];
  if (high) flags.push("high_severity_filing");
  if (watch.some((w) => w.score !== null && w.score >= 75)) flags.push("unusual_insider_activity");
  const subject = `${vertical.title} for ${entity.name || entity.entity_id}`;
  const summary = `${subject}: ${score}/100, ${label}. In the last ${horizon.replace("d", " days")}: ${high} high-severity and ${medium} medium-severity filing(s), ${low} other 8-K(s).` +
    (watch.length && watch[0].score !== null ? ` Insider Form 4 activity scores ${watch[0].score} for unusualness.` : "");
  counted.sort((a, b) => b.penalty - a.penalty || String(b.event_time).localeCompare(String(a.event_time)));
  return {
    vertical: vertical.id,
    title: vertical.title,
    question: vertical.question,
    entity,
    horizon,
    status: "ok",
    score,
    label,
    summary,
    scale: { high: `60+ = ${vertical.labels.high}`, mid: `41-59 = ${vertical.labels.mid}`, low: `40 or less = ${vertical.labels.low}`, note: vertical.note },
    counts: { high, medium, other_8k: low, events_in_window: events.length },
    drivers: counted.slice(0, 10).map(({ event_type, event_time, title, severity, source_url, penalty }) => ({ event_type, event_time, title, severity, penalty, citation_url: source_url })),
    risk_flags: flags,
    confidence: { score: 90, label: "high", note: "Counts come straight from SEC EDGAR's filing index." },
    watch,
    citations: counted.slice(0, 10).map((e) => ({ label: e.title, url: e.source_url, source: "sec" })),
    method: { version: VERSION, docs: "https://github.com/organiccryptoyyc/pocket-agentic-services/blob/main/pmic/packs/README.md" },
  };
}

// Country table: one hub signal per (country, metric). Ranks countries on each metric and gives
// each country the mean of its directional scores.
function countryTable(vertical, signalsByMetric, { horizon, countries = null }) {
  const unit = vertical.unit_word || "countries";
  const metrics = [];
  const byCountry = new Map();
  for (const [metric, sigs] of signalsByMetric) {
    const rows = sigs
      .filter((s) => s.status === "ok" && (!countries || countries.includes(s.entity.entity_id)))
      // Growth series (yoy, diff) rank by their growth, levels by the level.
      .map((s) => ({ country: s.entity.entity_id, name: s.entity.name, value: s.metric.transform && s.metric.transform !== "level" && s.value.transformed !== null && s.value.transformed !== undefined ? s.value.transformed : s.value.current, as_of: s.value.as_of, score: s.composite_score, trend: s.trend, citation_url: s.provenance.citation_url, polarity: s.metric.polarity, label: s.metric.label }))
      .sort((a, b) => b.value - a.value)
      .map((r, i) => ({ rank: i + 1, ...r }));
    if (!rows.length) continue;
    metrics.push({ metric, label: rows[0].label, unit: sigs[0].metric.unit, polarity: rows[0].polarity, rows: rows.map(({ label, polarity, ...r }) => r) });
    for (const r of rows) {
      if (!byCountry.has(r.country)) byCountry.set(r.country, { country: r.country, name: r.name, scores: [] });
      if (r.polarity !== 0 && r.score !== null) byCountry.get(r.country).scores.push(r.score);
    }
  }
  const ranking = [...byCountry.values()]
    .map((c) => ({ country: c.country, name: c.name, score: c.scores.length ? Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length) : null, inputs: c.scores.length }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const top = ranking[0];
  const bottom = ranking[ranking.length - 1];
  return {
    vertical: vertical.id,
    title: vertical.title,
    question: vertical.question,
    horizon,
    status: metrics.length ? "ok" : "insufficient_data",
    summary: metrics.length
      ? `${ranking.length} ${unit} on ${metrics.length} indicators. Highest score: ${top.name || top.country} (${top.score}); lowest: ${bottom.name || bottom.country} (${bottom.score}). Scores compare each one with its own history, not with each other; use the ranked values for cross-${unit === "countries" ? "country" : "state"} levels.`
      : "No data has been collected yet for this table.",
    note: vertical.note,
    country_scores: ranking,
    metrics,
    citations: metrics.flatMap((m) => m.rows.map((r) => ({ label: `${m.label}, ${r.name || r.country}`, url: r.citation_url, as_of: r.as_of, source: vertical.source_id || "worldbank" }))),
    method: { version: VERSION, docs: "https://github.com/organiccryptoyyc/pocket-agentic-services/blob/main/pmic/packs/README.md" },
  };
}

// Peer table: one hub signal per (company, metric). Ranks the peers on each metric's latest value
// (the transformed value: yoy growth for flows, the level for ratios) and gives each company the
// mean of its rank positions, 100 = first, 0 = last. Unlike the other verticals this compares
// companies with each other, not with their own history.
function peerTable(vertical, signalsByMetric, { horizon, entity, peers }) {
  const metrics = [];
  const byCompany = new Map();
  for (const cfg of vertical.metrics) {
    const sigs = (signalsByMetric.get(cfg.metric) || []).filter((s) => s.status === "ok" && peers.includes(s.entity.entity_id) && s.value && Number.isFinite(valueOf(s)));
    if (sigs.length < 2) continue;
    const pol = cfg.polarity === undefined ? sigs[0].metric.polarity || 1 : cfg.polarity;
    const rows = sigs
      .map((s) => ({ entity_id: s.entity.entity_id, name: s.entity.name, value: valueOf(s), as_of: s.value.as_of, citation_url: s.provenance ? s.provenance.citation_url : null }))
      .sort((a, b) => pol * (b.value - a.value) || a.entity_id.localeCompare(b.entity_id))
      .map((r, i, all) => ({ rank: i + 1, ...r, score: Math.round((100 * (all.length - 1 - i)) / (all.length - 1)) }));
    metrics.push({ metric: cfg.metric, label: sigs[0].metric.label, basis: cfg.basis || null, unit: cfg.basis === "yoy growth" ? "percent" : sigs[0].metric.unit, peers_ranked: rows.length, rows });
    for (const r of rows) {
      if (!byCompany.has(r.entity_id)) byCompany.set(r.entity_id, { entity_id: r.entity_id, name: r.name, scores: [] });
      byCompany.get(r.entity_id).scores.push(r.score);
    }
  }
  const ranking = [...byCompany.values()]
    .map((c) => ({ entity_id: c.entity_id, name: c.name, score: Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length), metrics_ranked: c.scores.length }))
    .sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id))
    .map((c, i) => ({ position: i + 1, ...c }));
  const me = ranking.find((c) => c.entity_id === entity.entity_id) || null;
  const mine = metrics.map((m) => ({ m, r: m.rows.find((x) => x.entity_id === entity.entity_id) })).filter((x) => x.r);
  const enough = me && metrics.length && mine.length >= metrics.length / 2;
  const score = enough ? me.score : null;
  const label = labelFor(score, vertical.labels);
  const subject = `${vertical.title} for ${entity.name || entity.entity_id}`;
  const best = mine.length ? mine.reduce((a, b) => (b.r.score > a.r.score ? b : a)) : null;
  const worst = mine.length ? mine.reduce((a, b) => (b.r.score < a.r.score ? b : a)) : null;
  const summary = score === null
    ? `${subject}: not enough reported metrics to rank (${mine.length} of ${metrics.length}).`
    : `${subject}: ${score}/100, ${label}, position ${me.position} of ${ranking.length} on ${mine.length} metrics.` +
      (best && worst && best !== worst ? ` Best: ${best.m.label} (rank ${best.r.rank} of ${best.m.peers_ranked}); weakest: ${worst.m.label} (rank ${worst.r.rank} of ${worst.m.peers_ranked}).` : "");
  return {
    vertical: vertical.id,
    title: vertical.title,
    question: vertical.question,
    entity,
    horizon,
    status: score === null ? "insufficient_data" : "ok",
    score,
    label,
    position: me ? me.position : null,
    of: ranking.length,
    summary,
    scale: { high: `${HIGH}+ = ${vertical.labels.high}`, mid: `${LOW + 1}-${HIGH - 1} = ${vertical.labels.mid}`, low: `${LOW} or less = ${vertical.labels.low}`, note: vertical.note },
    drivers: mine.map(({ m, r }) => ({ metric: m.metric, label: m.label, basis: m.basis, value: r.value, rank: r.rank, of: m.peers_ranked, score: r.score, as_of: r.as_of, citation_url: r.citation_url })).sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50)),
    risk_flags: score === null ? ["insufficient_data"] : mine.length < metrics.length ? ["partial_coverage"] : [],
    confidence: { score: score === null ? 0 : Math.round(90 * (mine.length / metrics.length)), label: confidenceLabel(score === null ? 0 : Math.round(90 * (mine.length / metrics.length))), note: "Ranks use each company's latest SEC filing; fiscal quarters differ between companies." },
    peers: ranking,
    metrics,
    citations: mine.filter(({ r }) => r.citation_url).map(({ m, r }) => ({ label: `${m.label}, ${entity.name || entity.entity_id}`, url: r.citation_url, as_of: r.as_of, source: "sec" })),
    method: { version: VERSION, docs: "https://github.com/organiccryptoyyc/pocket-agentic-services/blob/main/pmic/packs/README.md" },
  };
}

function valueOf(s) {
  const v = s.value.transformed !== undefined && s.value.transformed !== null ? s.value.transformed : s.value.current;
  return typeof v === "number" ? v : Number(v);
}

module.exports = { VERSION, scoreMember, combine, filingRisk, countryTable, peerTable, labelFor, trendWord, fromPercentile };
