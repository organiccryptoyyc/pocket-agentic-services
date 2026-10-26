# Capital Integrity Dossier: listing request for portal@pokt.foundation

Send from the owner's own account **after** the MainNet relay test has a settled claim (the "Verified on MainNet"
line below is filled in then). Attach `sage-service.yaml` and `portal-descriptor.json` (both in this folder).
Optional: open a PR to `pocket-network-resources/pocket-health-checks.yaml` with `pocket-health-checks-entry.yaml`,
the same way as TCS-6 (PR #8), and add its link.

---

**Subject:** Listing request: capital-integrity-dossier (multi-call, disclosed) on the Agentic Portal and public gateways

Hi PNF team,

I'd like to list a new MainNet agentic service on the Agentic Portal (agent.pocket.network) and the public gateways.
It is a companion to `treasury-capital-score` (TCS-6), which you already list.

- **Service ID:** `capital-integrity-dossier` ("Capital Integrity Dossier")
- **Owner:** `pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw`
- **Supplier:** `pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx` (same supplier as TCS-6), endpoint `https://agentic.organiccryptoyyc.com` (REST)
- **Registered:** MainNet tx `67458FE223E8E68FF13AB0D747737CF16B74387EE0E487A509C2512BE4A5B86A` (block 981,477), 100,000 CU per relay. Beta TestNet tx `17160AA02AE03353ACE25FB81BEE9E3D577D1150C76F51A2002946E3524DCA85`.
- **Category:** finance

**What it does:** a deep, section-by-section treasury dossier on the protocols TCS-6 scores: every position by wallet
and chain with its haircut and price source, who can move the money (Safe thresholds and signers shared across
wallets), the obligations register with a score breakdown, what could be sold now (locks, loan health), the
protocol's own reported total against what we observe on chain, and every unresolved gap.

**This is a multi-call service, disclosed up front.** A full dossier takes **up to 7 calls** (up to **$0.035** at
the portal's $0.005 per call):
1. `POST /v1/dossier/plan {"entity_id":"inverse-finance"}` returns a `dossier_id`, the sections available for that
   protocol, `calls_required`, the estimated total and a buyer notice, before the buyer commits.
2. `POST /v1/dossier/section {"dossier_id":"…","section":"…"}` once per section, in any order; the buyer can stop at
   any point. Every response shows `calls_used`, `calls_remaining` and the remaining estimate.

Sections a protocol's data can't support are marked unavailable in the plan and left out of the call count, so a
buyer never pays for an empty section. The card, the OpenAPI description and every plan response state the call
count and the estimate. Every response is a single JSON object (charts are JSON series), and every section carries
the reference to the signed TCS-6 input attestation of the snapshot it was built from.

**Verified:** Beta TestNet 2026-10-26: a full 7-call dossier relayed through pocket-ap (all 200, about 2.5 s each),
claimed, and the proof accepted on chain. MainNet: _<fill in after the MainNet relay: date, calls, settled claim>_.

**Attached:**
1. `sage-service.yaml`: SAGE gateway config (`type: generic`, `rpc_types: ["rest"]`, 15 s relay timeout, version and health checks).
2. `portal-descriptor.json`: suggested portal entry in your descriptor format, with a typed outputSchema and the multi-call example.

**Source, schema and docs:** https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/capital-integrity-dossier (openapi.json, README.md).

Happy to adjust the description, example or anything else you need. Thanks!

organic (organiccryptoyyc)
