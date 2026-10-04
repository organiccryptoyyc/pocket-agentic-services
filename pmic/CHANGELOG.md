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

## 0.2.0 packs and collector (2026-10-04, from the first paid relay answers)

- Driver text now matches the driver score. When a vertical reads a series in the other direction
  from the hub (import prices as cost pressure, for example), the text used to quote the hub's
  composite. It now says "Scored N/100 in this brief".
- Pharma `company-safety` scores four per-company openFDA series instead of one: recalls naming the
  firm, FAERS adverse event reports for its products, original approvals (NDA, BLA, ANDA) and, as a
  watch item, label changes. The catalog grows from 312 to 321 series (`openfda.company_feeds`).
- FAERS lag: the FDA loads adverse event reports in batches, so the newest weeks read 0 and scored as
  "calm". FAERS series now stop at the last complete week with reports. Migration 004 deletes the
  zero weeks already stored on the Pi and the hub.
- Inputs the hub knows but has never collected are listed under `pending_inputs` (flag
  `inputs_pending`) and left out of coverage, so a newly added input doesn't blank a brief's score
  before the collector backfills it.
- Deploy: Pi rebuild (collector), then PSM Deploy for `pmic-hub` and the three packs. No
  re-registration and no POKT.

## Packs batch 1 (2026-10-04)

- `packs/`: 10 verticals bundled into 3 paid services to save registration fees (3,000 POKT instead
  of 10,000): `pmic-macro-signals` (7 verticals and an inflation calculator), `pmic-company-signals`
  (fundamentals, filing risk), `pmic-pharma-signals` (drug market, company safety).
- Each answer is a scored brief: 0-100 score, label, trend, drivers, risk flags, confidence and a
  citation per input (method `pmic-vertical/1.0`, in `packs/README.md`).
- Listings are generated per service (card, portal descriptor, SAGE yaml, OpenAPI). PSM folders
  are built by `node pmic/packs/ops/package-psm.js`.
- Live on MainNet 2026-10-04. Deployed on `hetzner-mainnet` (containers `<id>-backend`, relayer
  health `/healthz`); server test passed for all three. Beta was skipped by the owner's choice.
- Registered at 1,000 POKT each, 100,000 compute units per relay:
  `pmic-macro-signals` tx `13C220122C7865E33430599E3EFCDE8CE1B76784A1CBCB5BC8915F8BF53B568C`,
  `pmic-company-signals` tx `76013FFEACCA53888EE67ACD08C2D26B4BA08CA1C649A0945975C8A2BD2F074F`,
  `pmic-pharma-signals` tx `F5ABC787554042422697E628E834592EA280E2D416B41B3794A1B440F276667E` (block 950342).
- Supplier re-staked (tx `8FD22819F5E842E567E47E009050A5012E7D0592771DAC9BCA6AA86AD8E37622`, block 950343),
  stake unchanged at 60,000 POKT, five REST services active from block 950361. `pmic-hub` is not on chain.
- Paid relay tests passed on MainNet 2026-10-04 (6 of 6 HTTP 200, about 2.5-2.9 s): `/v1/verticals` and
  `/v1/brief` on each pack. Test apps, 1,100 POKT each (returned about 3 sessions after unstaking):
  owner wallet for macro (tx `0F2FC67ED6291608D7D7698FC17BDE11300724288F8668EC4883F5B65B18047D`),
  `pmic-company-app` (tx `82281EE093DE55C0A420FABA4DEE9BF6B9F29A464F14C77372A5C1B99BF1174F`),
  `pmic-pharma-app` (tx `5E949A689D60135FC705E97B585B61E1F09DCC303D07BB9A0B9201B8067BEE04`).
- Beta TestNet (2026-10-04, test POKT): registered `pmic-macro-signals` tx
  `F98DEAF59FEDFD9403A0353853C9E237E2E394745BECFA5E6CDC7DA57E0F5469`, `pmic-company-signals` tx
  `DD16E7EF052CACF00C010867E7A245815FF2B509D449F521841D5668BA43A25E`, `pmic-pharma-signals` tx
  `B034A95AF7CFC17A3C61416704C4C9A6285E67F4B8EBD676852F9B9BCF809D1F`. Beta supplier re-staked at
  https://beta.organiccryptoyyc.com (tx `EA1CFACB7B5C694FEF6F292F267092F4F526BDA208588E4DB212CB97F5BA49DE`),
  test apps staked, live relays passed. PNF stakes MainNet apps for paid use, so MainNet test apps
  get unstaked; future relay tests run on Beta.
- Known data quirk: openFDA FAERS counts for the latest weeks read near 0 because of reporting lag,
  which lifts the drug-market score. Fixed in 0.2.0.

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
