# Capital Integrity Dossier (`capital-integrity-dossier`)

A Pocket Network service: a deep, section-by-section treasury report on one protocol scored by TCS-6
(`treasury-capital-score`). TCS-6 answers "how strong is this treasury?" in one call. The dossier shows why,
and what could go wrong: where every dollar sits, who can move it, what is owed, what could be sold now, how it
reconciles with the protocol's own numbers, and what we could not verify.

## Multi-call, disclosed up front

A full dossier takes **up to 7 calls** (up to **$0.035** at the portal's $0.005 per call): one `plan` call plus one
call per available section. `plan` states `calls_required` and the estimated total before you commit. You pay only
for the calls you make and can stop after any section. Every response repeats `calls_used`, `calls_remaining` and
the remaining estimate, and the `plan` response carries a buyer `notice` saying the same.

```
POST /v1/dossier/plan      {"entity_id": "inverse-finance"}           -> dossier_id, sections, calls_required, estimate, notice
POST /v1/dossier/section   {"dossier_id": "dos_…", "section": "…"}    -> one section (any order)
POST /v1/dossier/entities  {}                                         -> the protocols a dossier can cover
GET  /v1/version, /v1/health
```

## Sections

| Section | What it holds |
|---|---|
| `holdings_map` | Every counted position by wallet and chain: value, haircut, value after haircut, control status, flags, price source; what was left out; cited sources; chart by asset class |
| `authority_graph` | Each wallet's control (Safe threshold and signers, contract or account), signers shared across Safes, governance controls, proxy-slot checks; since 1.4.0, `wallet_exit`: how much could leave within one hour if a wallet's signing control were compromised (direct transfers plus unfreezable WETH borrowed against collateral on Aave v3 and Compound v3), per wallet, with the 48-hour delay standard and the D6 cap |
| `obligations_register` | Every obligation item, disclosed commitments, the visibility status, materiality reasons and score effect |
| `exit_liquidity` | Locked and encumbered positions (lock-ups, redemption limits, loan collateral), the liquid remainder after haircut, tier 0–1 liquidity, runway, loan and liquidity risks; since 1.1, `exit_checks`: the collector's signed exit checks for lending and vault positions of $100k or more (share that could be withdrawn now, shortfall, block number and hash, evidence hash; unavailable reads stay gaps); since 1.2, each position's `withdrawal_simulation` (the withdrawal run with eth_call from the holder's address: amount out or the exact revert reason), `not_applicable` with the reason when a position was not re-checked, and `classification_conflicts` (TCS-6 materiality 1.1: restricted in the curated data, withdrawable on chain), split into on-chain observability, technical withdrawal, economic liquidity and governance classification; since 1.2.1, a reverted simulation reads in plain English (`cause`: the pool short of cash, collateral for a loan, redemptions switched off) with the raw reason kept, and collateral names the loan it backs (`backs_loans`); since 1.3.0 (TCS-6 materiality 1.2), each position shows how its divergence changed the score (`score_treatment`: the available value liquid capital counts, the rest as encumbered, illiquid or restricted, and whether the divergence is large), collateral carries the borrower account read on chain (`loan_health`), and `divergences` lists them with their check ids and evidence hashes; since 1.4.0, `economic_liquidity` shows what selling 1%, 10%, 25% and 100% of each plain token holding of $1M or more would fetch on chain, and what LP and vault positions return (evidence only; on-chain markets only) |
| `reconciliation` | The protocol's own reported total against what we observe for the same scope, the difference, netted items, cited sources; chart |
| `unresolved_items` | Data gaps, attestation review items, gates that did not pass, known perimeter gaps |

A section the snapshot cannot support (for example `reconciliation` when the protocol publishes no total) is listed
as unavailable in `plan` and left out of `calls_required`. Called anyway, it answers 200 with `available: false`.

## Snapshot pinning

`plan` pins one TCS-6 snapshot (a report together with the exact evidence bundle it was scored from) for 24 hours,
so every section describes the same moment. The collector pushes new evidence hours before the pipeline rescores
it, so the service only pairs a report with a bundle when `report.as_of == bundle.collected_at`, and keeps the last
such pair per protocol (`lib/store.js`).

## How it is built

- Reads the TCS-6 data volume **read-only**. It never calls a chain or a vendor, has no ingest listener and no secrets.
- Per-position haircuts come from TCS-6's own scoring core, vendored byte-identical as `lib/tcs6-scoring.js`
  (a test fails if it drifts from `treasury-capital-score/lib/scoring.js`).
- Each response carries the TCS-6 signed input attestation reference (`attestation_ref`).
- Output is derived values and citations only, never raw vendor payloads. Research, not investment advice.

## Run, test, deploy

```
npm test
node ops/package-psm.js beta     # build/capital-integrity-dossier-beta/, reads volume treasury-capital-score-beta_tcs6-data
node ops/package-psm.js main     # ~/Downloads/capital-integrity-dossier/, reads volume treasury-capital-score_tcs6-data
```

Deploy through Pocket Service Manager, Beta first: `deploy_ship`, `supplier_run deploy` (health `/v1/health`), then
add the service to the stack at `http://<deploy id>-backend:8080`.
