# Pocket Agentic Services — contest submission package

Form: https://forms.gle/KHicKy1h6RggWMf18 ("Pocket Agentic Services Submission
Form"). Per the rules screenshot: **submit each service separately** — four
services means four form submissions, not one. Deadline: **midnight EST,
2026-10-12** — 20 days out from today (2026-09-22).

Required fields per the rules image: Service name, Testnet service ID,
Endpoint URL, Test tx ID, Submitter name, Submitter email, Service
description, Repository link.

Status legend: **✅ ready to paste** / **⏳ blocked** (needs an on-chain step
from `docs/registration-runbook.md` that only you can run).

---

## 1. POKT Network Intelligence

| Field | Value |
|---|---|
| Service name | POKT Network Intelligence |
| Testnet service ID | `pokt-network-intel` — ⏳ *planned, not yet registered on-chain* (runbook §5) |
| Endpoint URL | ⏳ blocked — needs a deployed backend + staked supplier + live RelayMiner (runbook §7–10) |
| Test tx ID | ⏳ blocked — needs a staked test application and a relayed, settled call (runbook §11) |
| Submitter name | *your name/handle — confirm before submitting* |
| Submitter email | *your email — confirm before submitting* |
| Service description | ✅ Eight live REST endpoints over Pocket Network's own Shannon-protocol chain state — network pulse, tokenomics, true bonded-stake validator data, supplier trust scoring, relay throughput, applications, and per-service demand. Every figure is fetched live from Pocket's own GraphQL indexer and Cosmos LCD on each request — no cached-forever constants, no simulated data. |
| Repository link | ⏳ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/pokt-network-intel` — *works once the repo below is pushed* |

## 2. RPC and Gateway Quality Intelligence

| Field | Value |
|---|---|
| Service name | RPC and Gateway Quality Intelligence |
| Testnet service ID | `rpc-quality-intel` — ⏳ planned, not yet registered |
| Endpoint URL | ⏳ blocked (same as above) |
| Test tx ID | ⏳ blocked (same as above) |
| Submitter name | *confirm* |
| Submitter email | *confirm* |
| Service description | ✅ Answers "how well is Pocket actually serving RPC access to this chain/service right now?" — a per-service settlement pulse, windowed relay-mining performance, anomaly detection against a trailing baseline (volume drop, supplier drop-off, slash-rate spike), and a real OLS linear-regression forecast, all computed live from on-chain claim and proof-settlement events. |
| Repository link | ⏳ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/rpc-quality-intel` |

## 3. Agent Trust and Compliance

| Field | Value |
|---|---|
| Service name | Agent Trust and Compliance |
| Testnet service ID | `agent-trust` — ⏳ planned, not yet registered |
| Endpoint URL | ⏳ blocked |
| Test tx ID | ⏳ blocked |
| Submitter name | *confirm* |
| Submitter email | *confirm* |
| Service description | ✅ Five live checks an autonomous agent can run before it trusts a counterparty domain, brand, or seller: RDAP + DNS + live TLS certificate inspection, an official Consolidated Screening List sanctions check, and a weighted composite seller-trust score with a documented `reasons[]` breakdown — plus a built-in SSRF guard so a caller-supplied hostname can never be used to probe internal infrastructure. |
| Repository link | ⏳ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/agent-trust` |

## 4. Wallet and DeFi Intelligence

| Field | Value |
|---|---|
| Service name | Wallet and DeFi Intelligence |
| Testnet service ID | `wallet-defi-intel` — ⏳ planned, not yet registered |
| Endpoint URL | ⏳ blocked |
| Test tx ID | ⏳ blocked |
| Submitter name | *confirm* |
| Submitter email | *confirm* |
| Service description | ✅ Wallet balance, risk, and heuristic "smart money" scoring, NFT holdings, and a combined prospect-enrichment profile for an EVM wallet, plus DeFi protocol health, live yield-opportunity ranking, and stablecoin depeg checking — including a one-call pre-transaction "precheck" that gates a wallet's risk against a target protocol's live TVL trend and hack history. |
| Repository link | ⏳ `https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/wallet-defi-intel` |

---

## What's actually blocking the ⏳ fields

Every blocked field needs a real on-chain action, in this order, per
`docs/registration-runbook.md`:

1. **Push the repo** (see the archive delivered alongside this file) — makes
   the repository links real and lets each card's `openapi.json` spec URL
   resolve.
2. **Register all 4 services** (runbook §5) — turns the planned service IDs
   into real ones. Needs your explicit go-ahead; burns ~1,000 POKT each on
   Beta (confirmed live 2026-09-19, re-check before running).
3. **Deploy the backends + one shared HA RelayMiner** (runbook §7–10) — pure
   infrastructure work, no chain spend, can happen anytime once the repo is
   pushed.
4. **Stake the supplier** (runbook §9) — needs your go-ahead; bonds
   ~59,500+ POKT (recoverable, not burned). Produces the real endpoint URLs.
5. **Stake one test application per service and relay a real call**
   (runbook §11) — needs your go-ahead; this step is what actually produces
   a **Test tx ID** for each service.
6. Fill in the confirmed endpoint URLs and tx IDs above, confirm your
   submitter name/email, and submit — **each service as its own form
   response**.

## Next steps, in order

1. I packaged the current repo as `pocket-agentic-services.tar.gz` — sent
   alongside this file. Create an empty GitHub repo named
   `pocket-agentic-services` under `organiccryptoyyc`, then either drag the
   extracted folder into GitHub's "Add file → Upload files" in the browser,
   or on your own machine:
   ```
   tar -xzf pocket-agentic-services.tar.gz && cd pocket-agentic-services
   git init && git add -A
   git commit -m "Four standalone Pocket Agentic Portal services"
   git remote add origin https://github.com/organiccryptoyyc/pocket-agentic-services.git
   git branch -M main
   git push -u origin main
   ```
   (That commit and push are yours to run — same rule as every other
   push/commit on this project.)
2. Tell me once it's pushed — I'll re-verify each card's `openapi.json`
   spec URL actually resolves before you register anything against it.
3. When you're ready to spend testnet POKT, say so explicitly and we'll go
   through runbook §5 (register) one service at a time.
4. Backend deployment (§7) and the RelayMiner stack (§8) can happen in
   parallel with step 3 — no approval needed there, just infrastructure;
   say the word if you want help scripting the Docker Compose side for your
   Pi.
5. Supplier stake (§9) and app-stake-and-relay (§11) are the last two
   approval-gated steps — once those land, this doc gets the real endpoint
   URLs and tx IDs and is ready to submit, service by service, well inside
   the Oct 12 deadline.
