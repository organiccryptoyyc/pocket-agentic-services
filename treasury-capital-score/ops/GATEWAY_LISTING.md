# Gateway listing for treasury-capital-score

The on-chain stake alone doesn't make TCS-6 discoverable on agent.pocket.network.
Gateways don't read the service card. There are two separate pieces.

## 1. Pull request: public gateway health checks

Target file: `pocket-health-checks.yaml` in https://github.com/pokt-network/pocket-network-resources.

Easiest path is GitHub's web editor, which forks the repo and opens the PR for you:

1. Open https://github.com/pokt-network/pocket-network-resources/edit/main/pocket-health-checks.yaml
2. Press Ctrl+End to jump to the end of the file, add one empty line, and paste the whole contents of
   [`pocket-health-checks-entry.yaml`](pocket-health-checks-entry.yaml).
3. Click **Commit changes…** → **Propose changes**, then **Create pull request** with the text below.

**PR title:**
```
Add health checks for treasury-capital-score (TCS-6)
```

**PR description:**
```
Adds gateway health checks for `treasury-capital-score`, TCS-6 Crypto Treasury Capital
Score: a paid, derived treasury analysis REST service for DeFi protocols (six weighted
dimensions, five hard gates, cited sources).

- Registered on MainNet (tx AC7998B289936BA666D770B59EAC3778F9FF55E1FAD955C5FA40D01366830B35)
- Supplier pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx, endpoint https://agentic.organiccryptoyyc.com
- Not a blockchain service, so no sync_check / sync_allowance
- Checks mirror the on-chain card's serving.healthcheck: GET /v1/version (identity),
  GET /v1/health (readiness), POST /v1/tcs6/entities {} (deterministic functional check)
- Verified via MainNet relays with pocket-ap on 2026-10-02 and again on 2026-10-03: all three
  return 200 with the expected strings
```

## 2. Message: SAGE gateway config (Pocket partner channel)

**Current version (2026-10-03): use [`PARTNER_REQUEST.md`](PARTNER_REQUEST.md)** and attach `sage-service.yaml` + `portal-descriptor.json`.
The Agentic Portal (agent.pocket.network) is curated by PNF (contact portal@pokt.foundation); the text below is the original 2026-10-02 draft.

Attach [`sage-service.yaml`](sage-service.yaml) and post:

```
Hi team, requesting gateway onboarding for a new agentic service on MainNet:

Service ID: treasury-capital-score ("TCS-6 Crypto Treasury Capital Score")
Owner: pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw
Supplier: pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx (same supplier as prediction-market-intel)
Endpoint: https://agentic.organiccryptoyyc.com (REST)
Price: 100,000 CU/relay

What it does: paid treasury-strength reports for DeFi protocols (Aave, Sky, Compound,
Lido, Curve, Morpho, Yearn): six weighted dimensions, hard gates, realization haircuts,
cited sources. POST /v1/tcs6/score {"entity_id":"lido"} returns the report;
POST /v1/tcs6/entities {} lists the registry. Every response is a JSON object; reports
refresh every 12h and are served from cache (about 2.5s end to end through a relay).

Attached: sage-service.yaml (passthrough, rpc_types ["rest"], 15s relay timeout, version
and health checks). A matching PR to pocket-health-checks.yaml is open: <PR link>.

Tested on Beta TestNet first (relays settled on chain), then MainNet relays verified.
Methodology: the card's specs[] link to the scoring blueprint.
```
