# PMI: listing request for portal@pokt.foundation / Pocket partner channel

Attach `sage-service.yaml` and `portal-descriptor.json` (this folder). Health-check PR: <PR link>.

---

**Subject:** Listing request: prediction-market-intel on the Agentic Portal and public gateways

Hi PNF team,

Following the TCS-6 request, here is the second service from the same supplier, for the Agentic Portal (agent.pocket.network) and the public gateways.

- Service ID: prediction-market-intel ("Prediction Market Intelligence")
- Owner: pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw
- Supplier: pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx (same supplier as treasury-capital-score), endpoint https://agentic.organiccryptoyyc.com (REST)
- Registered: MainNet tx 14E556FABF748BD30BE44FDA765D28B9E40EE27665E533810A6BD01DD22F1726, 100,000 CU per relay
- Category: finance

What it does: agent-ready signals from Polymarket's live public market data, not a raw passthrough. POST /v1/top-markets (top open markets by trailing volume), /v1/market-momentum (biggest consensus shifts), /v1/rotation-diff (entries and exits from the top 100; reports insufficient_history rather than guessing) and /v1/market-quality (0-100 liquidity and spread score with reasons). Every response is a single JSON object. Data is live with a 3-minute cache, so results vary. Independent project, not affiliated with Polymarket. Version 1.0.1 (bad input returns 400 with a JSON error).

Verified on MainNet relays (2026-10-04, via pocket-ap):
- GET /v1/version: 200, contains "service":"prediction-market-intel"
- GET /v1/health: 200, contains "status":"ok"
- POST /v1/top-markets {"limit":1}: 200, contains "count":1

Note on timeouts: a cache miss makes 4 parallel calls to Polymarket (12s timeout, 1 retry), so the SAGE config uses a 30s relay timeout and the functional health check a 15s timeout.

Attached:
1. sage-service.yaml: SAGE gateway config (passthrough, rpc_types ["rest"], 30s relay timeout, version and health checks).
2. portal-descriptor.json: suggested portal entry in your descriptor format.

Health-check PR to pocket-network-resources/pocket-health-checks.yaml: <PR link>

Schema: https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/prediction-market-intel (openapi.json).

Thanks again!

organic (organiccryptoyyc)
