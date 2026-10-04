# PMIC service packs

Paid Pocket services that sell scored briefs built on the PMIC hub. Related verticals are bundled
into one service, so each bundle costs one registration fee and runs one container. Batches 1 to
3 have 36 verticals in 4 services (batch 2 added 13 to the existing services and 3 in one new
service; batch 3 added 10 to the existing four, so no new registration fee):

| Service ID | Verticals | Needs `entity_id` |
|---|---|---|
| `pmic-macro-signals` | macro-regime, inflation, labor, rates, credit-stress, commodities, global-compare, housing, consumer, country-risk, health-systems, education, yield-curve, bank-health, global-rates-fx, treasury-demand, energy-supply, trade-flows, business-formation (+ CPI inflation calculator) | no |
| `pmic-company-signals` | fundamentals, filing-risk, insider-activity, balance-sheet, peer-ranking, public-attention, earnings-quality, innovation | yes: aapl, msft, nvda, amzn, wmt, jpm, bac, xom, pfe, lly, jnj, unh, nflx, dis |
| `pmic-pharma-signals` | drug-market, company-safety, clinical-pipeline, drug-shortages | company-safety and clinical-pipeline: pfe, lly, jnj |
| `pmic-public-sector-signals` | product-recalls, political-money, federal-spending, natural-hazards, cyber-threat, disease-activity | no |

All data is free and public (FRED, BLS, BEA, SEC EDGAR, openFDA, World Bank, ECB, FDIC, CFPB, Wikimedia,
ClinicalTrials.gov, CPSC, NHTSA, FEC, Senate LDA, USAspending). Paid or
subscription sources are skipped for now; see `pmic/CHANGELOG.md`.

## What an agent buys

`POST /v1/brief {"vertical":"rates"}` returns one JSON object:

- `score` 0-100 with a `label` from the vertical's scale (for rates: easy / neutral / tight), and
  `trend` with `trend_basis`
- `summary`: one or two template sentences, no language model
- `drivers`: the inputs furthest from ordinary, with their own summaries and citations
- `risk_flags`, `confidence`, `coverage`
- `inputs`: every series with its score, how it was scored, value, changes, confidence and source
- `watch`: neutral series reported for how unusual they are, not averaged
- `citations`: a source URL for every input

`POST /v1/overview {}` returns every brief at once, in compact form (add `entity_id` for the company
bundle). `POST /v1/verticals {}` lists what the service sells. The raw scored series stay
available inside each bundle's scope: `/v1/signals`, `/v1/signal`, `/v1/explain`, `/v1/catalog`,
plus `/v1/events` for the company and pharma bundles.

## How a brief is scored (`pmic-vertical/1.0`)

1. **Inputs.** Each input is a hub series with its own 0-100 composite (see `pmic/docs/SCORING.md`).
   When the vertical reads a series in the hub's direction, the hub's composite is used as is.
   When the vertical gives a different `direction`, the pack scores it from the hub's percentile
   in that direction. Examples are oil read as cost pressure, or policy rates read as tightness.
   Neutral series without a direction are `watch` items.
2. **Score.** The weighted mean of the input scores (weights are in the bundle file). If inputs
   holding less than half the weight have a reading, the status is `insufficient_data` and the
   score is null.
3. **Label.** 60 or more is the high label, 40 or less the low one, and anything between is mid.
4. **Trend.** Once the hub has stored scores from the start of the horizon, the trend compares the
   score then and now, using the same inputs: a change of 5 points or more is a move
   (`trend_basis: score_history`). Until then, it is the weighted vote of each input's latest
   direction, signed toward a higher score: a net share of 25% or more is a move
   (`trend_basis: input_trends`).
5. **Flags.** `inputs_pending` (an input the hub has never collected yet; it is listed in `pending_inputs` and left out of coverage), `insufficient_data`, `partial_coverage` (under 75% of weight), `mixed_signals`
   (input scores spread with a standard deviation over 20), plus inputs' stale, mismatch, outlier,
   sharp-move, extreme-level and high-severity-event flags.
6. **Confidence.** The weighted mean of input confidence, scaled down when coverage is under 75%.

**Filing risk** starts at 100. Each 8-K with a high-severity item (1.03 bankruptcy,
2.04 triggering events, 2.06 impairment, 3.01 delisting, 4.01 auditor change, 4.02 non-reliance)
costs 25 points. Each medium-severity 8-K or 13D costs 8, and any other 8-K costs 1. Routine 10-K,
10-Q and 13G filings don't count. Insider Form 4 activity is a watch item.

**Peer ranking** ranks the 14 companies on the latest value of each metric (year-over-year growth
for revenue, operating income and operating cash flow; levels for operating margin, net margin and
current ratio). Each metric gives first place 100 and last place 0, and a company's score is the mean
of its positions. It compares companies with each other, unlike every other vertical.

**Country comparison** (global-compare, country-risk, health-systems, education) ranks the 8
countries on each World Bank indicator. It gives each country
the mean of its directional scores, which compare the country with its own history.

**Inflation calculator.** `POST /v1/inflation/adjust {"amount":100,"from":"2025-03"}` works for the
months the hub holds (the first backfill is about a year, and it grows with retention).

## Files

- `bundles/<service_id>.json`: what each service sells. Edit this to add a vertical.
- `server.js`, `lib/verticals.js`: the shared engine. `lib/http.js` is the hub's copy and
  `lib/net.js` the template's.
- `ops/build-listings.js`: writes `ops/<service_id>/` with `card.json`, `portal-descriptor.json`,
  `sage-service.yaml` and `openapi.json`. Re-run after editing a bundle.
- `ops/package-psm.js`: builds `~/Downloads/<service_id>/` for PSM (card.json, service.json,
  backend/, deploy/docker-compose.yaml). It reads the hub's API token from `pmic/.secrets/hub.env`.
- Tests: `pmic/test/packs.test.js` runs all three bundles against a real hub.

## Deploy (owner steps)

1. On the PC: `git pull`, then `node pmic/packs/ops/package-psm.js`.
2. In PSM (MainNet, hetzner-mainnet), **Deploy service** each of the three. This builds and starts
   them and spends no POKT.
3. Registering each service (1,000 POKT each, check the live fee in PSM) and re-staking the
   supplier with every service listed are separate steps that spend POKT. They are the owner's
   decision. `pmic-hub` is never registered or staked.
