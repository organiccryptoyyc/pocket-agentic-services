# PMIC: Public Market Intelligence Collection

The data layer under the planned ~50 Pocket API service packs. It pulls official public
datasets on a schedule, keeps every raw payload, normalizes them into SQLite, runs quality
control, scores every series 0-100 with a rationale and citation, and serves it all through a
private query API. Each service pack is a thin paid Pocket service that calls this API.

Same conventions as the rest of this repo: Node only, zero npm dependencies (SQLite is Node's
built-in `node:sqlite`), JSON-object responses, inputs in the POST body, 4xx + JSON on bad
input, never a 5xx.

**Status:** code-complete for the first build and tested against recorded response shapes
(22 tests). Not yet run against the live APIs: this build environment's network policy blocks
every upstream host, so the first live pass happens on the Pi. Nothing is registered, staked or
deployed.

## How it fits together

Same shape as TCS-6: collect on the Pi, push to the Pocket server, serve from a cache.

```
Pi 5 / Umbrel                                         Pocket server (agentic.organiccryptoyyc.com)
┌──────────────────────────────────────┐              ┌────────────────────────────────────────────┐
│ pmic-collector  (bin/collect.js --loop)│  HTTPS+bearer │ pmic-hub :8091 /ingest/sync (private)      │
│  FRED BLS BEA SEC openFDA WorldBank   │ ────────────► │   same SQLite schema, rescored on arrival  │
│  raw/*.jsonl.gz + pmic.db (SQLite)    │  observations │ pmic-hub :8088 query API ◄── service pack 1 │
│ pmic-api :8088 (LAN, read-only)       │  + events     │                         ◄── service pack 2 │
└──────────────────────────────────────┘              │                         ◄── ... pack 50    │
                                                       └───────────────▲────────────────────────────┘
                                                                       │ each pack = own RelayMiner backend
```

- **Collector** (Pi): every 15 minutes it checks which series are due by cadence (daily for macro
  and market, weekly for slow series), fetches only those, and logs every request.
- **Hub** (Pocket server): receives pushes, applies its own retention, rescoring to the same numbers.
  The packs read it over the `pocket-supplier` docker network. It is never a RelayMiner backend itself.
- The Pi's own API (`pmic-api`) is the same server, useful on the LAN and for building packs
  before the hub exists.

## What it collects (first build: spec step 1)

318 series across 27 entities, all in [`config/`](config):

| Source | What | Series | Key |
|---|---|---|---|
| FRED | CPI, core CPI, PPI, payrolls, unemployment, participation, JOLTS, 2y/10y yields, curve slope, fed funds, retail sales, real GDP, industrial production, bank deposits and loans, card and mortgage delinquency, WTI, Henry Hub, copper, freight index, import/export prices | 24 | optional `FRED_API_KEY` (falls back to the public CSV) |
| BLS | Unemployment, payrolls, CPI-U, JOLTS, PPI final demand, hourly earnings (cross-checked against FRED) | 6 | optional `BLS_API_KEY` |
| BEA | Real GDP growth; value added for manufacturing, information, finance, health care, education | 6 | **`BEA_API_KEY` required** (free) |
| SEC EDGAR | 14 companies: revenue, operating and net income, operating cash flow (quarterly and FY), cash, debt, current assets/liabilities, total assets, operating/net margin, current ratio; weekly Form 4 counts; 10-K/10-Q/8-K/Form 4/13D/13G filing events | 217 | **`PMIC_SEC_USER_AGENT` required** (name + email, SEC fair access) |
| openFDA | Weekly recalls (all and Class I), original NDA/BLA and ANDA approvals, FAERS reports, label updates; per-company recall counts for PFE/LLY/JNJ; recall and approval events | 9 | optional `OPENFDA_API_KEY` |
| World Bank | 8 countries × GDP growth, inflation, unemployment, education and health spending, government expense, tertiary enrollment | 56 | none |

Left out on licensing grounds (third-party copyright inside FRED): UMich sentiment, LBMA gold, VIX,
ICE BofA spreads. Steps 2-5 of the spec (equity prices, more bank/consumer risk such as FDIC and
CFPB, clinical trials, entertainment and political spend) are new adapters plus config rows.

## Data model

Spec tables, plus `series` (the catalog), `observation_revisions`, `rollups_weekly` and `kv`. See
[`migrations/001_core.sql`](migrations/001_core.sql).

- **Raw payloads** are immutable gzip JSONL, `raw/<source>/<YYYY-MM-DD>.jsonl.gz`, one line per
  distinct body with its sha256. Unchanged payloads are not stored twice.
- **Observations** are deduplicated on `(source_id, entity_id, observation_time, metric_name)`.
  A changed value is a source revision: the old value goes to `observation_revisions`, the row's
  `revision` goes up and it is flagged `revised`.
- **Provenance**: score → observation → `raw_sha256` → raw file line → exact request in `fetch_logs`.
- **Events** (filings, recalls, approvals) are keyed by `(source_id, external_id)`.

## Quality control

Impossible values are rejected (negative counts, non-positive index levels, configured bounds).
Steps more than 8 robust z from a series' recent changes are stored but flagged `outlier`.
Gaps, stale series, API failures, schema changes, empty responses, missing keys and
FRED/BLS mismatches each raise a deduplicated alert (`POST /v1/alerts`), resolved automatically
when the condition clears. A failed series backs off 60 minutes before retrying.

## Retention

[`config/retention.json`](config/retention.json), applied once a day:

| Class | Days | Used for |
|---|---|---|
| raw | 380 | raw payload files |
| standard | 400 | daily and weekly series |
| macro_monthly | 800 | monthly series (year-over-year needs a year of lookback on top of 400 days) |
| slow | 3650 | quarterly and annual series (tiny) |
| derived, scores | 400 | the newest score per series is always kept |
| event_standard / event_high | 400 / 1095 | high-severity events (Class I recalls, 8-K non-reliance, bankruptcy...) are kept 3 years |
| rollup_weekly | 760 | weekly rollups of daily series |

A daily `VACUUM INTO` backup is kept for 7 days under `backups/`.

## Scoring

Every series gets current value, % change over 7/30/90/365 days (only horizons at least as long as
its period), z-score and percentile against the trailing year, freshness, source reliability, a
0-100 composite, trend, confidence, risk flags, rationale text and a citation URL. Method and
constants: [`docs/SCORING.md`](docs/SCORING.md).

## Query API (what the service packs call)

| Route | Body | Returns |
|---|---|---|
| `POST /v1/catalog` | `{category?, industry?, geography?, entity_id?, source_id?, q?}` | Series list with latest composite |
| `POST /v1/signal` | `{series_id}` or `{entity_id, metric_name}` | The marketplace answer: summary, composite, trend, risk flags, confidence, provenance, recent events |
| `POST /v1/signals` | filters + `{horizon, sort, direction, min_confidence, limit}` | Ranked answers |
| `POST /v1/series` | `{series_id, from?, to?, limit?, include_rollups?}` | Observation history with QC flags |
| `POST /v1/explain` | `{series_id, horizon}` | "Why": score then vs now, largest steps, events in the window |
| `POST /v1/events` | `{entity_id?, event_type?, severity?, industry?, since?}` | Filings, recalls, approvals |
| `POST /v1/entities` | `{entity_type?, industry?, geography?}` | Entities |
| `POST /v1/sources` | `{}` | Per-source health, success rate, open alerts, collector status |
| `POST /v1/alerts` | `{open_only?, source_id?}` | QC and fetch alerts |
| `GET /v1/health`, `/v1/version` | | Probes |

With `PMIC_API_TOKEN` set, POST routes need `Authorization: Bearer <token>`. How a pack maps onto
these routes: [`docs/SERVICE_PACKS.md`](docs/SERVICE_PACKS.md). A ready pack skeleton (scoped
proxy, cache, card / SAGE / portal templates) is in [`pack-template/`](pack-template).

## Run it on the Pi / Umbrel

```bash
git clone https://github.com/organiccryptoyyc/pocket-agentic-services && cd pocket-agentic-services/pmic
cp .env.example .env        # set PMIC_SEC_USER_AGENT, BEA_API_KEY, PMIC_API_TOKEN (others optional)
docker compose up -d --build
docker logs -f pmic-collector          # first pass backfills the retention windows
curl -s localhost:8088/v1/health
curl -s -H "Authorization: Bearer $PMIC_API_TOKEN" -d '{"series_id":"fred:UNRATE"}' localhost:8088/v1/signal
```

Without Docker: Node 22.13+, `PMIC_DATA_DIR=/path node bin/collect.js --loop` and `node server.js`.
Other CLI flags: `--force`, `--source fred,bls`, `--series fred:UNRATE`, `--rescore`, `--maintain`,
`--push`. CSV export: `node bin/export.js scores | observations <series_id> | events [entity_id]`.

Storage (estimated, not measured): the database stays small (tens of thousands of rows a year).
Raw payloads dominate: a new gzip copy is kept whenever an upstream body changes, which for the SEC
submissions files of busy filers is most days. Plan for roughly 0.5-1 GB a year plus 7 database
backups; drop SEC submissions to weekly cadence in `config/` if the card is small.

## Hub on the Pocket server

[`ops/docker-compose.hub.yaml`](ops/docker-compose.hub.yaml): one container on the
`pocket-supplier` network, ingest on 8091 (expose to the Pi through Caddy on its own route, as with
`/tcs6-ingest`), query API on 8088 for the packs. On the Pi set `PMIC_PUSH_URL` and
`PMIC_PUSH_TOKEN`; every pass then pushes new and revised observations and events (never raw
payloads), plus the collector's alert status.

## Verify locally

```bash
npm test
```

`test/collector.test.js` (15) runs the whole pipeline against `test/stub-upstream.js`, which
answers in each API's documented response shape: FRED CSV with `.` gaps and both header styles,
BLS footnotes and M13 rows, BEA's two `Results` shapes and comma-formatted values, SEC frames
with duplicate comparatives and concept switches, openFDA's 404 NOT_FOUND for zero matches, World
Bank `[meta, rows]`. `test/api.test.js` (5) starts the real server and checks the 200/4xx/never-5xx
contract, bearer auth and the hub listener. `test/pack.test.js` (2) runs the service pack
template against a live hub process. **The stub's shapes come from the APIs' published
documentation, not live captures**, so the first live run on the Pi is the real test; watch
`POST /v1/alerts` for `schema_change`.
