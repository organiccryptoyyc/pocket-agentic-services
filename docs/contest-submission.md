# Pocket Agentic Services — contest submission package

Form (confirmed live, 2026-09-24 — read directly, this is the real field
order, not reconstructed from the rules screenshot):
https://docs.google.com/forms/d/e/1FAIpQLScOgCt7oZhIGWgvMNBNxxmK-6W_7wTJbpzAvI-_KxqEk52BIw/viewform
("Pocket Network Agentic Services Hackathon Submission Form"). **Submit
each service separately — four services means four form responses**, one
at a time. Deadline: **midnight EST, 2026-10-12**.

Status legend: **✅ ready to paste** / **⏳ blocked** (needs an on-chain or
infra step from `docs/registration-runbook.md`) / **❓ needs your input**.

**Resolved, 2026-09-24, against the primary source (Discord FAQ +
announcement, screenshotted by the user):** the ~59,500 POKT Beta
supplier stake is **not** sponsored. The FAQ and announcement only
mention two sponsorship mechanisms, and both are MainNet-only, after
judging: (1) top-3 selected services get a MainNet appstake (7,500 /
5,000 / 2,500 POKT) plus 1,000 POKT to register on MainNet plus a 2.5%
data-owner fee "for life"; (2) up to 5 more "Judge's favorites" get a
1,500 POKT foundation appstake once staked. Nothing sponsors the Beta
supplier stake needed to actually get a service servable right now — that
part is still on us, via runbook §9. Not a financial problem regardless:
it's free Beta faucet POKT, never burned, recoverable on unstake — same
as already told you, just confirmed against the real rules now rather
than my earlier guess from searching Pocket's public site.

**Also clarified, same source:** "Test Transaction ID" is **not** the
service-registration transaction (the `MsgAddService` txs you already
have four of — those just create the service entry, they never touch the
backend). It has to be a real relay: something actually called the
service through a staked supplier and a staked application. The FAQ notes
Pocket will *separately* re-test every submitted service themselves via
their own "staging app" after submission — that's independent verification
on their side, not a substitute for the Test Transaction ID the form
itself requires before you submit. So runbook §7–11 (deploy backend,
stand up RelayMiner, stake supplier, stake one app per service, make one
real relay call per service) is still the path to both the Endpoint URL
and the Test Transaction ID — nothing here shortens it.

**The exact form fields, in the order the form actually asks them
(confirmed 2026-09-24 by opening the live form):**

1. Name
2. Email
3. Discord Username
4. Service Name
5. Service Description
6. Testnet Service ID
7. Endpoint URL
8. Test Transaction ID
9. Repository Link
10. How should judges test your service? (setup notes / example request /
    testing instructions)
11. Which category best fits your service? (single choice: Data service /
    API wrapper / AI tool / Utility Service / Research tool / Automation
    helper / Other)
12. Confirmation checkbox: "I confirm that my service is deployed on
    testnet and the information submitted is accurate."

---

## Fields shared across all 4 submissions

| Field | Value |
|---|---|
| Name | ✅ `organiccryptoyyc` |
| Email | ✅ `9718149@gmail.com` |
| Discord Username | ✅ `genx_58243` |

## 1. POKT Network Intelligence

| Field | Value |
|---|---|
| Service Name | POKT Network Intelligence |
| Service Description | ✅ Eight live REST endpoints over Pocket Network's own Shannon-protocol chain state — network pulse, tokenomics, true bonded-stake validator data, supplier trust scoring, relay throughput, applications, and per-service demand. Every figure is fetched live from Pocket's own GraphQL indexer and Cosmos LCD on each request — no cached-forever constants, no simulated data. |
| Testnet Service ID | ✅ `pokt-network-intel` — registered live on Beta, 2026-09-24 (tx `ADFAF0A07DBA1306AB3DD56E203FABD0B7C907FABD49D288651A306C71E8ACF1`) |
| Endpoint URL | ✅ `https://agentic.organiccryptoyyc.com:8444` — live, confirmed reachable end-to-end 2026-09-26 (TLS handshake + relayer response) |
| Test Transaction ID | ✅ `ECCFADEADBC1829EF57FAF30FFE66D6903992B6D87B073C9F7A4186A1575D1A2` — `MsgCreateClaim`, verified live against the LCD, 2026-09-26 |
| Repository Link | ✅ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/pokt-network-intel` |
| How should judges test your service? | ✅ draft: "POST to `<endpoint>/v1/tokenomics` with body `{}` — response is a JSON object including `mint_ratio` (a live governance parameter, 0–1 range, fetched fresh from the Cosmos LCD on every call, not cached-forever). Other resources: `/v1/pulse`, `/v1/validators`, `/v1/suppliers`, `/v1/throughput`, `/v1/applications`, `/v1/service-demand` all take `{}`; `/v1/supplier-trust` takes `{\"operator_id\":\"<a live supplier address>\"}`. All responses are single JSON objects; bad input returns 4xx JSON, never HTML." |
| Category | ✅ Data service |

## 2. RPC and Gateway Quality Intelligence

| Field | Value |
|---|---|
| Service Name | RPC and Gateway Quality Intelligence |
| Service Description | ✅ Answers "how well is Pocket actually serving RPC access to this chain/service right now?" — a per-service settlement pulse, windowed relay-mining performance, anomaly detection against a trailing baseline (volume drop, supplier drop-off, slash-rate spike), and a real OLS linear-regression forecast, all computed live from on-chain claim and proof-settlement events. |
| Testnet Service ID | ✅ `rpc-quality-intel` — registered live on Beta, 2026-09-24 (tx `93F1579EF24E5DAE61334FB593A7ADEA5A3B6A85AF503D0FFAEB419312680270`) |
| Endpoint URL | ✅ `https://agentic.organiccryptoyyc.com:8444` — live (same shared endpoint, confirmed 2026-09-26) |
| Test Transaction ID | ✅ `E23DE328D3771CB4D366D4C057EBBEF4A3B8E8759468ED810D96B1F6F60A8196` — `MsgCreateClaim`, verified live against the LCD, 2026-09-26 |
| Repository Link | ✅ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/rpc-quality-intel` |
| How should judges test your service? | ✅ draft: "POST to `<endpoint>/v1/rpc-pulse` with body `{\"service_id\":\"pnf-pocket-beta\"}` — `pnf-pocket-beta` is a real, actively-served Beta service (32 suppliers, high relay volume as of 2026-09-26), confirmed live against Pocket's own service catalog (note: `\"pocket\"` is NOT a valid service ID on Beta — the backend correctly 404s on it). Response includes `active_suppliers` (live count). Other resources: `/v1/rpc-performance`, `/v1/rpc-anomaly`, `/v1/rpc-forecast`, same required `service_id` field, optional windowing params documented in the OpenAPI spec." |
| Category | ✅ Data service |

## 3. Agent Trust and Compliance

| Field | Value |
|---|---|
| Service Name | Agent Trust and Compliance |
| Service Description | ✅ Five live checks an autonomous agent can run before it trusts a counterparty domain, brand, or seller: RDAP + DNS + live TLS certificate inspection, an official Consolidated Screening List sanctions check, and a weighted composite seller-trust score with a documented `reasons[]` breakdown — plus a built-in SSRF guard so a caller-supplied hostname can never be used to probe internal infrastructure. |
| Testnet Service ID | ✅ `agent-trust` — registered live on Beta, 2026-09-24 (tx `559DB8CF376528239E9654BC0FBC0B78CD9D3B02A8A35A527AFE4C4AA76B3DF2`) |
| Endpoint URL | ✅ `https://agentic.organiccryptoyyc.com:8444` — live (same shared endpoint, confirmed 2026-09-26) |
| Test Transaction ID | ✅ `04727BC292BA71B6C2A238DF000B0DFAAD2B45C2F92E0DEB5DC5BF964184CFE8` — `MsgCreateClaim`, verified live against the LCD, 2026-09-26 |
| Repository Link | ✅ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/agent-trust` |
| How should judges test your service? | ✅ draft: "POST to `<endpoint>/v1/domain-trust` with body `{\"domain\":\"example.com\"}` — `example.com` is IANA-reserved and always resolvable, so this never depends on external test-domain uptime. Response includes `trust_score` (0–100, live-computed from real RDAP + DNS lookups) and a `reasons[]` array. Other resources: `/v1/brand-verify`, `/v1/seller-trust`, `/v1/reputation` take a `domain`/`url`/`address`; `/v1/sanctions-check` needs the operator's own free trade.gov API key configured, documented in the README." |
| Category | ✅ Utility Service |

## 4. Wallet and DeFi Intelligence

| Field | Value |
|---|---|
| Service Name | Wallet and DeFi Intelligence |
| Service Description | ✅ Wallet balance, risk, and heuristic "smart money" scoring, NFT holdings, and a combined prospect-enrichment profile for an EVM wallet, plus DeFi protocol health, live yield-opportunity ranking, and stablecoin depeg checking — including a one-call pre-transaction "precheck" that gates a wallet's risk against a target protocol's live TVL trend and hack history. |
| Testnet Service ID | ✅ `wallet-defi-intel` — registered live on Beta, 2026-09-24 (tx `41815FFA6D663E8EFAE84C59A2F45A9BB695789876140127A5207DD8BE89AE1B`) |
| Endpoint URL | ✅ `https://agentic.organiccryptoyyc.com:8444` — live (same shared endpoint, confirmed 2026-09-26) |
| Test Transaction ID | ✅ `8D546919822E33A7F4E39F0B49D66E4D6537A5F85DF1C141CC2729D1A1887222` — `MsgCreateClaim`, verified live against the LCD, 2026-09-26 |
| Repository Link | ✅ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/wallet-defi-intel` |
| How should judges test your service? | ✅ draft: "POST to `<endpoint>/v1/protocol-health` with body `{\"protocol\":\"aave\"}` — Aave is a large, long-lived DefiLlama-tracked protocol. Response's `protocol` field should read `\"Aave\"`, with live TVL/hack-history data. Other resources: `/v1/wallet-balance`, `/v1/wallet-risk`, `/v1/smart-money`, `/v1/prospect-enrichment`, `/v1/nft-analytics` take `{\"chain\":\"eth\",\"address\":\"<any EVM address>\"}`; `/v1/precheck` takes `chain`+`address`+`protocol`; `/v1/depeg-check` takes `{\"symbol\":\"usdc\"}`; `/v1/yields` takes optional filters." |
| Category | ✅ Data service |

---

## 5. Agent Media Utilities

| Field | Value |
|---|---|
| Service Name | Agent Media Utilities |
| Service Description | ✅ Three things an autonomous agent regularly needs and had nowhere to get on Pocket's Agentic Portal as of 2026-09-26 (checked against the live 99-service catalog before building this): render one real page of a PDF to an image, convert an image between formats including real HEIC/HEVC photos, and transcribe a short audio clip to text. Every conversion runs through real, standard tools (poppler, libvips/sharp + libheif, ffmpeg, whisper.cpp) on the request's own bytes — nothing simulated or cached-forever. |
| Testnet Service ID | ⏳ `media-utils` — conflict-checked clean on both Beta and MainNet LCDs, 2026-09-26; not yet registered (runbook §17, step 5) |
| Endpoint URL | ⏳ will be the same shared endpoint, `https://agentic.organiccryptoyyc.com:8444`, once deployed (runbook §17, step 3) |
| Test Transaction ID | ⏳ blocked on registration + supplier restake + relay-testing (runbook §17, steps 5-10) |
| Repository Link | ✅ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/media-utils` |
| How should judges test your service? | ✅ draft: "POST to `<endpoint>/v1/pdf-render` with body `{\"pdf_base64\":\"<any small PDF, base64>\",\"page\":1,\"dpi\":100,\"format\":\"png\"}` — response includes real `width`/`height` and a real `image_base64` PNG. `/v1/image-convert` takes `{\"image_base64\":\"<any image, base64, including real HEIC>\",\"to\":\"png\"}` — format is auto-detected, no `from` field needed. `/v1/audio-transcribe` takes `{\"audio_base64\":\"<clip, base64>\"}` and returns a `job_id` immediately (design rule 7: no streaming through a gateway); poll `/v1/audio-transcribe-status` with `{\"job_id\":\"...\"}` until `status` is `done`." |
| Category | ✅ Utility Service |

---

## Status, 2026-09-26 — 4 of 5 submitted, media-utils in progress

The original 4 services have every field verified (all 4 Test Transaction
IDs confirmed against the raw LCD, not just the indexer) and **all 4 form
responses have been submitted** by the user directly in Google Forms:
pokt-network-intel, rpc-quality-intel, agent-trust, wallet-defi-intel.
That's the whole submission pipeline (§5 registration through §11
relay-testing) closed out ahead of the Oct 12 deadline.

Each Test Transaction ID above is the RelayMiner's automatic
`MsgCreateClaim` transaction — submitted on-chain after a session ends and
the claim window opens, produced by a real relay through the staked
supplier and a staked test application (never the `MsgAddService`
registration tx). Found and verified via the Beta indexer
(`data.beta.pocket.network/graphql`, `msgCreateClaims` filtered by
`supplierId`) and cross-checked against the raw Cosmos LCD
(`GET /cosmos/tx/v1beta1/txs/<hash>`) for `code: 0` and the real
`/pocket.proof.MsgCreateClaim` message — not just trusted from the
indexer.

A 5th service, media-utils, is built and code-complete (see its own
README's "Verification" for exactly what was and wasn't run for real) but
not yet registered, staked, or deployed — see
`docs/registration-runbook.md` §17 for the exact live-checked state and
the ordered steps left, each still gated on explicit approval at the time.

## Next steps

Finish media-utils (runbook §17) and submit its form response as the 5th
entry — this is the only thing left. Once that's done: nothing required
for the contest submission itself. Optional follow-ups if you want them
later: onboard a gateway (runbook §12, not needed for the contest), or the
eventual MainNet pass (runbook §13, its own fresh approval, only if/when a
service is selected).
