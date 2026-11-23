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
| `/v1/reputation` | `eth`: the public [Blockscout](https://www.blockscout.com) explorer, falling back to Pocket Network's public RPC when it does not answer. `base`, `arbitrum`, `polygon`: Pocket Network's public RPC (`*.api.pocket.network`; their explorers' free APIs sit behind a bot check), plus [Sourcify](https://sourcify.dev) for verified contract source and the address's Ethereum ENS name (read on chain, accepted only when it resolves forward to the same address); returned with `coverage: "basic"`, `score_max_possible: 60` (1.3.0) | No |
| `/v1/preflight` (1.4.0) | Every check above that applies to one subject (`url`, `domain`, `address`, `name`), plus the [OFAC SDN list](https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists)'s sanctioned wallet addresses (downloaded once a day, exact match) and the lookalike findings of the brands the `brand-protection` service watches (its internal lookup, `BP_LOOKUP_URL`). One verdict; see "Preflight" below | Only the name check (same key as `/v1/sanctions-check`) |

## Preflight (`POST /v1/preflight`, 1.4.0)

One call runs every check that applies to one counterparty and returns one verdict.

| Check | Runs when | Source | Method |
|---|---|---|---|
| `domain_registration` | `domain` or `url` | RDAP of the registered name (a subdomain is looked up as the name above it) | definitive (heuristic for a warn) |
| `dns_posture` | `domain` or `url` | DNS: a domain that receives mail without SPF or DMARC is a warn | heuristic |
| `tls_certificate` | `domain` or `url` | Live TLS handshake: expired, wrong name or untrusted issuer is a fail | definitive |
| `brand_impersonation` | `domain` or `url` | brand-protection's stored findings: a high-risk lookalike is a fail, medium a warn; a domain outside the watch list is `not_available` | heuristic |
| `seller_trust` | `url` | The `/v1/seller-trust` composite | heuristic |
| `sanctions_name` | `name` | Consolidated Screening List: an exact name match is a fail, a similar name a warn | definitive / heuristic |
| `sanctions_address` | `address` | OFAC SDN digital currency addresses, exact match (EVM addresses ignore case). Unlisted is a pass for that list only: no wallet clustering | definitive |
| `address_reputation` | EVM `address` (`chain` defaults to `eth`) | The `/v1/reputation` check: a scam flag is a fail, little or no history a warn | heuristic |

Each check answers `pass`, `warn`, `fail`, `unknown` or `not_available`, with its `method`, a `summary`, an
`evidence_hash` and `changed_at`. Verdict: `fail` if a definitive check fails; `warn` if a heuristic check
fails or any check warns; `unknown` if any check could not answer (unknown never counts as a pass);
otherwise `pass`. `not_available` checks are left out. All checks run in parallel under an 8 s budget
(`PREFLIGHT_BUDGET_MS`). With `since`, only checks whose result changed after that time come back
(tracked in memory, so after a restart every check counts as changed once). If no check can answer, the
route returns 422.

Environment: `BP_LOOKUP_URL` (for example `http://brand-protection-backend:8091`; unset, the brand check is
`not_available`), `OFAC_SDN_URL` (default `https://www.treasury.gov/ofac/downloads/sdn.xml`, about 30 MB,
loaded at start and refreshed every 24 h; the last good copy is kept if a refresh fails).

1.4.0 also fixes RDAP for subdomains on every route: rdap.org answers 400 or 404 for `app.example.com`, so the
lookup now walks up (at most two labels) to the registered name and says so in `looked_up_as`.

1.5.0: a domain with no address records in DNS is an answer, not an outage. `/v1/domain-trust` still runs its
registry and DNS checks and returns `resolves: false` (plus `checked`, the checks it ran); `/v1/seller-trust` and
`/v1/brand-verify` need a server, so they return 422 `domain_not_resolvable` instead of `upstream_unavailable`.

1.6.0: a registry with no RDAP service is unknown, not unregistered. rdap.org answers 404 both for a name that
isn't registered and for a TLD whose registry publishes no RDAP (for example `.co`), so `theblock.co` and
`blockworks.co` read as "not registered" and failed `/v1/preflight`. The lookup now checks IANA's RDAP bootstrap
(`https://data.iana.org/rdap/dns.json`, cached a day): for an uncovered TLD, `registration` is
`{registered: null, rdap_available: false, reason}`, `/v1/domain-trust` returns `trust_score: null`,
`/v1/seller-trust` scores the certificate alone (`score_basis: "certificate_only"`), and the preflight
`domain_registration` check is `unknown` (so the verdict is `unknown`, never a pass). A 404 for a covered TLD is
still "not registered".

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
caller names, plus `rdap.org`, `data.trade.gov`, `www.treasury.gov` (the OFAC SDN list), `eth.blockscout.com`, `sourcify.dev`, and the
`*.api.pocket.network` RPC hosts)
rather than a fixed allowlist, review your hosting environment's egress
policy before staking.
