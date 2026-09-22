# RPC / Gateway Quality Intelligence

A standalone [Pocket Network](https://pocket.network) service: four
endpoints answering "how well is Pocket actually serving RPC access to
this chain/service right now?" — a per-service quality lens, distinct
from [`pokt-network-intel`](../pokt-network-intel)'s network-wide protocol
view. Built for Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) (announced 2026-09-18,
submissions due 2026-10-12).

## Origin and disclosure

New, standalone repository — not part of, and not dependent on, the
`alpha1` x402 API marketplace project. `alpha1` already exposes a family
of `/v1/edge/rpc-*` routes (pulse, performance, anomaly, forecast) as
x402-metered endpoints for the Coinbase x402/Bazaar marketplace, sourced
from alpha1's own third-party RPC-endpoint probing infrastructure. This
package covers analogous ground — RPC-serving quality per chain — for
Pocket Network's own Agentic Portal marketplace, but is a from-scratch
reimplementation with a different data source entirely: rather than
probing third-party RPC providers directly, it reads Pocket's own on-chain
relay-mining, settlement and slash records for the requested service, since
that is the quality signal that is actually native and verifiable on
Pocket. No code, dependencies, or runtime is shared with alpha1.
`lib/http.js` and the request-handling shape are adapted from the
`pocket-service-builder` toolkit's own
`templates/backends/node/server.js` reference skeleton
(`pokt-network/pocket-network-resources`), as recommended for every Pocket
service backend — see [`pokt-network-intel`](../pokt-network-intel)'s
README for the same note; `lib/pocket.js` and `lib/http.js` here are the
same vendored client, copied so this package stays deployable on its own.

## Endpoints

| Endpoint | Answers | Primary source |
|---|---|---|
| `/v1/rpc-pulse` | Is this service being actively served right now, and by how many suppliers? | GraphQL: `supplierServiceConfigs`, `applicationServices`, `relayMiningDifficultyUpdatedEvents`, trailing-1h `eventClaimSettleds` |
| `/v1/rpc-performance` | Over the last N hours, how much volume settled, how many suppliers carried it, and did proofs pass? | GraphQL: `eventClaimSettleds` (windowed by real block timestamp), `eventSupplierSlasheds` |
| `/v1/rpc-anomaly` | Has anything changed for the worse recently, by a fixed set of deterministic thresholds? | Same as above, recent window vs. a longer baseline window |
| `/v1/rpc-forecast` | Where is demand for this service trending? | Ordinary least-squares regression over `eventClaimSettleds` daily totals (aliased batch query, one round trip) |

`service_id` (e.g. `"eth"`, `"pocket"`) is required on every resource.
Network is selected by `POCKET_NETWORK=main|beta` (default `main`).

## Verification

Every GraphQL query in `server.js` was run against the real endpoint
(`https://data.pocket.network/graphql`) via a browser during development —
not guessed from documentation — because the build sandbox's own outbound
network does not reach `*.pocket.network`. This caught two real issues
before shipping: `ClaimProofStatus`'s actual enum values are
`PENDING_VALIDATION | VALIDATED | INVALID` (not `VALID`, an initially
guessed value that the schema rejects outright), and `ProofRequirementReason`
is `NOT_REQUIRED | PROBABILISTIC | THRESHOLD`. Both the settlement-success
scoring here and in `pokt-network-intel`'s `/v1/supplier-trust` were fixed
to the real enum before either backend was finalized.

Local testing (`test/stub-fetch.js`, `test/unit-cache.js`) replays canned
responses copied verbatim from those live calls. Before staking, re-run
`lint_backend.py --base-url http://localhost:8080 --card ./card.json`
against the real backend with real network access, per
`../docs/registration-runbook.md`.

## Design-rule compliance

Same as `pokt-network-intel`: every response is a JSON object, bad input
(including an unrecognized `service_id`) is 4xx + JSON, a live-upstream
failure with no cached fallback is 422 (never 5xx), and error messages are
scrubbed of Tier-3 retry-trigger substrings. `/v1/rpc-forecast` batches its
whole lookback window into one GraphQL round trip (aliased query) rather
than one call per day, to stay well inside the gateway's relay-timeout
budget even at the maximum 30-day lookback.

## Running locally

```
npm start                                # POCKET_NETWORK=main by default; needs real network access
node test/unit-cache.js                  # cache/stale-fallback unit test, no network needed
node -r ./test/stub-fetch.js server.js   # run against canned fixtures, no network needed
```

## Deploying

See `../docs/registration-runbook.md` — service id `rpc-quality-intel`,
confirmed conflict-free against both networks' live catalogs on 2026-09-19.
