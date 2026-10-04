# PMIC packs: listing request for portal@pokt.foundation

Send from the owner's own account. Attach the `sage-service.yaml` and `portal-descriptor.json` of
each of the three services (in `ops/<service_id>/`, also in `pnf-listing-pmic.zip`). Then open the
health-check PR (section 2).

## 1. Email

**To:** portal@pokt.foundation
**Subject:** Listing request: three PMIC agentic services on the Agentic Portal and public gateways

```
Hi PNF team,

I'd like to list three more MainNet agentic services on the Agentic Portal (agent.pocket.network)
and the public gateways. They run on the same supplier as prediction-market-intel and
treasury-capital-score.

- Owner: pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw
- Supplier: pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx, endpoint https://agentic.organiccryptoyyc.com (REST)
- Price: 100,000 CU per relay for each

1. pmic-macro-signals, "PMIC Macro and Markets Signals" (finance)
   Registered: tx 13C220122C7865E33430599E3EFCDE8CE1B76784A1CBCB5BC8915F8BF53B568C
   Scored, cited briefs from FRED, BLS, BEA and the World Bank: economic regime, inflation,
   labor market, rates and yield curve, bank credit stress, commodities, and an 8-country
   comparison, plus a CPI inflation calculator.
   Example: POST /v1/brief {"vertical":"inflation"} -> 59/100 "steady", six inputs, each cited.

2. pmic-company-signals, "PMIC Company Fundamentals and Filing Risk" (finance)
   Registered: tx 76013FFEACCA53888EE67ACD08C2D26B4BA08CA1C649A0945975C8A2BD2F074F
   SEC EDGAR fundamentals score and 8-K filing-risk score for 14 large US companies.
   Example: POST /v1/brief {"vertical":"filing-risk","entity_id":"nvda"} -> 45/100 "active"
   (no high-severity 8-Ks, six medium, each linked to EDGAR).

3. pmic-pharma-signals, "PMIC Pharma Safety and Approval Signals" (health)
   Registered: tx F5ABC787554042422697E628E834592EA280E2D416B41B3794A1B440F276667E
   openFDA drug-market safety and approvals brief, and per-company safety briefs for Pfizer,
   Eli Lilly and Johnson & Johnson (recalls, adverse event reports, approvals, label changes).
   Example: {{PHARMA_EXAMPLE}}

Every answer is one JSON object: a 0-100 score with label, trend, the inputs that drive it, risk
flags, confidence and a source link for every input. Data is free official public data only.
POST /v1/verticals {} lists what each service sells. Responses take about 2.5 seconds end to end
through a relay (5-minute cache).

Verified on 2026-10-04: live relays on Beta TestNet, then paid MainNet relays. GET /v1/version,
GET /v1/health and POST /v1/verticals {} return 200 with the expected strings on all three.

Attached for each service: sage-service.yaml (passthrough, rpc_types ["rest"], 15s relay timeout,
version, health and functional checks) and portal-descriptor.json (your descriptor format).

Health-check PR to pocket-health-checks.yaml: {{PR_LINK}}

Method and schemas: https://github.com/organiccryptoyyc/pocket-agentic-services/tree/main/pmic/packs
(README.md, ops/<service_id>/openapi.json).

Happy to adjust anything. Thanks!

organic (organiccryptoyyc)
```

## 2. Health-check pull request

Target: `pocket-health-checks.yaml` in https://github.com/pokt-network/pocket-network-resources
(the same file as PR #8 for treasury-capital-score).

1. Open https://github.com/pokt-network/pocket-network-resources/edit/main/pocket-health-checks.yaml
2. Press Ctrl+End, add one empty line, and paste all of
   [`pocket-health-checks-entry.yaml`](pocket-health-checks-entry.yaml).
3. Click **Commit changes…**, then **Propose changes**, then **Create pull request** with:

**Title:** `Add health checks for pmic-macro-signals, pmic-company-signals, pmic-pharma-signals`

**Description:**
```
Adds gateway health checks for three PMIC agentic REST services (scored, cited briefs from
official public data) on supplier pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx,
endpoint https://agentic.organiccryptoyyc.com.

- pmic-macro-signals: registered tx 13C220122C7865E33430599E3EFCDE8CE1B76784A1CBCB5BC8915F8BF53B568C
- pmic-company-signals: registered tx 76013FFEACCA53888EE67ACD08C2D26B4BA08CA1C649A0945975C8A2BD2F074F
- pmic-pharma-signals: registered tx F5ABC787554042422697E628E834592EA280E2D416B41B3794A1B440F276667E
- Not blockchain services, so no sync_check / sync_allowance
- Checks mirror each service card's serving.healthcheck: GET /v1/version (identity),
  GET /v1/health (readiness), POST /v1/verticals {} (functional)
- Verified through Beta TestNet and MainNet relays on 2026-10-04
```

Then put the PR link into the email above before sending it.
