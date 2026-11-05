# brand-protection: Brand Protection Monitor

A Pocket Network service that finds lookalike domains of a brand and says, with
evidence, which ones look like impersonation. Built for crypto brands first
(wallet-drainer sites copy DeFi front-ends). **Detection and evidence only:**
findings are observed signals, not a finding of fraud, and nothing here files
takedowns or interacts with suspect sites beyond one page fetch.

## Routes

| Route | Body | Returns |
|---|---|---|
| `POST /v1/brand/scan` | `{brand?, official_domains[1-5], keywords[]?, since?, limit?}` | The watched report. A brand nobody watched yet gets a quick DNS-only scan now (`scan_type: "quick"`, `full_scan: "queued"`) and a full scan on the collector's next cycle. `since` returns only findings new or changed after that time, so a weekly caller sees only what moved. |
| `POST /v1/brand/lookalikes` | `{domain, since?, limit?}` | The watched report if the domain is watched, else a live DNS-only check (cached 1 h, not added to the watch list). |
| `POST /v1/brand/evidence` | `{evidence_id}` | The evidence behind one finding: every source with its fetch time, DNS, RDAP, certificate, homepage summary with SHA-256, CT log entry. |
| `GET /v1/brand/watched` | — | Brands under watch, last scan, high-risk counts. |
| `GET /v1/version`, `GET /v1/health` | — | Identity and readiness. |

Every response is a JSON object; bad input is a 4xx JSON error, never a 5xx.

## Re-check engine (`lib/recheck.js`, library only)

`recheckDomain({domain, official_domains?, keywords?}, {previous?})` reads one domain live and returns a
`bp-recheck/1` record. No route calls it yet, so it changes nothing on the live service. Beyond a scan's evidence record it has:
which checks completed (`completeness`), one retry for passing network failures, a score marked as a floor when a
check is missing, whether the signals back each other up (`assessment.corroboration`, which never changes the score),
more registry and certificate detail, the wallet terms a page really used, what changed since an earlier record
(`changes`; a failed read is "not comparable", never a change) and a SHA-256 over the whole record
(`integrity`). That hash shows the record wasn't edited after hashing; it isn't a signature and says nothing about
whether a page's claims are true. Raw page content is never kept.

Try it: `node ops/recheck-cli.js <domain> [official-domain ...]`

## How a finding is made (`bp-risk/3`)

1. **Candidates:** our own permutations in priority order: TLD swap,
   added word (`-claim`, `-airdrop`, `-wallet` …), ASCII and IDN homoglyphs,
   omission, transposition, keyboard replacement, repetition, hyphenation, insertion.
   The code can also take names from Certificate Transparency logs, but that follower is not
   running on the live service, so `coverage.ct_hits` is 0.
2. **DNS** for every candidate; the ones that exist go on.
3. **RDAP** straight from the registry (IANA bootstrap), **TLS** handshake, and
   **one homepage GET** (robots.txt honoured, private addresses refused, pinned to
   the vetted IP, 512 KB cap). Only derived fields and hashes are kept.
4. **Score** 0–100 with reasons: resolves, MX, registered ≤30/≤180 days, fresh
   certificate, seen in CT, title names the brand, identical icon or title to the
   official site, password field, wallet/recovery-phrase prompt; parked pages and
   old registrations count down. A lookalike that **redirects to the official site**
   or **uses the official site's own nameservers** (on a provider that assigns
   per-account sets) is reported as the brand's own and capped at 20.

   `bp-risk/2` (from 0.1.4) was tuned on 1,446 real findings. A title that only repeats the site's own hostname doesn't
   count as naming the brand. An ordinary-word brand name ("curve", "pocket") in a title is worth +15 with support
   (domain up to 180 days old, identical icon or title, wallet prompt) and +5 without, and then the finding doesn't read
   as copying the brand. A distinctive name is worth +15, as before. A fresh certificate or password field on an
   established domain needs that support or a distinctive name in the title. Names missing from the common-word list
   count as distinctive, so the list can miss a false alarm but can't hide a finding by accident.

   `bp-risk/3` (from 0.1.5) adds the shape of the name: a live site named with the brand plus a word like `-wallet` or
   `-airdrop` is +15, unless it's parked or the brand's own. The name alone can't make a finding high: that needs a wallet
   prompt or a copied icon or title as well.

Statuses: `copies_brand`, `live`, `resolves`, `parked`, `registered_not_live`,
`redirects_to_official`, `likely_brand_owned`, `refused_private_address`,
`no_longer_seen` (kept 30 days so `since` callers learn about it).

## Data sources (phase 0 terms check, 2026-11-02)

Own DNS, registry RDAP, our own TLS handshake and page fetch, and Certificate
Transparency logs read directly. No third-party phishing feed is used: the free
ones (URLhaus, OpenPhish, PhishTank) do not allow use in a paid product.

## Running

```
npm test                         # 9 tests, no network
PORT=8080 node server.js         # API; add BP_INGEST_TOKEN to open the private ingest listener on 127.0.0.1:8090
node ops/package-psm.js beta     # PSM deploy folder in build/brand-protection-beta (needs .secrets/beta-ingest.env)
```

The collector that fills the store lives in the private repo
`organiccryptoyyc/brand-protection-collector` and uses this folder's `lib/` as its engine.
