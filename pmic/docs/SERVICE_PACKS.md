# Building the service packs on PMIC

Each of the ~50 packs is a paid Pocket service with its own service id, card and RelayMiner
backend. All of them read the same hub, so adding a pack is configuration, not a new pipeline.

## The contract a pack can rely on

- **Catalog**: `POST /v1/catalog` lists every series with `series_id`, `source_id`, `entity_id`,
  `metric_name`, `category`, `industry`, `geography`, `frequency`, `unit`, latest composite.
  Categories today: `macro`, `credit`, `commodity`, `supply_chain`, `market`, `health`,
  `education`, `entertainment`, `political`.
- **Answer shape** (`/v1/signal`, each item of `/v1/signals`): `summary`, `value`, `changes_pct`
  (7d/30d/90d/365d), `zscore`, `percentile`, `composite_score`, `trend`, `risk_flags`,
  `confidence {score, label}`, `freshness_score`, `reliability_score`, `provenance` (citation URL,
  source and its terms URL, fetch time, raw payload sha256, revision, cross-check), `recent_events`.
  This is the spec's marketplace answer: sourced summary, composite, trend, risk flags,
  confidence, provenance links.
- **Filters**: industry, entity, geography, category, source, metric, free text; time horizon on
  `/v1/signals` and `/v1/explain`.
- **Why**: `/v1/explain` compares the score now against the one stored at the start of the horizon,
  lists the largest steps and the entity's events in the window.
- **Stable ids**: series ids are `source:native_id` (`fred:UNRATE`, `bls:LNS14000000`,
  `sec:AAPL:revenue_q`, `openfda:drug_recalls_weekly`, `worldbank:us:NY.GDP.MKTP.KD.ZG`) and do not change.

## Making one

Use [`../pack-template`](../pack-template): copy it, set `scope` in `pack.json`, fill the three
listing files. The template enforces scope, caches hub answers, serves stale on hub hiccups, and
follows the repo's response rules (JSON objects only, 400 on bad input, never a 5xx).

## When a pack needs data the catalog does not have

Add the series to `config/series.json` (or a new adapter under `lib/adapters/` for a new source),
redeploy the collector, and the next pass backfills it within its retention window. The pack
then scopes to it. New sources should follow the same rules: official, machine-readable,
licensed for redistribution of derived values, with a terms URL in `config/sources.json`.
