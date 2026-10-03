# TCS-6 scoring specification, v1 (frozen)

Status: **frozen 2026-10-02** (Install 2, build step 1). This file describes the live MainNet/Beta
behaviour exactly as `lib/scoring.js` + `lib/report.js` implement it. The golden fixtures in
`test/fixtures/golden/` are its executable form: if code and this text disagree, the fixtures win,
and the disagreement is a bug in this text.

Authoritative methodology: `methodology/tcs6_scoring_blueprint_v1.json` (user-supplied). Output
contract: `methodology/tcs6_paid_response_schema_v1.json`. Input contract:
`spec/evidence_input_v1.schema.json` (this build; mirrors `EVIDENCE.md`).

## 1. Version identifiers

| Identifier | v1 value | Where it appears | Changes when |
|---|---|---|---|
| `method_version` / `spec_version` | `tcs-6/1.0` | every report (`overall_score.method_version`), snapshot store | any change to a score, metric, gate, band, or rationale for the same input |
| `weights_version` | `blueprint-v1` | snapshot store (`reports.weights_version`) | any dimension weight changes (v1: 20/20/15/15/15/15) |
| `schema_version` | `tcs-6-paid-response/1.0` | every report | any output field added/removed/retyped (v1 schema is `additionalProperties:false` everywhere) |
| input schema | `tcs-6-evidence-input/1.0` | `spec/evidence_input_v1.schema.json` | a field the engine reads is added/removed/retyped |
| stress set | `tcs6-stress-v1` | D4 metrics in every report | any shock parameter changes |
| `snapshot_id` | `snap_<sha256>` | snapshot store; v2 reports | never changes for the same bundle (content address) |

v1 reports cannot carry `snapshot_id`, `spec_version` or `weights_version` (schema is closed); the
snapshot store records them next to each report. `tcs-6-paid-response/2.0` (decision D2) adds them to
the body.

### Versioning rules

1. **Patch** (`tcs-6/1.0` stays): refactors, new routes, new optional stores, docs. Golden fixtures
   must stay byte-identical. No owner sign-off needed beyond normal review.
2. **Minor** (`tcs-6/1.1`): any change to a live output for an existing input (a haircut, an anchor,
   a gate threshold, rationale wording). **Owner sign-off first** (CLAUDE §9), then
   `node ops/freeze-golden.js --force`, then bump `METHOD_VERSION`.
3. **Major** (`tcs-6/2.0`): new dimension model (T1–T6, decision D1) or new output schema. Runs
   beside v1; v1 routes keep answering with v1 for existing callers.
4. New or changed weights ship as `weights_status: "provisional"` until a 30–50 event backtest
   (rule 6). Never tuned by feel.

## 2. Reproducibility contract

A v1 report is a pure function of four inputs:

```
report = buildReport(entity, bundle, computeBase(bundle), peer_nrts)    // method tcs-6/1.0
```

- `entity`: the registry row (`data/registry.json`).
- `bundle`: the evidence bundle; `as_of` and all freshness checks use `bundle.collected_at`, never
  the wall clock.
- `peer_nrts`: Net Realizable Treasury of every same-cohort entity scored in the same pipeline pass
  (D1 is a percentile). With no peers the engine passes `[own NRT]`.
- The only non-deterministic field is `report_id` (random UUID). The golden test normalizes it.

The snapshot store (`lib/snapshots.js`, enabled with `TCS6_SNAPSHOTS=1`) stores `bundle` under its
`snapshot_id` and the report with `peer_nrts`, `spec_version` and `weights_version`, which is everything
needed to rebuild it (`test/snapshots.test.js` proves this).

## 3. Pipeline

1. Skip bundles older than `TCS6_MAX_EVIDENCE_AGE_HOURS` (24); the previous report is kept.
2. `computeBase`: value every holding (§4), dedupe by `exposure_id`, NRT = Σ verified realization
   value − probability-weighted obligations.
3. D1–D6 (§5), hard gates (§6), overall (§7), confidence (§8).
4. Validate against the paid schema plus server rules (exactly D1–D6, weights total 100, no SAGE
   gateway phrases in any text). A failing report never replaces the cached one.

## 4. Valuation

- Fair value = quantity × price (lower of two prices if they disagree by more than 2%), or
  `fair_value_usd` for disclosed off-chain balances.
- Only `control: verified` rows count toward capital; unverified rows are reported only.
- Haircut ranges (percent): cash_equivalent 0–5 · fiat_stablecoin 2–10 · major_crypto 5–20 ·
  liquid_alt 15–40 · lp_position 30–70 · native_token 60–100 · locked_unverifiable 50–100.
  Position = midpoint + ¼ range per documented flag (or explicit `haircut_severity`).
  `native_token` + `no_orderly_exit` = 100%. `locked_unverifiable` without
  `realization_path_evidenced` = 100%.
- HQLA (D2) = cash_equivalent, fiat_stablecoin, major_crypto **without** any of: redemption_limits,
  legal_restriction, lockup, unlock_pending, depeg_active, thin_depth, custody_concentration.

## 5. Dimensions (weights blueprint-v1)

| Id | Weight | Metric | Anchors (value → score) |
|---|---|---|---|
| D1 | 20 | same-cohort NRT percentile (mid-rank) | null below 20 peers |
| D2 | 20 | runway months = 12 · HQLA / 12-month cash uses | 3→25, 6→50, 12→75, 24→100; no cash-use data → 0 |
| D3 | 15 | NRT / enforceable obligations | 0.75→25, 1.0→50, 1.5→75, 2.0→100 |
| D4 | 15 | survival under `tcs6-stress-v1` | 0→25, 35→50, 55→75, 75→100; cap 75 if one non-cash asset > 50%; cap 60 if a correlated non-cash group > 50% |
| D5 | 15 | self-funding ratio % | −50→25, 0→50, 25→75, 75→100 |
| D6 | 15 | control/governance step rubric | 0/25/50/75/100; inputs and fired step published |

Stress shocks (`tcs6-stress-v1`, "severe stress scenario, not a forecast"): cash 0 · stablecoin 10 ·
major 50 · liquid_alt 70 · LP 60 · native 80 · locked 80 (percent).

## 6. Hard gates

`entity_identity`, `control_coverage` (≥ 60% verified; below → provisional, confidence ≤ 59),
`valuation_freshness` (prices ≤ 60 min, holdings ≤ 90 days before `as_of`), `obligation_visibility`,
`source_rights` (`internal_only` / `pending_review` sources are dropped from the report with every
reference to them).

## 7. Overall score

- Coverage = Σ weights of non-null dimensions.
- **Withheld** (`insufficient_data`) if entity identity fails, or obligations are not visible and not
  bounded, or coverage < 60.
- Base = weight-normalized mean of available dimensions; final = round(clamp(base − penalties, 0, 100)).
- **Provisional** (no band) if coverage < 80, control coverage fails, or obligation visibility isn't
  a pass. Otherwise **eligible** with band: strong ≥ 85 · positive ≥ 70 · watch ≥ 55 · weak ≥ 40 · reject.
- 80–90% coverage adds a prominent `overall_score.coverage_pct` data gap.

## 8. Confidence

`0.35·source_quality + 0.30·coverage + 0.20·cross_source_consistency + 0.15·recency_fit`
(source tiers 1–5 = 100/75/50/30/10). Labels: high ≥ 80, medium ≥ 60, low.

## 9. Known v1 limitations (recorded, not fixed: fixing any of them is a minor/major bump)

- Lending receipts (aTokens, cTokens, vault shares) are classified `lp_position` by the collector, so
  stablecoins held that way don't count as HQLA (seen on Aave 2026-10-02: $0.96M HQLA).
- D1 is null until a cohort has 20 entities (live: 7).
- Money is JS floats rounded at output (CLAUDE §7 asks integers/Decimal in new code).
- No history in the v1 cache (latest only). Addressed by the snapshot store (opt-in).

## 10. Install 2 (v2) outline — draft, not frozen

Decided 2026-10-02 (CLAUDE §10): v2 is `tcs-6/2.0` beside v1 (D1), new output schema
`tcs-6-paid-response/2.0` (D2), both bands and a status (D3), SQLite snapshots (D5), cost object (D10).

| v2 dim | Name | Built from v1 |
|---|---|---|
| T1 | Treasury solvency | D2 runway + D3 coverage |
| T2 | Liquidity quality | haircut engine + HQLA + **new** DEX slippage facts |
| T3 | Concentration | D4 (top-1, native %, correlated groups) + chain/venue/counterparty |
| T4 | Protocol exposure | **new**: contract, bridge, oracle, venue risk (hack-signal feed, D7) |
| T5 | Governance control | D6 |
| T6 | Capital productivity | D5 |
| — | Scale (v1 D1) | reported as context, not weighted in v2 (plan has no equivalent) |

- `status`: strong/positive → Healthy · watch → Watch · weak/reject → Critical (thresholds in this spec).
- Separate fields, never blended: `base_score`, `external_risk_overlay`, `forward_score`.
- Every v2 response carries `snapshot_id`, `spec_version`, `weights_version`, `weights_status`, and the
  `cost` object (CLAUDE §10 D10).
