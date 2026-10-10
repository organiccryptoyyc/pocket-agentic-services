# TCS-6 deploy runbook (Pocket Service Manager)

Everything chain-side and server-side goes through Pocket Service Manager (PSM).
Claude can drive PSM's tools, but every spend or signature opens a
confirmation in the PSM window that only you can approve; on MainNet you type
the service ID, server name, or SEND. **🔒 = spends POKT or changes chain state.**

## Already done (read-only, 2026-10-01)

| Check | Result |
|---|---|
| `check_catalog.py treasury-capital-score --both ...` | Free on beta (101 services) and main (249 services) |
| Live MainNet params | add_service_fee 1,000 POKT · supplier min_stake 59,500 · app min_stake 1,000 · 1 CU = 0.113288 uPOKT |
| Price | 100,000 CU/relay, same as prediction-market-intel's live value (≈0.0113 POKT/relay today) |
| Your supplier on chain | operator `pokt1a0e9x…tzysx`, 60,000 POKT staked, services: **prediction-market-intel only** |
| Card | `validate_card.py` OK; PSM `psm_validate_card` OK (3.3 KiB) |
| Backend | `npm test` 15/15; `lint_backend.py` 9/9; PSM-layout compose built and run locally |
| Registry | 38 treasury address rows for 7 entities, each checked on-chain |

## Why MainNet still needs one stake transaction (no new bond)

A supplier is only put in sessions for the services listed in its on-chain
record, and that record lists only `prediction-market-intel` today. PSM's
`add-service` step updates the relayer on the server. The on-chain list changes
only through PSM's **Stake supplier** with both services and the **same
60,000 POKT**. No extra POKT is bonded; it costs gas only. PSM's tool replaces the
list, so it must include both services.

## 0. Package (PowerShell, this PC)

Each network is a **separate deployment** (PNF guidance): its own container,
image, data volume, pipeline, ingest token, and ingest route. The on-chain
service ID is `treasury-capital-score` on both networks.

| | Beta | MainNet |
|---|---|---|
| Build | `node ops/package-psm.js beta` | `node ops/package-psm.js main` |
| Folder | `treasury-capital-score/build/treasury-capital-score-beta` | `Downloads	reasury-capital-score` |
| Deploy ID (PSM ship/deploy) | `treasury-capital-score-beta` | `treasury-capital-score` |
| Relayer backend_url | `http://treasury-capital-score-beta-backend:8080` | `http://treasury-capital-score-backend:8080` |
| Ingest route | `/tcs6-ingest-beta` | `/tcs6-ingest` |
| Token file on server | `/opt/pocket/services/treasury-capital-score-beta/tcs6-ingest.env` | `/opt/pocket/services/treasury-capital-score/tcs6-ingest.env` |
| Token file on the PC | `treasury-capital-score/.secrets/beta-ingest.env` | `treasury-capital-score/.secrets/main-ingest.env` |

The build stops if the PC token file is missing. Copy it from the checkout that built the live deploy, because the Pi sends that token. Use `--new-token` only for a network's first deploy; a new token locks the Pi out until its `config.json` is updated.

## 1. Beta TestNet (PSM → Beta TestNet tab, server `hetzner-mainnet`)

Prerequisite: a DNS A record for `beta.organiccryptoyyc.com` pointing to 135.181.248.55.

1. **Provision the Beta stack** in PSM (ship with hostname `beta.organiccryptoyyc.com`, then operator, then keys).
   Fund the new Beta operator and the owner from https://faucet.beta.pocket.network/, then 🔒 publish.
2. 🔒 **Register** `treasury-capital-score` on Beta: 100,000 CU, card `build/treasury-capital-score-beta/card.json`.
3. **Hetzner SSH:** create the Beta ingest token (keep the value; the Pi needs it):
   ```bash
   mkdir -p /opt/pocket/services/treasury-capital-score-beta && echo "TCS6_INGEST_TOKEN=$(openssl rand -hex 32)" > /opt/pocket/services/treasury-capital-score-beta/tcs6-ingest.env && chmod 600 /opt/pocket/services/treasury-capital-score-beta/tcs6-ingest.env
   ```
4. **Deploy:** deploy-ship the Beta folder as `treasury-capital-score-beta`, then run `deploy` (health `/v1/health`).
   Then, on the Beta stack, run `add-service treasury-capital-score` with URL `http://treasury-capital-score-beta-backend:8080`,
   and `add-routes` with `/tcs6-ingest-beta → 8090`.
5. 🔒 **Stake the Beta supplier** for `treasury-capital-score` (faucet POKT; PSM shows the live minimum).
6. **Pi:** set `ingest_url` to `https://beta.organiccryptoyyc.com/tcs6-ingest-beta/ingest/evidence` plus the token, then install (see tcs6-pi-collector/README.md).
7. 🔒 **Stake a test application**, wait one session, then relay `POST /v1/tcs6/entities {}` and `POST /v1/tcs6/score {"entity_id":"aave"}`.
8. After the session ends, confirm a claim in PSM history or the explorer.

## 2. Before MainNet

- Re-read the CoinGecko, DefiLlama, Safe, and Snapshot ToS.
- Confirm that PNF sponsorship of the 1,000 POKT registration fee covers this second service.
- Pin `specs[].url` in `card.json` to a commit SHA once the repo is pushed.

## 3. MainNet (PSM → MainNet tab, server `hetzner-mainnet`)

1. 🔒 **Register** (1,000 POKT, re-check the fee in PSM first).
2. **Deploy** the MainNet folder as `treasury-capital-score`, then add-service (`http://treasury-capital-score-backend:8080`) and add-routes (`/tcs6-ingest → 8090`). It gets its own token file, as in the table above.
3. 🔒 **Stake supplier**, re-listing both services at 60,000 POKT:
   - `prediction-market-intel` → `https://agentic.organiccryptoyyc.com`, REST
   - `treasury-capital-score` → `https://agentic.organiccryptoyyc.com`, REST
4. 🔒 Stake an application, relay-test both routes, and watch for the first claim.

## 4. Gateway listing

Send `ops/sage-service.yaml` to the Pocket partner channel, and PR
`ops/pocket-health-checks-entry.yaml` into `pokt-network/pocket-network-resources`.
The stake alone doesn't make the service discoverable on agent.pocket.network.

## 5. Pi collector endpoint

Once routes are installed, the collector posts bundles (see `EVIDENCE.md`) to
`https://agentic.organiccryptoyyc.com/tcs6-ingest/ingest/evidence` with
`Authorization: Bearer <token>`. That route is public but rejects requests
without the token. Put the token only in the Pi's gitignored `config.json`.
