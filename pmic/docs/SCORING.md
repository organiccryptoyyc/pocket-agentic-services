# PMIC scoring method (`pmic-derive/1.0`)

Deterministic: the same stored observations always produce the same numbers. Constants are named
in [`lib/derive.js`](../lib/derive.js); changing any of them should bump `TRANSFORM_VERSION` so old
and new scores never mix. Every score row records the version it was built with.

## Inputs per series (config/series.json)

- **frequency**: daily, weekly, monthly, quarterly, annual.
- **transform**: what the level statistics use. `level` (the value), `yoy_pct` (vs the observation a
  year earlier, used for index levels and dollar aggregates that trend), `mom_pct`, `diff` (change vs
  previous observation, used for payrolls).
- **polarity**: +1 higher reads stronger, -1 higher reads weaker (unemployment, delinquency, inflation,
  recalls), 0 neutral (yields, commodity prices, filing counts).

## Outputs

| Field | Definition |
|---|---|
| current_value | Latest observation, raw units. |
| pct_change_{7,30,90,365}d | Raw value vs the latest observation at or before that many days earlier. Null when the horizon is shorter than 0.8 of the series period (no 7-day change on monthly data) or no observation is close enough. Negative bases handled as change / abs(base). |
| zscore, percentile | Current transformed value against the trailing 365 days of transformed values (excluding the current one). If that window has fewer than 8 points (quarterly, annual) the last 12 points are used. Fewer than 4 points: null, flag `insufficient_history`. Percentile is mid-rank (ties count half). |
| momentum (derived_metrics) | tanh(change in transformed value over 90 days (365 for annual) / (1.5 × median absolute 90-day change in the series' history)). |
| composite_score 0-100 | 0.6 × level + 0.4 × momentum. Directional series: level = percentile (inverted for polarity -1), momentum = 0.5 + 0.5 × momentum × polarity. Neutral series: level = abs(2 × percentile - 1), momentum = abs(momentum), so the score reads "how unusual". Either part alone if the other is missing; null if both are. 50 is ordinary for directional series. |
| trend | Sign of the transformed value's change over max(30 days, one period), with a dead band of 10% of the typical 90-day move: up, down, flat, or unknown. |
| freshness_score | 100 while the latest observation is within its allowance (period + typical publication lag: daily 5 days, weekly 17, monthly 76, quarterly 212, annual 916, measured from observation_time), then linear down to 0 at 2.5 × the allowance. 0 raises a `stale` alert. |
| reliability_score | Source base score (config/sources.json: tier-1 agencies 95-97, FRED 90, World Bank 85) minus up to 30 for the failure rate of the source's last 10 fetches. |
| confidence_score | 0.4 × reliability + 0.35 × freshness + 0.25 × depth (history points / 12, capped), then -15 if the current value is an outlier, -10 if preliminary, -10 on a cross-source mismatch, +5 when a second source agrees. Labels: high ≥ 75, medium ≥ 50, low. |
| risk_flags | stale_data, insufficient_history, outlier_current, preliminary_value, revised_by_source, extreme_level (percentile ≤ 5 or ≥ 95), large_deviation (abs z ≥ 2), sharp_move (abs momentum ≥ 0.9), source_fetch_failures, cross_source_mismatch, single_source, high_severity_event_30d (the entity had a high-severity event in the last 30 days). |
| rationale | Template text built from the numbers above. No language model. |
| citation_url | The human-checkable page for the exact value (FRED series page, BLS series page, the SEC filing the fact came from, the openFDA query, the World Bank indicator page). |
| provenance | observation id, fetch time, raw payload sha256 and file, revision, cross-check result, history points, window start, source terms URL. |

## Observation times

Statistical series use the start of the period (FRED's convention; BLS and BEA are converted to it,
World Bank years become YYYY-01-01). SEC XBRL values use the period end date the filing reports.
Weekly count series (openFDA, Form 4) use the Monday that starts the week and only complete weeks
are emitted, so the current partial week never reads as a drop.

## What this is not

A score describes one public series against its own history. It is not a valuation, forecast or
investment advice, and no single series should drive a decision (spec note). Service packs that
combine series should say how, and keep the per-series citations.
