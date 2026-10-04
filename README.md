# pocket-agentic-services

Five standalone [Pocket Network](https://pocket.network) service backends.
The first four were built for Pocket's Agentic Portal builder contest
(announced 2026-09-18, submissions due midnight EST 2026-10-12) and all
four have been registered, deployed, relayed, and submitted — see
"Status" below. The fifth, `media-utils`, was scoped and built afterward
in response to a real gap found by checking the live production
marketplace (`agent.pocket.network`) directly rather than guessing — see
`docs/registration-runbook.md` §15. Each subfolder is a complete,
independently deployable service: its own `card.json`, `server.js`,
`openapi.json`, `package.json`, tests, and README — none of them import from
each other, and none of them depend on any other repo. A couple of small
request-handling / caching helper files (`lib/http.js`, `lib/net.js`) are
vendored (copy-pasted, not shared via import) into more than one package so
each stays standalone; see each package's own README for exactly what's
shared and what's original.

| Package | What it does | Endpoints | Data sources / tools |
|---|---|---|---|
| [`pokt-network-intel/`](./pokt-network-intel) | POKT Network Intelligence — live read-only views over Pocket's own Shannon chain state | 8 | Pocket GraphQL indexer + Cosmos LCD |
| [`rpc-quality-intel/`](./rpc-quality-intel) | RPC / Gateway Quality Intelligence — how well Pocket is serving RPC access to a chain/service right now | 4 | Pocket GraphQL indexer + Cosmos LCD |
| [`agent-trust/`](./agent-trust) | Agent Trust and Compliance — domain/brand verification, TLS inspection, sanctions screening, composite seller trust | 5 | RDAP, live TLS handshake, DNS, trade.gov CSL, Blockscout |
| [`wallet-defi-intel/`](./wallet-defi-intel) | Wallet and DeFi Intelligence — wallet risk/reputation, DeFi protocol health, yields, depeg checks | 9 | Public Blockscout instances, DefiLlama |
| [`media-utils/`](./media-utils) | Agent Media Utilities — PDF-page-to-image, any-format image conversion (incl. real HEIC/HEVC photos), audio transcription | 4 | poppler, libvips/sharp + libheif, ffmpeg, whisper.cpp (local — no outbound network) |
| [`treasury-capital-score/`](./treasury-capital-score) | TCS-6 Crypto Treasury Capital Score: six-dimension, hard-gated treasury reports for DeFi protocols, served from a 12h-refreshed cache | 2 | Evidence pushed by a private collector (chain state, Safe, Snapshot, CoinGecko, Chainlink, DefiLlama, protocol disclosures) |
| [`pmic/`](./pmic) | Public Market Intelligence Collection: the private data layer under the planned ~50 market-intel service packs (not itself a paid service); collects, scores and serves 312 public series with citations | 9 (private) | FRED, BLS, BEA, SEC EDGAR, openFDA, World Bank |

Every backend follows the same design rules (Pocket's gateway-compliance
contract): every response is a JSON object; bad input is 4xx+JSON; upstream
failure with no cached fallback is 422, never 5xx; all inputs arrive in the
POST body only. The first four have no external npm dependencies (Node
built-ins: `http`, `tls`, `dns`, global `fetch`) and every "trust"/"risk"/
"score" field is a deterministic, live-computed composite with a
`reasons[]` array, never a static or simulated number. `media-utils` is
the exception on dependencies — real PDF/image/audio codecs aren't
Node-built-in — and its "results" are correctly declared `variable`, not
`deterministic`, in its card (see that package's README).

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

The first four backends are fully done end-to-end: registered on Beta
TestNet, deployed behind a shared RelayMiner, staked (supplier + one test
app per service), relayed for real with real data returned, and all four
contest form responses submitted ahead of the deadline — see
[`docs/registration-runbook.md`](./docs/registration-runbook.md) for the
full history.

`media-utils` is code-complete, passes `lint_backend.py` against a
locally running instance (including its card's embedded functional
healthcheck probe), and has a `card.json` validated by `validate_card.py`
— but is **not yet registered, staked, or deployed**. It was built after
the contest submission was already closed out, so registering it is an
optional next step, not a deadline item; see its own README's "Deploying"
section and `docs/registration-runbook.md` §15 for what's still open
(mainly: a live catalog-conflict check for the service ID, and building
the Docker image somewhere with real outbound network for the
`whisper.cpp` build step). Nothing in this repo executes a transaction or
runs a deploy command on its own — every registration/staking/deploy
command in the runbook is written to be run by the repo owner with their
own keyring, and only after explicit go-ahead in the moment.

## License

Not yet chosen — add one before relying on this repo publicly if a specific
license matters to you.
