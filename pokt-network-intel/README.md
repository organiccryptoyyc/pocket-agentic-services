# POKT Network Intelligence

A standalone [Pocket Network](https://pocket.network) service: eight read-only
endpoints over Pocket's own Shannon-protocol chain state — network pulse,
tokenomics, validators, suppliers, throughput, applications, service demand,
and a per-supplier trust score. Built for Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) (announced 2026-09-18,
submissions due 2026-10-12).

Every number this service returns is fetched live, on every request, from
Pocket's own public [GraphQL indexer](https://data.pocket.network/graphql)
and [Cosmos LCD](https://sauron-api.infra.pocket.network) — nothing is a
hardcoded snapshot. See "Data sources" below.

## Origin and disclosure

This is a new, standalone repository — it is not part of, and does not
depend on, the `alpha1` x402 API marketplace project. Three things carry
over from that project's prior work, disclosed here per project convention:

- **Concept only** — `alpha1` already exposes a family of `/v1/pokt/*`
  routes (pulse, tokenomics, validators, suppliers, throughput,
  applications, service-demand, supplier-trust) as x402-metered HTTP
  endpoints for the Coinbase x402/Bazaar marketplace. This package covers
  the same conceptual ground for Pocket Network's own, separate Agentic
  Portal marketplace, which has entirely different transport, backend and
  registration requirements (Pocket service cards, RelayMiner-fronted
  backends, on-chain staking) — no code, dependencies, or runtime is
  shared between the two.
- **No shared code.** This backend was written from scratch against the
  `pocket-service-builder` skill and Pocket's own GraphQL/LCD schemas,
  verified interactively against the live endpoints during development
  (see "Verification").
- **Reused scaffolding.** `lib/http.js` and the overall request-handling
  shape are adapted from the `pocket-service-builder` toolkit's own
  `templates/backends/node/server.js` reference skeleton
  (`pokt-network/pocket-network-resources`), as recommended for every
  Pocket service backend.

## Data sources

| Endpoint | Primary source(s) |
|---|---|
| `/v1/pulse` | Tendermint RPC `/status` (chain tip) + GraphQL indexer (staked-actor counts, `_metadata`) |
| `/v1/tokenomics` | Cosmos LCD `shared/params`, `tokenomics/params` |
| `/v1/validators` | Cosmos LCD `/cosmos/staking/v1beta1/validators` (total bonded `tokens`, the true voting-power figure — not the indexer's self-stake-only field) |
| `/v1/suppliers` | GraphQL indexer `suppliers` / `supplierServiceConfigs` |
| `/v1/throughput` | GraphQL indexer `blocks` aggregates (claimed vs. difficulty-estimated relays) |
| `/v1/applications` | GraphQL indexer `applications` / `applicationServices` |
| `/v1/service-demand` | GraphQL indexer, aliased batch query per service |
| `/v1/supplier-trust` | GraphQL indexer `supplier` (stake, service configs, `eventClaimSettleds`, `eventSupplierSlasheds`) |

Network is selected by `POCKET_NETWORK=main|beta` (default `main`); see
`lib/pocket.js` for both networks' endpoint URLs. Nothing here hardcodes a
governance parameter, stake minimum, or participant count — every value in
a response is a live query result, per the `pocket-engineering` skill's
Rule 1.

## Verification

Every GraphQL query and LCD path in `server.js` was run against the real
endpoints (`https://data.pocket.network/graphql`,
`https://sauron-api.infra.pocket.network`,
`https://sauron-rpc.infra.pocket.network`) via a browser during development
— not guessed from documentation — because the build sandbox's own
outbound network does not reach `*.pocket.network`. Two real issues were
caught this way before shipping: `SupplierServiceConfig.activatedAt` needs
a subfield selection (the scalar height is `activatedAtId`), and a naive
GraphQL query build must not string-interpolate unescaped service ids.

Local testing (`test/stub-fetch.js`, `test/unit-cache.js`) replays canned
responses copied verbatim from those live calls to exercise routing, input
validation, and the stale-cache error-fallback path without live network
access. This is a local test aid only — before staking, re-run
`lint_backend.py --base-url http://localhost:8080 --card ./card.json`
against the real backend with real network access, per the runbook in
`../docs/registration-runbook.md`.

## Design-rule compliance

Every response is a JSON object; bad input is 4xx + JSON; the backend never
returns a 5xx (a live-upstream failure with no cached fallback is reported
as 422, since 5xx is unpaid and penalized under Pocket's gateway rules).
Error messages are scrubbed of Tier-3 retry-trigger substrings
(`timeout`, `connection refused`, etc. — see `lib/http.js`). All inputs
are read from the POST body, never query params or headers. See
`card.json`'s `serving.healthcheck` for the three probe endpoints
(`GET /v1/version`, `GET /v1/health`, `POST /v1/tokenomics`).

## Running locally

```
npm start                      # POCKET_NETWORK=main by default; needs real network access
node test/unit-cache.js        # cache/stale-fallback unit test, no network needed
node -r ./test/stub-fetch.js server.js   # run against canned fixtures, no network needed
```

## Deploying

See `../docs/registration-runbook.md` for the full stake/register sequence
(Beta TestNet first, then MainNet) — service id `pokt-network-intel`,
confirmed conflict-free against both networks' live catalogs on 2026-09-19.
