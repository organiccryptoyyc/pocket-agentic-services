# Wallet and DeFi Intelligence

A standalone [Pocket Network](https://pocket.network) service: nine
endpoints for an autonomous agent evaluating a wallet or a DeFi protocol
before it acts — wallet balance, risk, and heuristic "smart money"
scoring, NFT holdings, a combined pre-transaction precheck against a
target protocol, yield-opportunity ranking, protocol health, and
stablecoin depeg checking. Built for Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) (announced 2026-09-18,
submissions due 2026-10-12).

## Origin and disclosure

New, standalone repository — not part of, and not dependent on, the
`alpha1` x402 API marketplace project. `alpha1` already exposes a family
of `/v1/wallet*`, `/v1/defi/*`, `/v1/yield/*`, `/v1/stablecoin/depeg-check`,
and `/v1/nft/analytics` routes as x402-metered endpoints. This package
covers the same conceptual ground for Pocket's Agentic Portal marketplace,
but is a from-scratch reimplementation built entirely against free public
data sources (DefiLlama, public Blockscout instances) rather than
alpha1's providers, so it has no dependency on alpha1's infrastructure or
credentials. No code or runtime is shared. `lib/http.js` and `lib/net.js`
are the same vendored request-handling shell and cache/retry machinery
used across this repo's other packages.

## Endpoints and data sources

| Endpoint | Source |
|---|---|
| `/v1/wallet-balance`, `/v1/wallet-risk`, `/v1/smart-money`, `/v1/prospect-enrichment` | Public Blockscout explorer instances (`eth`, `base`, `arbitrum`, `polygon`) — address info, transaction counters, token balances |
| `/v1/nft-analytics` | Public Blockscout `/nft/collections` |
| `/v1/precheck` | Wallet risk (above) + DefiLlama's protocol TVL series and hack history |
| `/v1/protocol-health` | [DefiLlama](https://defillama.com) `api.llama.fi/protocol/{slug}` |
| `/v1/depeg-check` | DefiLlama `stablecoins.llama.fi` |
| `/v1/yields` | DefiLlama `yields.llama.fi/pools` (~17k pools, cached 15 min network-wide, filtered per request) |

EVM chains only in this version (`eth`, `base`, `arbitrum`, `polygon`) —
no Solana support yet, an explicit scoping decision rather than a broken
promise (see "Verification").

`wallet-risk` reports **higher = riskier**; every other 0-100 score in
this package (and across this repo) reports **higher = more
trustworthy/favorable** — each response's `*_score_scale` field states
the direction explicitly so a caller never has to guess.

## Verification

Independently confirmed live during this build, via a browser (the build
sandbox's own outbound network could not reach these directly): the
DefiLlama `/protocol/{slug}` response shape including the `tvl` time
series (`{date, totalLiquidityUSD}`) and the `hacks` array (tested against
`aave`, which has a real recorded — and fully recovered — 2026 hack, a
good real-world edge case); the `stablecoins.llama.fi` response including
the `price` field (only visible with `includePrices=true`); the
`yields.llama.fi/pools` payload size (~11.5MB, ~17k pools, confirming the
15-minute network-wide cache design rather than a per-request re-download);
and the Blockscout v2 API's `token-balances` and `nft/collections`
endpoints against a real, heavily-used address. Two "free public RPC"
options considered and **rejected** after live testing: Cloudflare's
`cloudflare-eth.com` gateway now returns `"Cannot fulfill request"` for
basic calls, and Solana's public `api.mainnet-beta.solana.com` returned
`403 Access forbidden` — both are no longer reliable for this kind of use,
which is why this package uses Blockscout instead and does not support
Solana addresses.

## SSRF / abuse surface

Unlike `agent-trust`, this backend does not take an arbitrary
caller-supplied hostname — every outbound call target is either a fixed
Blockscout host (from a small allowlist keyed by the `chain` parameter) or
a fixed DefiLlama host, so there is no SSRF surface from caller input.

## Testing

```
node -r ./test/stub-fetch.js server.js   # run against canned fixtures, no network needed
npm start                                # needs real network access
```

## Deploying

See `../docs/registration-runbook.md` — service id `wallet-defi-intel`,
confirmed conflict-free (including the `wallet-defi-intel-wallet-balance`
apis[] entry, added after the initial four-package conflict check and
independently re-checked on 2026-09-19) against both Pocket networks' live
catalogs.
