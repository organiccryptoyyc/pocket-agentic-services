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

## Packs batch 4 (2026-10-05): 24 verticals, 16 new sources, no new registration

- The owner's list (2026-10-05): the 14 suggested verticals plus crypto-liquidity, food-inflation,
  investment-cycle, climate-anomaly, travel-demand, imf-outlook, rulemaking, medicare-providers,
  settlement-fails (replaces short-interest) and nonprofit-finance, then economic-calendar,
  leading-indicators, institutional-ownership, fda-enforcement, legislation and
  environmental-compliance; public-safety dropped. 24 verticals, 60 in the four services.
- Probed live from the PC (2026-10-05), all free with no paid key: the Pocket Network indexer
  (data.pocket.network GraphQL), DefiLlama, NIFC WFIGS (ArcGIS), NOAA NCEI Climate at a Glance, TSA
  checkpoint numbers, IMF WEO (api.imf.org SDMX; imf.org and data.imf.org block scripts), Federal
  Register, CMS Medicare Monthly Enrollment, SEC fails-to-deliver zips, the BLS and BEA release
  calendars (iCalendar), OECD composite leading indicators (sdmx.oecd.org, CC BY 4.0), the FDA warning
  letter table, Congress.gov (laws with DEMO_KEY; bill counts need an api.data.gov key), EPA ECHO
  enforcement cases, and 17 new BLS series. The IRS Form 990 extracts (2018-2024) and the SEC 13F data
  sets were parsed from the real files on the PC. The FRED state series and ISRATIO are checked from
  the Pi (`ops/probe-batch4.sh`) because FRED times out from the PC.
- `pmic-macro-signals` 0.5.0 (+8): `pokt-network-health` (weekly estimated relays, staked suppliers
  and apps; claimed relays as a watch item), `crypto-liquidity` (stablecoin supply, DeFi TVL),
  `supply-chain-pressure` (BLS PPI truckload, deep sea, air freight, transportation services;
  inventories-to-sales and the freight index as watch items), `food-inflation` (CPI food at home,
  away from home, meats/poultry/fish/eggs, dairy), `state-labor` (12-state table: unemployment and
  payroll growth from FRED), `imf-outlook` (8-country table: WEO growth, inflation, unemployment,
  government debt including next year's projection), `economic-calendar` (how ordinary the latest
  CPI, payrolls, unemployment, GDP, consumer spending, PPI, job openings and retail sales prints
  were, plus `upcoming_events`: the next major BLS and BEA releases in UTC) and `leading-indicators`
  (8-country table of OECD composite leading indicators).
- `pmic-company-signals` 0.5.0 (+5): `shareholder-returns` (buybacks, dividends),
  `interest-coverage` (new ratio operating income / interest expense; banks leave interest expense
  out), `investment-cycle` (capex, new ratio capex / revenue), `settlement-fails` (SEC
  fails-to-deliver dollar value per month; a month is stored only when both half-month files are
  out) and `institutional-ownership` (13F filers holding the stock and the value they report, per
  quarter).
- `pmic-pharma-signals` 0.5.0 (+3): `device-safety` (openFDA device recalls, Class I recalls, MAUDE
  adverse events with the same lag rule as FAERS), `drug-prices` (CPI prescription drugs and medical
  care commodities, PPI pharmaceutical preparations) and `fda-enforcement` (FDA warning letters, all,
  drug and biologic, device; letters as events, tied to Pfizer, Lilly or J&J when named).
- `pmic-public-sector-signals` 0.3.0 (+8): `wildfire-activity`, `climate-anomaly` (departures from
  the 1991-2020 normal, scored as closeness to normal via the new `score_unusualness` member option),
  `travel-demand` (TSA weekly passengers, year over year, with 800 days of history),
  `rulemaking` (final, proposed and significant rules; significant rules as events),
  `medicare-providers` (Medicare enrollment in total and in Medicare Advantage; Original Medicare as
  a watch item), `legislation` (public laws enacted and bills introduced; new laws as events),
  `environmental-compliance` (EPA cases with a milestone each month, penalty and judicial cases;
  penalties settled as a watch item) and `nonprofit-finance` (Form 990 revenue, contributions,
  assets and returns by IRS processing year).
- Swapped sources, owner informed (2026-10-05): short-interest became `settlement-fails` because
  FINRA's free data is "not intended for commercial purposes"; the NY Fed GSCPI became BLS freight
  PPIs (federal data with an API); NADAC drug prices became BLS CPI/PPI; CMS provider enrollment
  became Medicare monthly enrollment (a time series, not a provider list). OECD business and consumer
  confidence are left out because some countries' series are built from licensed surveys.
- Dropped: `public-safety` (FBI Crime Data Explorer), owner's call (2026-10-05).
- Bulk files: the 13F windows (about 85 MB each, 11 on the first run, about 950 MB) and the Form
  990 extracts (about 50 MB each, 7 on the first run, about 360 MB) are streamed line by line, read
  once, and not kept: the raw store gets their size and hash only (`bulk: true` in `ctx.get`, 10
  minute timeout). After the first run, one new 13F window a quarter and one 990 year a year.
- New keys, both optional: `CONGRESS_API_KEY` (falls back to `FEC_API_KEY`; without either, only
  laws are counted). ECHO needs a browser-like User-Agent (Node's default gets a 503).
- Pi probe (2026-10-05): every batch 4 source passed except EPA ECHO, which answered 429 after
  about 15 requests. ECHO now reads newest month first, 3 seconds apart, keeps finished months
  between passes (only the last six are re-read), and on a 429 keeps what it has and carries on
  next pass, like FEC.
- Card descriptions list verticals by id only when the list with questions would go over the
  2,048-character on-chain limit (macro now does). Public sector is 2,028 characters.

## Packs batch 3 (2026-10-04): 9 verticals, 9 new sources, no new registration

- Probed live from the PC before building (2026-10-04): TreasuryDirect, OpenFEMA, USGS, NWS, CISA
  KEV, NIST NVD, CDC NSSP (data.cdc.gov vutn-jzwm) and openFDA drug shortages all answer with no
  key. The Census trade API now needs a key and EIA does too, so trade and energy come from FRED,
  which republishes both.
- `pmic-macro-signals` 0.4.0: `treasury-demand` (bid-to-cover, indirect and dealer shares, high
  minus median yield; weak auctions as events), `energy-supply` (EIA crude and gasoline stocks,
  gasoline and diesel prices; refinery use as a watch item), `trade-flows` (balance, exports;
  imports in total and from China, Mexico and Canada as watch items), `business-formation`
  (Census BFS applications, high-propensity applications, projected formations).
- `pmic-company-signals` 0.4.0: `earnings-quality` (new SEC ratios `cash_conversion` = operating
  cash flow / net income, `cash_flow_margin` = operating cash flow / revenue).
- Dropped: `innovation` (patents). The PatentsView API was shut down when PatentsView moved into
  the USPTO Open Data Portal (2026), whose API key needs a USPTO.gov account with MFA and a
  driver's licence ID check. Owner's call (2026-10-05): skip it.
- `pmic-pharma-signals` 0.4.0: `drug-shortages` (new FDA shortage and discontinuation postings
  weekly; resolved is a watch item because the FDA keeps only about 19 resolved records).
- `pmic-public-sector-signals` 0.2.0: `natural-hazards` (FEMA declarations counted once per
  disaster, USGS M4+ US region and M6+ worldwide, NWS active severe alerts as a daily snapshot),
  `cyber-threat` (CISA KEV additions and ransomware use weekly, NVD critical CVEs monthly) and
  `disease-activity` (CDC emergency department share for COVID-19, flu and RSV).
- Composite verticals take `event_types` to narrow `events_entities` (drug-shortages lists
  shortages, not the market's recalls).
- Pi probe (2026-10-05): FRED answered 404 for the EIA weekly stock and refinery series (WCESTUS1,
  WGTSTUS1, WPULEUS3) and for the Census BFS ids, so those six now come straight from the
  publishers with no key: new `eia` adapter (dnav weekly history table) and `census` adapter (BFS
  monthly CSV, US total, seasonally adjusted). Gasoline and diesel prices and trade stay on FRED.
- Live on MainNet 2026-10-05: hub and the four packs deployed with /v1/selftest health (36/36 verticals pass; macro, company and pharma over paid MainNet relays, public sector via its Beta app). Macro's description was shortened so its card stays under the 2,048-character description limit. Card updates (gas only): macro C5897E5C0EE779FFE4D26886F365F8BF6B9527C7ECA8E7D99600811F10B08101, company BE232CF93F9BA6EA1C493ADDBDF37AF0DB49708071533FD3640948F251683E80, pharma B63DC1D4A3C772309E2DB1FC21E9B97D220A86ECF85FF1B05DE1E17B06D5EE61, public sector A95B345539E771156D4C3AEA322492C7A2095DDE6925A7E409A9E608DE49F547.
- Catalog 536 -> 597 series. Tests 55/55 (new `test/batch3.test.js`, stub `test/stub-batch3.js`).
- Pi check: `sh ops/probe-batch3.sh`. Deploy: Pi rebuild, PSM Deploy `pmic-hub` and the four
  packs, then gas-only card updates for all four. No new fee.

## Packs batch 2, phase 2 (2026-10-04): 8 verticals, 11 new sources, one new service

LIVE on MainNet 2026-10-04:
- Hub redeployed (316,416 bytes, 536 series). Pi first push after the upgrade: 8,059 observations, 790 events.
- macro, company and pharma packs redeployed at 0.3.0; paid self-tests pass 24/24 verticals.
- Card updates (gas only): macro 6CFE0E8F0D9BCA5D11359733572B00E2DEE2F8ED30648D85F006E2FD071D3687, company 86757EC32A559922760484598DAAE36DA5788B436E931A8B68FAB201675CD69C (block 950580), pharma E5B5A65FA30C1695E324BCD560884A34649AC97035C8318B54785049E08E674B (block 950582).
- pmic-public-sector-signals 0.1.0 deployed (server /v1/selftest passes 3/3), registered at 100,000 compute units per relay: 1D5981C858E740D2712F04D190E0E03F298BA1435268625B3FF8F84E71EB689B (fee 1,000 POKT).
- Supplier restake 8BC2F212971CA01BE632DE887B86C0FEACCD67A9CF54E8B9BA55B5683843AC9C (block 950585): 60,000 POKT, six services (prediction-market-intel, treasury-capital-score, pmic-macro-signals, pmic-company-signals, pmic-pharma-signals, pmic-public-sector-signals), active from block 950601. pmic-hub is not on chain.
- Owner wallet 5,053.6 -> 4,052.5 POKT.

Probe fixes (after the first live run on the Pi):
- ClinicalTrials.gov: ask for StartDateType and CompletionDateType, without which starts and completions were always 0.
- Wikipedia edits: stop at the last month Wikimedia has published (about a month behind) instead of counting unpublished weeks as 0.
- ECB: policy rates (deposit, main refi) list only change dates, so the rate in force is carried forward to every weekday.
- FEC: a 429 keeps the months already read and finishes on later passes. A free api.data.gov key in FEC_API_KEY avoids the shared DEMO_KEY limit.
- Fetch errors now include the underlying reason (DNS, refused, TLS), to diagnose the USAspending failures on the Pi.
- Second probe on the Pi: all 95 series ok (FEC with its api.data.gov key). The ECB moved HICP to a new HICP dataflow in 2026 (the old ICP one is frozen at 2025-12), so euro area inflation now reads ecb:HICP.M.U2.N.000000.4D0.ANR, plus core HICP ecb:HICP.M.U2.N.XEF000.4D0.ANR (headline 3.8% and core 2.5% for September 2026, checked live).

- New collectors, all free official data with no paid license: ECB Data Portal (policy rates, euro
  STR, HICP, five euro reference rates), FDIC BankFind (bank failures), CFPB complaint database,
  Wikimedia pageviews and edits, ClinicalTrials.gov v2, CPSC recalls, NHTSA recalls (DOT open
  data), OpenFEC (Schedule E; `FEC_API_KEY` optional, DEMO_KEY otherwise), Senate LDA (lobbying;
  `LDA_API_KEY` optional), USAspending, World Bank Pink Sheet (gold, silver, platinum; the .xlsx is
  read with a small zero-dependency reader, `lib/xlsx.js`). openFDA adds food recalls. SEC adds
  Form 4 open-market purchase and sale values (each Form 4 XML read once and remembered; up to
  2,500 per pass, so the first backfill can take two passes). FRED adds the full Treasury curve,
  IMF industrial metals and Monthly Treasury Statement outlays, receipts and deficit.
- `pmic-macro-signals`: `yield-curve` (10y-3m and 10y-2y slopes, every tenor and inversion flags in
  `term_structure`), `bank-health` (FDIC failures and CFPB complaints, recent failures listed),
  `global-rates-fx` (ECB rates, euro area inflation, euro FX as watch items). `commodities` now
  scores aluminum, nickel, zinc and iron ore and watches gold, silver and platinum.
- `pmic-company-signals`: `insider-activity` also scores the dollar value of open-market sales
  (weight 2) and purchases; new `public-attention` (Wikipedia pageviews and edits).
- `pmic-pharma-signals`: `clinical-pipeline` (trial starts, active trials, stopped trials;
  completions watched; stopped trials listed). The raw routes' scope is now pinned per entity, and an
  `entity_id` filter is no longer widened by a scope entry for another entity.
- New service `pmic-public-sector-signals` 0.1.0: `product-recalls` (CPSC, NHTSA, FDA food),
  `political-money` (FEC independent expenditures, lobbying registrations) and `federal-spending`
  (USAspending obligations, Treasury outlays; receipts, deficit and eight departments watched). It
  needs one registration (1,000 POKT, owner's approval) and the supplier re-stake listing all
  services.
- Skipped on licensing grounds: Freddie Mac mortgage rates (FRED copy is copyright Freddie Mac).
- `bin/probe.js` (on the Pi: `sh ops/probe-batch2.sh`) checks every new source live into a
  throwaway database before anything is deployed.
- Catalog 417 -> 535 series.

## Packs batch 2, phase 1 (2026-10-04): 8 verticals, no new registration

- `pmic-company-signals` 0.3.0: `insider-activity` (weekly Form 4 filings against the company's own
  year, plus its latest Form 4 and 13D filings), `balance-sheet` (cash, current ratio, current assets
  and liabilities, long-term debt, total assets, each against the company's own quarters) and
  `peer-ranking` (new `peer_table` kind: rank position among the 14 companies on growth, margins and
  liquidity).
- `pmic-macro-signals` 0.3.0: `housing` (starts, permits, new-home sales, months of supply, FHFA
  prices), `consumer` (real spending and income, retail sales, card delinquencies; saving rate and
  consumer credit as watch items), and three 8-country tables: `country-risk` (6 Worldwide
  Governance Indicators), `health-systems` (life expectancy, under-5 mortality, physicians, health
  spending) and `education` (secondary and tertiary enrollment, education spending).
- Catalog 321 -> 417 series: 9 FRED series (Census, FHFA, BEA, Federal Reserve; all public domain) and
  11 World Bank indicators (WGI is CC BY 4.0). Skipped for copyright: Case-Shiller, Freddie Mac
  mortgage rates, University of Michigan sentiment. China publishes no secondary enrollment
  (`cn:SE.SEC.ENRR` skipped).
- `clinical-pipeline` and the other new collectors followed in phase 2 (above); `fiscal-health` is
  covered by phase 2's `federal-spending` (Monthly Treasury Statement outlays, receipts, deficit).
- Deploy: Pi rebuild (collects the new series), PSM Deploy for `pmic-hub` and the macro and company
  packs, then a gas-only Register service update of the two cards. No new fee.

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
- J&J's FDA searches also match "Janssen" (`fda_aliases` in `config/series.json`), since openFDA
  lists most J&J drugs under Janssen. Before, J&J's adverse event and label series came back empty.
- Push fix: when the Pi pushes series the hub doesn't know yet (Pi upgraded before the hub), the hub
  now names them in `unknown_series` and the Pi resends their rows on every push until accepted.
  Before, the cursor moved past them and they never arrived (2026-10-04: fixed by hand by resetting
  `push_cursor`). Takes effect after the next Pi rebuild and hub deploy.
- Deploy: Pi rebuild (collector), then PSM Deploy for `pmic-hub` and the three packs. No
  re-registration and no POKT.
- Pharma card updated on MainNet to the 0.2.0 card (Register service, gas only, about 0.16 POKT):
  tx `7A5E7FC257DC1BAC931B86E736C1104E78577DE9CF6F85294B8373EF7094D62A` (block 950479).

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
