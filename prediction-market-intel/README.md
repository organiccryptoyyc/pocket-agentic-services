# Prediction Market Intelligence

A standalone [Pocket Network](https://pocket.network) service: four
endpoints that turn Polymarket's live public market data into
strategy/insight signal for an autonomous agent — a correctly-ranked
top-N by trailing volume window, the biggest observed consensus shifts,
what entered/exited the top 100 by 30-day volume over a lookback window,
and a liquidity-depth/spread quality score for the busiest markets. Built
for Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) family of services in
this repo, as a proposed 6th package — see
[`../docs/polymarket-intel-case.md`](../docs/polymarket-intel-case.md) for
the full research case (comparable-use-case precedent, the real
Polymarket Terms of Use clause this was checked against, real rate-limit
numbers, and the naming decision) that this package was built from.

**Status: designed and locally verified, not yet registered, staked, or
deployed.** Nothing in this package has touched Pocket's chain or any
production RelayMiner — that is a separate, explicitly-gated step per
this repo's standing rule, same as every other package here before its
own registration pass.

## Origin and disclosure

New, standalone package in this repo, matching the pattern of
`pokt-network-intel`, `rpc-quality-intel`, `agent-trust`, and
`wallet-defi-intel`: no external npm dependencies, `lib/http.js` and
`lib/net.js` vendored verbatim from `wallet-defi-intel` (identical
files, byte-for-byte). `lib/polymarket.js` is new to this package.

**This project is independent and is not affiliated with, endorsed by,
or sponsored by Polymarket** — the same disclosure every real precedent
product in the research case uses (PolymarketData.co, for one, states
this explicitly). This isn't boilerplate: Polymarket's own Terms of Use
(`polymarket.com/tos`, effective 2026-08-11) has a general anti-scraping
clause covering all users and a narrower resale restriction naming
"Capital Market Client[s]"/market data distributors specifically — see
the case doc's §7 for the honest read on both. This service reads
Polymarket's own public, no-key API and does not claim any licensing
relationship with Polymarket.

## Endpoints and data source

All data comes from Polymarket's free, public
[Gamma API](https://gamma-api.polymarket.com) (no key required). Nothing
is bundled or simulated; every response is computed from a live fetch
(behind a 3-minute cache — see "Verification").

| Endpoint | What it returns |
|---|---|
| `POST /v1/top-markets` (`limit?` 1-100 default 20, `window?` `24hr`\|`1wk`\|`1mo` default `1mo`) | The top N currently-open markets ranked by trailing volume for the requested window, re-sorted by this backend (see the `order`-param bug below) |
| `POST /v1/market-momentum` (`limit?` 1-50 default 10, `window?` `1d`\|`1w`\|`1mo` default `1w`, `direction?` `up`\|`down`\|`any`) | The biggest observed price-change ("consensus shift") magnitude among the candidate pool |
| `POST /v1/rotation-diff` (`lookback_hours?` 1-168 default 24) | Markets that entered/exited the top 100 by 30-day volume since the lookback, and the biggest rank moves among markets present in both — or an honest `insufficient_history: true` if this backend hasn't been running long enough yet |
| `POST /v1/market-quality` (`limit?` 1-50 default 20, `window?` `24hr`\|`1wk`\|`1mo` default `1mo`) | A 0-100 liquidity-depth/spread score per busiest market, with a `reasons[]` array, flagging high volume riding on a thin order book |

Every score/ranking in this package is declared `variable` in the card,
not `deterministic` — Polymarket's own volumes and prices change
continuously, so two calls a minute apart will not return identical
bytes.

## Two real, confirmed-live upstream quirks this backend works around

Found and verified against the real API during this build (2026-09-27),
not assumed from documentation:

1. **Polymarket's own `order` query parameter does not reliably sort.**
   Pulling `/markets?order=volume24hr&ascending=false` and
   `/markets?order=volume1mo&ascending=false` directly, twice each, both
   showed a later-ranked market with a *higher* value than an
   earlier-ranked one (rank 3 < rank 4 by the field being sorted on) —
   reproduced on two different fields, not a one-off fluke. This backend
   never trusts the upstream order: it seeds its candidate pool from four
   different `order` values in parallel, merges and de-duplicates by
   market id, and always re-sorts client-side by the exact field a
   request actually needs.
2. **`outcomes` and `outcomePrices` arrive as JSON-encoded strings, not
   native JSON arrays** (e.g. the raw field value is the literal string
   `"[\"Yes\", \"No\"]"`, confirmed by inspecting the raw response body
   directly). A naive `market.outcomes.map(...)` would throw. Handled in
   `lib/polymarket.js`'s `safeJsonArray()` — every caller gets real
   arrays.

A third real thing worth naming plainly rather than glossing over: there
is **no genuine "category" field** anywhere on a Polymarket market or
event object (checked directly — `category` and `tags` are both absent
from the default `/markets` and `/events` responses; a separate `/tags`
endpoint exists but returns thousands of narrow, non-hierarchical tags
like "caitlin clark" and "product market fit", not a usable
Sports/Politics/Crypto taxonomy). The original research case sketched a
`category-breakdown` endpoint; it was dropped from this build rather than
faked with a keyword-guessed category, in keeping with this repo's rule
against fabricating categorical data. `market-quality` was built in its
place — a genuinely computed signal from confirmed-real fields
(`liquidity`, `spread`, `bestBid`/`bestAsk`) instead.

## Verification

Independently confirmed live during this build (2026-09-27), by fetching
the real API directly (this build sandbox's own outbound network could
not reach `gamma-api.polymarket.com` via a plain `curl`/shell request —
same category of restriction documented in this repo's other packages —
so live confirmation went through a browser-based fetch instead): the
`/markets` response's real field names (`volumeNum`, `volume24hr`,
`volume1wk`, `volume1mo`, `liquidityNum`, `bestBid`, `bestAsk`, `spread`,
`oneDayPriceChange`, `oneWeekPriceChange`, `oneMonthPriceChange`) and
their real, sane values including legitimate `null`s for a market too new
to have a month of history yet; the `outcomes`/`outcomePrices`
string-encoding quirk above; and the `order`-param sort-reliability bug
above.

The server itself was run for real against a canned-fixture stub
(`node -r ./test/stub-fetch.js server.js`) and exercised end-to-end: all
three `card.json` healthchecks plus three functional probes passed via
the pocket-service-builder toolkit's real `lint_backend.py`
(8/8 checks, exit 0 — identity probe, readiness probe, the top-markets
functional probe, momentum/rotation-diff/market-quality probes, and two
bad-input probes both correctly returning 4xx+JSON, never HTML or 5xx);
`validate_card.py` passed schema validation (one benign size warning,
same as every other package in this repo, since the card's `description`
is deliberately verbose for gateway/agent discoverability). A simulated
total-upstream-failure run (`SIMULATED_UPSTREAM_FAILURE=1`, no cache
warmed) confirmed the honest-degradation path: HTTP 400 (422 before v1.0.1) with a JSON
`upstream_unavailable` error, never a 5xx.

**Not yet verified against the real, live Polymarket API from this
package's own server process** (only via the browser-based live pulls
described above, and against the canned stub) — that first real,
un-stubbed run should happen once this package is actually deployed
somewhere with real outbound network access, the same gap every other
package in this repo closed during its own deployment pass. `check_catalog.py`
(the toolkit's live catalog-conflict checker) also could not be run
directly in this build sandbox for the same network-egress reason; the
duplicate check for this service instead used direct live fetches
against `agent.pocket.network`'s real catalog and the Beta explorer's
services list — see `../docs/polymarket-intel-case.md` §7 for that
check's results (zero matches for "polymarket"/"predict"/"bet"/etc.
across three independent sources).

## SSRF / abuse surface

Like `wallet-defi-intel`, this backend does not take an arbitrary
caller-supplied hostname — every outbound call target is the fixed
Polymarket Gamma API host, never derived from request input. No SSRF
surface from caller input.

## A real limitation, disclosed rather than hidden

`/v1/rotation-diff`'s snapshot history is kept in memory only and resets
on every container restart. It reports `insufficient_history: true`
rather than fabricate a "before" comparison when it hasn't been running
long enough to have a snapshot far enough back for the requested
`lookback_hours` — the same honest-degradation convention this repo uses
elsewhere (e.g. `media-utils`'s `422 not_configured`, alpha1's
`chronos-forecast`'s "not enough history yet" note). A production
deployment that wants long-lookback rotation history working from day
one would need to warm this backend up (or persist snapshots externally)
before relying on `lookback_hours` values near the 168h ceiling.

## Testing

```
npm test                                 # contract tests: healthchecks, 200s, bad input -> 400 + JSON
node -r ./test/stub-fetch.js server.js   # run against canned fixtures, no network needed
npm start                                # needs real network access to gamma-api.polymarket.com
```

## Deploying

Not yet done. See `../docs/polymarket-intel-case.md` for the research
case this package was built from, and this repo's
`../docs/registration-runbook.md` for the general
register → deploy → stake → relay-test sequence every other package in
this repo followed — each of those steps for this package still needs
its own explicit go-ahead before any chain spend or production deploy,
per this repo's standing rule.
