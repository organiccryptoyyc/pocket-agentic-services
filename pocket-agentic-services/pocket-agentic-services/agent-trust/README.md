# Agent Trust and Compliance

A standalone [Pocket Network](https://pocket.network) service: five
endpoints an autonomous agent can call before it trusts a counterparty
domain or address — domain-registration trust, a live TLS certificate
check, a composite seller-trust score for a resource-server URL, a U.S.
government sanctions-list lookup, and EVM address reputation. Built for
Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) (announced 2026-09-18,
submissions due 2026-10-12).

Every check here is a real live protocol call or documented external API —
nothing is simulated, bundled as a static list, or fabricated. See
"Verification" below for exactly what was and wasn't independently
confirmed against a live endpoint during this build, and why.

## Origin and disclosure

New, standalone repository — not part of, and not dependent on, the
`alpha1` x402 API marketplace project. `alpha1` already exposes
`/v1/brand-verify`, `/v1/domain-trust`, `/v1/x402/seller-trust`,
`/v1/compliance/sanctions-check`, and `/v1/agent/reputation` as
x402-metered endpoints, some backed by paid third-party data providers
(the SEC/uprock-style integrations described in alpha1's own README). This
package covers the same conceptual ground for Pocket Network's Agentic
Portal marketplace, but is a from-scratch reimplementation deliberately
built against **free, keyless-where-possible, official or well-established
public data sources** rather than alpha1's paid providers, so it can be
staked and run by any Pocket supplier without alpha1's dependencies. No
code, credentials, or runtime is shared with alpha1. `lib/http.js` is the
same vendored request-handling shell used across this repo's other
packages, adapted from the `pocket-service-builder` toolkit's own
`templates/backends/node/server.js` reference skeleton.

## Endpoints and data sources

| Endpoint | Source | Requires a key? |
|---|---|---|
| `/v1/domain-trust` | [RDAP](https://rdap.org) (IETF-standard domain registration data, via a public bootstrap proxy) + live DNS (MX/SPF/DMARC/DNSSEC) | No |
| `/v1/brand-verify` | A live TLS handshake to the domain (Node's built-in `tls` module) + RDAP | No |
| `/v1/seller-trust` | Composite of the above two, for a resource-server URL | No |
| `/v1/sanctions-check` | [U.S. Consolidated Screening List](https://www.trade.gov/consolidated-screening-list) (International Trade Administration, `data.trade.gov`) — aggregates OFAC's SDN list and 10+ other U.S. restricted-party lists | **Yes** — free signup at https://developer.trade.gov |
| `/v1/reputation` | Public [Blockscout](https://www.blockscout.com) explorer instances for `eth`, `base`, `arbitrum`, `polygon` | No |

## Operator setup: the sanctions-check API key

`/v1/sanctions-check` requires `TRADE_GOV_SUBSCRIPTION_KEY` in the
backend's environment. Without it, the endpoint returns
`422 {"error":{"code":"not_configured", ...}}` rather than a false "clean"
result — a missing key is a configuration error, never silently treated as
"nothing found." Get a free key at https://developer.trade.gov (standard
government-API developer signup, no cost) before staking this service.

## SSRF guard

`/v1/domain-trust`, `/v1/brand-verify`, and `/v1/seller-trust` make live
outbound DNS and TLS connections to whatever domain the caller names.
Before connecting, `lib/checks.js`'s `resolveSafely()` resolves the domain
and refuses to proceed if any resolved address is private, loopback,
link-local, or otherwise non-public (RFC 1918, RFC 3927, `::1`, ULA, etc.),
returning `422 {"error":{"code":"refused_target", ...}}`. This stops the
service from being used to probe the supplier's own internal
infrastructure via a crafted domain.

## Verification

**Independently confirmed live during this build**, via a browser (the
build sandbox's own outbound network is restricted and could not reach
most of these directly): the RDAP response shape at `rdap.org` (tested
against `pocket.network` itself), the `data.trade.gov` Consolidated
Screening List endpoint's existence and its Azure-API-Management-style auth
error format (`401` with `{"statusCode":401,"message":"...subscription
key..."}`, confirming the header-based auth mechanism this backend uses),
and the Blockscout v2 API's exact response shape (`/api/v2/addresses/{addr}`
and `.../counters`) against a real address on four chains (`eth`, `base`,
`arbitrum`, `polygon`). Node's own `tls.getPeerCertificate()` and
`dns.promises` APIs were sanity-checked against a reachable host from
within the sandbox and behave exactly as documented (both are long-stable
core Node APIs, not third-party schemas).

**Not independently confirmed**, and flagged rather than guessed: the
exact JSON field names inside a real, *authenticated*
`data.trade.gov/consolidated_screening_list/v1/search` response (`results[]`
item shape — `name`, `type`, `programs`, `source`, etc. in `lib/checks.js`'s
`screeningSearch()`) could not be tested, because obtaining a real API key
requires an account signup this build could not perform, and OFAC's own
bulk SDN export (`sanctionslistservice.ofac.treas.gov/entities`) turned out
to be a 112MB "historic/preview" export explicitly marked "not considered
an official OFAC sanctions list" — not the right source for this endpoint,
and correctly avoided rather than used anyway. **Before relying on
`/v1/sanctions-check` in production, get a real key and run one query
against a name from a public sanctions-list news story to confirm the
response actually parses as expected**; the code degrades gracefully
(reports `total`/`match_count` from whatever shape comes back, falls back
to an empty match list rather than crashing) if a field name is off, but a
silent false-negative on this specific endpoint is a compliance risk worth
one real check.

## Testing

```
node -r ./test/stub-network.js test/smoke.js    # in-process smoke test, no network needed
node -r ./test/stub-network.js server.js        # run the server against canned fixtures
npm start                                       # POCKET_NETWORK n/a here; needs real network + (for sanctions-check) a real key
```

## Deploying

See `../docs/registration-runbook.md` — service id `agent-trust`,
confirmed conflict-free against both Pocket networks' live catalogs on
2026-09-19. Because this backend needs broad outbound access (any domain a
caller names, plus `rdap.org`, `data.trade.gov`, and the Blockscout hosts)
rather than a fixed allowlist, review your hosting environment's egress
policy before staking.
