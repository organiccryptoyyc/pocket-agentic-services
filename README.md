# pocket-agentic-services

Four standalone [Pocket Network](https://pocket.network) service backends,
built for Pocket's Agentic Portal builder contest (announced 2026-09-18,
submissions due midnight EST 2026-10-12). Each subfolder is a complete,
independently deployable service: its own `card.json`, `server.js`,
`openapi.json`, `package.json`, tests, and README — none of them import from
each other, and none of them depend on any other repo. A couple of small
request-handling / caching helper files (`lib/http.js`, `lib/net.js`) are
vendored (copy-pasted, not shared via import) into more than one package so
each stays standalone; see each package's own README for exactly what's
shared and what's original.

| Package | What it does | Endpoints | Data sources |
|---|---|---|---|
| [`pokt-network-intel/`](./pokt-network-intel) | POKT Network Intelligence — live read-only views over Pocket's own Shannon chain state | 8 | Pocket GraphQL indexer + Cosmos LCD |
| [`rpc-quality-intel/`](./rpc-quality-intel) | RPC / Gateway Quality Intelligence — how well Pocket is serving RPC access to a chain/service right now | 4 | Pocket GraphQL indexer + Cosmos LCD |
| [`agent-trust/`](./agent-trust) | Agent Trust and Compliance — domain/brand verification, TLS inspection, sanctions screening, composite seller trust | 5 | RDAP, live TLS handshake, DNS, trade.gov CSL, Blockscout |
| [`wallet-defi-intel/`](./wallet-defi-intel) | Wallet and DeFi Intelligence — wallet risk/reputation, DeFi protocol health, yields, depeg checks | 9 | Public Blockscout instances, DefiLlama |

Every backend follows the same design rules (Pocket's gateway-compliance
contract): every response is a JSON object; bad input is 4xx+JSON; upstream
failure with no cached fallback is 422, never 5xx; all inputs arrive in the
POST body only; no external npm dependencies (Node built-ins: `http`, `tls`,
`dns`, global `fetch`); every "trust"/"risk"/"score" field is a deterministic,
live-computed composite with a `reasons[]` array, never a static or
simulated number.

## Origin

New repository, not a fork or subfolder of any other project. Two packages
(`pokt-network-intel`, `rpc-quality-intel`) cover similar conceptual ground
to routes already live on `organiccryptoyyc.com`'s x402-metered API
marketplace (`alpha1`), but are from-scratch reimplementations against
Pocket's own on-chain data and REST/gateway contract rather than that
project's infrastructure — no code or credentials are shared. Each
package's own README states exactly what, if anything, it reuses
conceptually from prior work.

## Status

All four backends are code-complete, pass the Pocket service-builder
toolkit's `lint_backend.py` against a locally running instance, and have
`card.json` files validated by `validate_card.py`. None are registered,
staked, or deployed on-chain yet — see
[`docs/registration-runbook.md`](./docs/registration-runbook.md) for the
exact commands to do that (written to be run by the repo owner with their
own keyring; nothing in this repo executes a transaction on its own).

## License

Not yet chosen — add one before relying on this repo publicly if a specific
license matters to you.
