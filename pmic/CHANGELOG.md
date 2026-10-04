# PMIC version notes

## Standing rules (carry into every version)

- **Never use Register service, Suppliers or staking for `pmic-hub`.** The hub is private: it is the
  data layer under the PMIC service packs, not a paid service. It is only ever deployed through PSM's
  **Deploy service** page. Only the individual service packs are registered and staked.
- The hub push token (`PMIC_INGEST_TOKEN`) lives only in `pmic\.secrets\hub.env` on the packaging
  PC, in the generated PSM compose file, and in the Pi's `.env`. Never paste it into chat or commit it.
  If it leaks, delete `hub.env`, re-run `node pmic/ops/package-psm.js`, redeploy `pmic-hub` and update the Pi.
- Skip any data source that needs a subscription or a paid license for now (owner's rule, 2026-10-04).
  Skipped items stay listed with the reason, so we know why they weren't chosen.
- Never merge to `main` without the owner's go-ahead.

## Packs batch 1 (2026-10-04)

- `packs/`: 10 verticals bundled into 3 paid services to save registration fees (3,000 POKT instead
  of 10,000): `pmic-macro-signals` (7 verticals and an inflation calculator), `pmic-company-signals`
  (fundamentals, filing risk), `pmic-pharma-signals` (drug market, company safety).
- Each answer is a scored brief: 0-100 score, label, trend, drivers, risk flags, confidence and a
  citation per input (method `pmic-vertical/1.0`, in `packs/README.md`).
- Listings are generated per service (card, portal descriptor, SAGE yaml, OpenAPI). PSM folders
  are built by `node pmic/packs/ops/package-psm.js`.
- Not yet deployed, registered or staked.

## 0.1.0 (2026-10-04, branch `market-intel-collector`, draft PR #1)

First build: FRED, BLS, BEA, SEC EDGAR, openFDA and World Bank on a Raspberry Pi 5 (`muttb`).

- Collector, scoring (`pmic-derive/1.0`), QC, retention and the query API, with zero npm dependencies.
- Verified live on the Pi: every source parses real responses. The catalog is now 312 series after
  switching off concepts the companies or countries don't report (JPM and XOM long-term debt, JNJ
  operating income, China government expense, and others listed in `config/series.json`).
- The outlier check now runs only on recent data. Migrations 002 and 003 cleared the false alarms
  from the first backfill. The Pi ran with zero open alerts on 2026-10-04.
- Hub: `node pmic/ops/package-psm.js` builds `Downloads\pmic-hub` for PSM. It deploys to
  `hetzner-mainnet` as container `pmic-hub-backend` (API 8080, ingest 8091 behind the route
  `/pmic-ingest`). Steps are in `docs/HUB_SETUP.md`. The packager doesn't print the token.
- The hub and the pack template answer `GET /healthz`, the path PSM probes after a deploy.
