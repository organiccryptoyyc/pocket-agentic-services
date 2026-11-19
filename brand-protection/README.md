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
| `POST /v1/brand/photo` | `{image_url}` or `{sha256, address or tx_hash}`, optional claimed `address` | Photo provenance (0.1.14, `bp-photo/1`): Content Credentials signer, the Nodle ContentSign mint on ZKsync Era that recorded the file's SHA-256, and a verdict. Never returns coordinates. |
| `GET /v1/version`, `GET /v1/health` | — | Identity and readiness. |

Every response is a JSON object; bad input is a 4xx JSON error, never a 5xx.

**Internal domain lookup (0.1.11).** A third listener (`lib/lookup.js`, port `BP_LOOKUP_PORT`, default
127.0.0.1:8091; the deploy compose sets 0.0.0.0 inside the container) answers
`GET /internal/domain?domain=<name>` with `match: official | lookalike | none`, the brand and the stored
finding. It is read-only, never starts a scan, is not in `deploy/routes.json` (so neither Caddy nor the
RelayMiner reach it), and serves `agent-trust`'s `/v1/preflight` over the Docker network.

## Photo provenance (`bp-photo/1`, 0.1.14)

**0.1.16: signature validation.** When a file carries Content Credentials, the image runs c2patool 0.27.22
(Content Authenticity Initiative, MIT/Apache-2.0) on it against the official C2PA trust list
(c2pa-org/conformance-public, 2026-11-04 copy, CC BY 4.0), both baked in at build time with pinned SHA-256s
(`lib/c2pa-validate.js`, Dockerfile). The answer then says whether the signature and every signed hash check out
(`signature_validated`), whether the signer chains to a trust-list root (`signer_on_trust_list`; a self-issued
credential such as Nodle's "ContentSign by Nodle" is reported as not on the list, never as trusted), and the C2PA
status codes. A file whose credentials fail validation gets the verdict `credentials_invalid`. Only codes and the
state leave the validator: assertion contents (EXIF, GPS) are never copied. The image moved from Alpine to
Debian 13 because the c2patool build needs glibc 2.38 or newer.

`POST /v1/brand/photo` answers "was this photo signed, by which address, and is it anchored on-chain?" from public data:

1. **In the file:** the C2PA Content Credentials (`lib/provenance.js`). For a Nodle Click photo, the signer certificate's
   common name is the user's address, issued by "Click Camera" / "ContentSign by Nodle". Signatures are read, not validated.
2. **On-chain:** Nodle ContentSign mints on ZKsync Era (contract `0x95b3641d549f719eb5105f9550eca4a7a2f305de`). Each
   token's IPFS metadata carries `content_hash`, the SHA-256 of the signed file. The signer's newest 25 mints are compared.
3. **Match:** the file's SHA-256 against that `content_hash`. A screenshot, crop or re-save changes the hash.

Verdicts: `signed_and_anchored`, `anchored_hash_match`, `anchor_hash_mismatch` (an edited copy), `signed_not_anchored`,
`no_credentials` (often a screenshot), `no_credentials_not_anchored`, `not_found`.

**Privacy:** `privacy_exposure` says only whether a precise location is public (the token metadata is permanent on
IPFS); coordinates are never returned. **RPC:** Pocket's ZKsync Era node is pruned and answers old-history reads with
empty results, so history (logs, receipts, old blocks) is read from the archive RPC `mainnet.era.zksync.io`.

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

## Artwork provenance (`bp-provenance/1`, 0.1.13)

For each live lookalike page (not parked or taken down), up to 4 page images (social card first) are read
through the same SSRF guard, 2 MB each, with a 10 s budget for the whole step and robots.txt honoured on other
hosts. For each image the evidence keeps the URL, SHA-256, format and:
- whether it carries **C2PA Content Credentials**, and who signed them (the signing certificate's subject and issuer);
- whether the credentials mark it **AI-generated** (IPTC `trainedAlgorithmicMedia`), and the recorded actions;
- an unsigned IPTC/XMP AI label, recorded separately as weaker;
- `test_certificate` for self-signed or "local use only" certificates (named by the tool, e.g. "xAI Grok Imagine", and marked not a trusted signer).

The result is in the evidence record (`homepage.artwork_provenance`), with a `statement` a takedown file can quote, for example:
"1 of 2 images checked on this page carries C2PA Content Credentials marking it as AI-generated, signed by
OpenAI OpCo, LLC (OpenAI Media Service)." A finding with such images also lists `ai_artwork_signers`.

**Evidence only:** it never changes the risk score, because legitimate sites use AI images too. Signatures are read,
not cryptographically validated, and signers are not checked against the C2PA trust list. No credentials never
means "authentic" or "human-made": most sites don't add them, and many hosts strip them. Image bytes are never kept.
Survey behind it (2026-11-16): 0 of 332 images on 41 official brand sites carried credentials; 21 of 960 images on 7 of
184 lookalike sites did, mostly OpenAI-signed AI images.

## How a finding is made (`bp-risk/5`)

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

   `bp-risk/4` (from 0.1.7) reads non-crypto phishing, from a hand check of fintech and login brands. A password field
   under the brand's name is +30 and counts as page evidence. A page claiming to be a bank or regulated service is +15
   with support. A host's own suspected-phishing warning is +40 and counts as page evidence. A site its host has pulled
   is at most 30 (`taken_down`), unless the page still asks for a password or a wallet. The name's shape doesn't count on
   a domain over 3 years old. Added words now include `account`, `billing`, `invoice`, `payment`, `pay`, `bank`, `signin`, `auth`.

   `bp-risk/5` (from 0.1.8) stops ordinary-word brands ("badger", "chime") flagging other businesses. It was checked by
   rescoring all 2,494 stored MainNet findings: 7 moved from medium to low, all of them other businesses (an invoicing
   site, a casino review site, a federal-contracts site and others), and no high finding changed. For an ordinary-word
   brand on a domain over 60 days old, a title naming the brand needs a copied icon or title or a wallet prompt. The
   name's shape no longer counts when the site shows a real title of its own (not a placeholder, an error page, a bare
   "Sign in" or its hostname) and nothing points at the brand. Distinctive brands are unchanged.

Statuses: `copies_brand`, `live`, `resolves`, `parked`, `registered_not_live`,
`redirects_to_official`, `likely_brand_owned`, `taken_down`, `refused_private_address`,
`no_longer_seen` (kept 30 days so `since` callers learn about it).

## Data sources (phase 0 terms check, 2026-11-02)

Own DNS, registry RDAP, our own TLS handshake and page fetch, and Certificate
Transparency logs read directly. No third-party phishing feed is used: the free
ones (URLhaus, OpenPhish, PhishTank) do not allow use in a paid product.

## Running

```
npm test                         # no network
PORT=8080 node server.js         # API; add BP_INGEST_TOKEN to open the private ingest listener on 127.0.0.1:8090
node ops/package-psm.js beta     # PSM deploy folder in build/brand-protection-beta (needs .secrets/beta-ingest.env)
```

The collector that fills the store lives in the private repo
`organiccryptoyyc/brand-protection-collector` and uses this folder's `lib/` as its engine.
