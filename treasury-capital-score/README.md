# TCS-6: Crypto Treasury Capital Score

Pocket Network service `treasury-capital-score`: a paid, derived treasury
score for DeFi protocols and DAOs, built to
[`methodology/tcs6_scoring_blueprint_v1.json`](methodology/tcs6_scoring_blueprint_v1.json)
and returning reports that validate against
[`methodology/tcs6_paid_response_schema_v1.json`](methodology/tcs6_paid_response_schema_v1.json).
Same conventions as the other packages in this repo: zero npm dependencies,
JSON-only responses, POST-body inputs, never a 5xx.

**Status:** code-complete for the API side. Not registered, staked, or deployed.
See [`RUNBOOK.md`](RUNBOOK.md) for the gated steps.

## Routes

| Route | Body | Returns |
|---|---|---|
| `POST /v1/tcs6/score` | `{"entity_id":"aave"}` | Full report. `analysis_status` `ready` / `provisional` / `insufficient_data` are all 200. |
| `POST /v1/tcs6/entities` | `{}` or `{"peer_cohort":"DeFi protocol"}` | Registry listing + each entity's latest report status. |
| `GET /v1/version` | | `{"service":"treasury-capital-score","version":"1.0.0"}` |
| `GET /v1/health` | | `{"status":"ok","last_pipeline_run":...}` |

Missing/unknown `entity_id` or bad JSON → 400 + JSON.

## How it fits together

```
Pi (muttb) tcs6-pi-collector ──HTTPS+bearer──► Caddy ─► :8090 ingest ─► var/evidence/<id>.json
                                                                              │
                              tcs6-pipeline (every 12h) ── scoring core ──────┘
                                     │  schema-validate, then atomic write
                                     ▼
                              var/reports/<id>.json ◄── :8080 API (cache read) ◄── RelayMiner ◄── relay
```

- **Payment** is the relay (architecture §2). `payment_entitlement` is stamped per
  delivery: new `entitlement_id`, `payment_verified_at` = now, `delivery_expires_at` = null.
- **No LLM** touches anything yet. `rationale` text is deterministic templates in
  [`lib/report.js`](lib/report.js); the narrative pass (handoff step 5) may later
  rewrite text fields only.
- **Data rights:** reports contain aggregates, ratios, and citations. Per-asset
  vendor prices never leave the box; `internal_only`/`pending_review` sources are stripped.

## Layout

| Path | What |
|---|---|
| `server.js` | Paid API + probes; starts the ingest listener if `TCS6_INGEST_TOKEN` is set |
| `lib/scoring.js` | Deterministic core: haircuts, NRT, D1–D6, gates, coverage, confidence |
| `lib/report.js` | Assembles the schema-shaped report; rights filter; text scrubbing |
| `lib/schema.js` | Zero-dep validator for the paid schema + D1–D6/weights + SAGE phrase scan |
| `lib/ingest.js` | Private evidence-ingest listener (separate port) |
| `lib/store.js` | Atomic file cache under `TCS6_DATA_DIR` |
| `pipeline/run.js` | One scoring pass (`--loop` for every 12h) |
| `data/registry.json` | Entity registry seed |
| `EVIDENCE.md` | Bundle contract for the Pi collector |
| `ops/package-psm.js` | Builds the Pocket Service Manager folder in `Downloads\treasury-capital-score` |
| `ops/psm/` | PSM deploy files: `backend-compose.yaml` (API + pipeline), `routes.json` (ingest route) |
| `ops/sage-service.yaml`, `ops/pocket-health-checks-entry.yaml` | Gateway listing |

## Verify locally

```bash
npm test
```

15 tests on synthetic entities only (`example-dao`, never a real protocol).
Also run during the build, against a live local instance: Pocket's
`lint_backend.py` (9/9 pass, including 3 bad-input probes) and
`validate_card.py` and PSM's `psm_validate_card` (card 3.3 KiB).

## Registry

[`data/registry.json`](data/registry.json): seeded from `defi_protocol_registry_additions_20261001.json`
and the handoff decisions.

- **Scoreable:** aave, maker-sky, compound, lido, curve, morpho, yearn-finance.
- **Excluded:** balancer (wind-down; your decision of 2026-10-01).
- **Listed only:** uniswap and rocket-pool (provisional); pancakeswap, stargate-finance, machinex (need first-time vetting).

Each scoreable entity has a `treasury_addresses` map: chain, address, role,
`perimeter`, source, and on-chain check, all verified 2026-10-01.

- **`perimeter`** is `include` (holdings to value), `control_only` (governors, executors, timelocks), or `adjacent_excluded` (tracked, not counted).
- **Sources:** Aave address book (10 chains), Sky chainlog, Compound Comet deployment roots (each market's `governor()` returned the Timelock), and the Lido, Curve, Morpho, and Yearn docs.
- **Docs that are out of date:** Morpho's governance Safe is live at 6-of-10 (docs say 5/9), and its rewards Safe at 3-of-7 (docs say 3/5).

## Methodology decisions (confirmed 2026-10-01)

Each is a named constant in `lib/scoring.js`.

1. **Anchors:** linear interpolation between anchor thresholds; the 0 anchor below the first threshold.
2. **Haircuts:** midpoint of the class range by default; documented condition flags move it +¼ range each, or the collector gives an explicit `haircut_severity`.
3. **Control factor:** 1 only when control is verified, otherwise 0.
4. **HQLA (D2):** cash equivalents, fiat-backed stablecoins, BTC/ETH-class assets, *excluding* any flagged `redemption_limits`, `legal_restriction`, `lockup`, `unlock_pending`, `depeg_active`, `thin_depth`, or `custody_concentration`.
5. **Stress set `tcs6-stress-v1`:** stable −10%, large-cap −50%, long-tail −70%, LP/lending −60%, native −80%, locked −80%. It is labelled "severe stress scenario (not a forecast)" in every report.
6. **D4 caps:**
   - A single non-cash exposure above 50% caps D4 at 75.
   - Two or more non-cash exposures sharing a collector `correlation_group` (e.g. `eth` for ETH/WETH/stETH) above 50% combined cap D4 at **60**. The 60 is a value I chose for the lower cap you asked for; change `CORRELATED_CAP` if you want it different.
7. **D1:** mid-rank percentile within the cohort, including the entity.
8. **D6:** step scoring. Every rubric input and the rule that fired (`d6_rubric_step`) are published as metrics.
9. **control_coverage below 60%:** the score is still issued, marked provisional, with confidence capped at 59 (label `low`).
10. **Confidence inputs:** source quality is the mean tier score of delivered sources (T1 100, T2 75, T3 50, T4 30, T5 10). Consistency is value-weighted price agreement. Recency is the value share that is fresh under the freshness gate's thresholds.
11. **Launch coverage:** D1 is null below 20 peers, so maximum coverage is 80%. That is the blueprint's "score allowed, gaps prominent" band.
