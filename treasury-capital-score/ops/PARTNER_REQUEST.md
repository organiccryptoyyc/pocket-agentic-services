# TCS-6: listing request for the Pocket partner channel / portal@pokt.foundation

Send from the owner's own account. Attach `sage-service.yaml` and `portal-descriptor.json` (both in this folder).
Replace https://github.com/pokt-network/pocket-network-resources/pull/8 once the health-check PR is open (see GATEWAY_LISTING.md, section 1).

---

**Subject:** Listing request: treasury-capital-score (TCS-6) on the Agentic Portal and public gateways

Hi PNF team,

I'd like to list a MainNet agentic service on the Agentic Portal (agent.pocket.network) and the public gateways.

- **Service ID:** `treasury-capital-score` ("TCS-6 Crypto Treasury Capital Score")
- **Owner:** `pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw`
- **Supplier:** `pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx` (same supplier as `prediction-market-intel`), endpoint `https://agentic.organiccryptoyyc.com` (REST)
- **Registered:** MainNet tx `AC7998B289936BA666D770B59EAC3778F9FF55E1FAD955C5FA40D01366830B35`, 100,000 CU per relay
- **Category:** finance

**What it does:** treasury-strength reports for DeFi protocols and DAOs. It lists 26 protocols: 18 have a full score, 4 a treasury-only (partial) report, and the rest are awaiting vetting. Each report gives net realizable treasury after realization haircuts, liquid runway against approved spending, obligations, a stress test, a peer ranking and governance controls. Every figure is cited. `POST /v1/tcs6/score {"entity_id":"compound"}` returns the report; `POST /v1/tcs6/entities {}` lists the protocols. Every response is a single JSON object. Reports refresh every 12 hours and are served from cache (about 2.5 to 3.5 seconds end to end through a relay).

**Verified on MainNet relays (2026-10-03, via pocket-ap):**
- `GET /v1/version` → 200, contains `"treasury-capital-score"`
- `GET /v1/health` → 200, contains `"status":"ok"` (22 reports scored in the last pipeline run, 0 failed)
- `POST /v1/tcs6/entities {}` → 200, contains `"method_version":"tcs-6/1.0"`

Beta TestNet was used first for every change (relays settled on chain), then MainNet.

**Attached:**
1. `sage-service.yaml`: SAGE gateway config (passthrough, `rpc_types: ["rest"]`, 15s relay timeout, version and health checks).
2. `portal-descriptor.json`: suggested portal entry in your descriptor format (display name, description, category, input/output schema, methods, example).

**Health-check PR** to `pocket-network-resources/pocket-health-checks.yaml`: https://github.com/pokt-network/pocket-network-resources/pull/8

**Methodology and schema:** https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/treasury-capital-score (openapi.json, methodology/).

Happy to adjust the description, example or anything else you need. Thanks!

organic (organiccryptoyyc)
