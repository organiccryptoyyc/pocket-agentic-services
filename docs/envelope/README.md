# pocket-agentic-envelope/1 — one entity and evidence schema for every service

Status: **step 1 of 4 done (spec and mapping); owner decisions recorded 2026-11-11.** Nothing here is deployed, and no service response
changes until a service's own Beta release adds the field (see [Rollout](#rollout)).

## What it is

Every service in this repo answers a different question, but every answer has the same four parts:
**who** it is about, **when** that was true, **what** it concluded, and **which evidence** backs it. Today each
service spells those parts differently (`entity`, `domain`, `brand_id`, `address`; `citations`, `sources`,
`source_manifest`, `reasons`). The envelope is one shared spelling, added to each response as **one new optional
top-level field, `verified`**:

```json
{
  "...the service's own fields, unchanged...": "...",
  "verified": {
    "schema": "pocket-agentic-envelope/1",
    "service": "pmic-company-signals", "service_version": "0.6.0", "route": "/v1/brief",
    "subject":    { "kind": "company", "id": "company:sec-cik:0000070858", "name": "Bank of America Corp.", "identifiers": { "ticker": "BAC" } },
    "as_of": "2026-10-12", "generated_at": "2026-10-20T15:02:11Z",
    "assessment": { "status": "ok", "native_status": "ok", "score": 15, "scale": { "min": 0, "max": 100, "higher_is": "riskier" },
                    "label": "insider activity", "confidence": { "score": 98, "label": "high" }, "coverage_pct": null },
    "evidence":   [ { "source_ref": "sec:BAC:insider_form4_weekly", "publisher": "SEC EDGAR", "url": "https://www.sec.gov/...",
                      "title": "...", "retrieved_at": null, "observation_time": "2026-10-12", "source_tier": 1,
                      "rights_status": "permitted_for_derived_output" } ],
    "gaps":       [ { "field": "inputs[...]", "reason": "single_source", "impact": "no cross-source check" } ],
    "attestation_ref": null
  }
}
```

Files:

| File | What |
|---|---|
| [`pocket-agentic-envelope-v1.schema.json`](pocket-agentic-envelope-v1.schema.json) | The JSON Schema (2020-12) |
| [`examples/`](examples/) | One envelope per subject kind: protocol (TCS-6), company (PMIC), brand, domain (agent-trust), topic (PMIC macro) |
| [`validate.mjs`](validate.mjs) | Dependency-free validator: `node docs/envelope/validate.mjs [file ...]` |
| [`validate.test.mjs`](validate.test.mjs) | `node --test docs/envelope/validate.test.mjs` (examples pass; 13 malformed cases are rejected) |

## Rules

1. **Additive only.** The envelope never replaces, renames or reorders a service's own fields. A buyer who ignores
   it sees exactly today's response.
2. **Derived, never authoritative.** Every envelope value is copied or mapped from the service's own response. Where
   the two could disagree, the service's own field wins, and the envelope carries `native_status` so nothing is lost
   in normalization.
3. **Unknown is null, never a guess.** A service that cannot know `source_tier`, `retrieved_at` or `confidence`
   sets null. `gaps: []` means none detected, not none possible.
4. **Rights travel with evidence.** `rights_status` uses the TCS-6 vocabulary. Raw vendor payloads never go into
   `evidence`; only the citation does (`internal_only` sources are omitted from the envelope entirely).
5. **Bounded size.** At most 50 `evidence` items and 50 `links`; longer lists go behind `evidence_more`.
6. **No secrets, no personal data.** Same secret scan as every release.

## Vocabulary

**Subject IDs** are `<kind>:<namespace>:<value>`:

| kind | namespace and example | Used by |
|---|---|---|
| `protocol` | `tcs6` → `protocol:tcs6:aave` (the TCS-6 registry `entity_id`) | treasury-capital-score, capital-integrity-dossier |
| `company` | `sec-cik` → `company:sec-cik:0000070858` (canonical, owner 2026-11-11); fallback `pmic` → `company:pmic:bac` when there is no CIK | pmic-company-signals, pmic-pharma-signals |
| `drug` | `pmic` → `drug:pmic:<entity_id>` (an FDA application number when the hub has one: `drug:fda-appl:NDA021457`) | pmic-pharma-signals |
| `brand` | `bp` → `brand:bp:<brand_id>` | brand-protection |
| `domain` | `dns` → `domain:dns:example.com` (lowercase, IDNA/punycode) | agent-trust, brand-protection |
| `wallet` | `caip10` → `wallet:caip10:eip155:1:0xabc…` ([CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md)) | agent-trust, pmic-crypto-signals, TCS-6 links |
| `market` | `polymarket` → `market:polymarket:<slug>` | prediction-market-intel |
| `topic` | `pmic-<pack>` → `topic:pmic-macro:inflation` | pmic-macro, pmic-public-sector, pmic-crypto |
| `jurisdiction` | `iso3166` → `jurisdiction:iso3166:us` | pmic-macro (`countries`), pmic-public-sector |
| `network_actor` | `pokt` → `network_actor:pokt:pokt1…` | pokt-network-intel `supplier-trust` |

**Links** (`subject.links[]`) are what makes this one layer instead of ten services: a TCS-6 protocol links its
treasury wallets (`treasury_wallet` → agent-trust can answer about them), a brand links its official domains
(`official_domain` → agent-trust domain trust), a lookalike domain links back to the brand it imitates
(`lookalike_of`).

**Assessment status** is normalized; the service's own value is kept in `native_status`:

| `status` | TCS-6 `overall_score.status` | PMIC `status` | Others |
|---|---|---|---|
| `ok` | `eligible` | `ok` | a score was produced |
| `provisional` | `provisional` | — | — |
| `insufficient_data` | `insufficient_data` | `insufficient_data` | too little evidence to score |
| `ineligible` | `ineligible` | — | — |
| `not_scored` | — | — | the route returns facts, not a judgement (lists, evidence lookups, brand findings) |

**Evidence** and **gaps** reuse the TCS-6 `source` and `data_gap` definitions field for field (TCS-6 already has the
strictest model; the others map into it). **attestation_ref** reuses the dossier's `AttestationRef`
(`evidence_manifest_hash` is renamed `payload_hash` so TCS-6's `payload_hash` maps without loss).

## Per-service mapping

Phase in brackets: the [rollout](#rollout) step in which the service gets the field.

### capital-integrity-dossier [pilot]
All routes. Best fit: it already has `entity {entity_id, name}` and `attestation_ref`.
- `subject`: `protocol:tcs6:<entity.entity_id>`, name `entity.name`. Links: the registry wallets of the entity (`treasury_wallet`).
- `as_of`: `as_of`. `generated_at`: response time.
- `assessment`: `not_scored` for `plan`, `section`, `entities` and `availability` (`available_share_pct` is a share, not a score).
- `evidence`: from the snapshot report's `source_manifest` (first 50); `evidence_more` → `/v1/dossier/section`.
- `gaps`: `availability.not_valued[]` → `{field: <asset>, reason: "not valued", impact: "excluded from buckets"}`.
- `attestation_ref`: `attestation_ref` (rename `evidence_manifest_hash` → `payload_hash`).

### pmic-company-signals, pmic-pharma-signals [phase 2]
`/v1/brief`, `/v1/overview`, `/v1/events`.
- `subject`: from `entity`. Company → `company:sec-cik:<cik>` when the hub row has a CIK, else `company:pmic:<entity_id>`; identifiers `ticker`, `pmic_entity_id`, `industry`. Pharma drugs → `drug:…`, manufacturers → `company:…`.
- `as_of`: the newest `inputs[].value.as_of`.
- `assessment`: `status`/`score`/`label`/`confidence` copied; `scale.higher_is` from the vertical's scoring direction (stored once per vertical in the pack config); `coverage_pct` from `coverage` when numeric.
- `evidence`: one item per `inputs[]`: `series_id` → `source_ref`, `label` → `title`, `source` → `publisher` (display name from the hub's source table), `citation_url` → `url`, `value.as_of` → `observation_time`, `retrieved_at` null until the hub exposes fetch times, `source_tier` from a per-source table (SEC, FDA, EPA = 1), `rights_status` from the same table. Plus `citations[]` not already covered.
- `gaps`: each `inputs[].risk_flags` entry (`single_source`, `stale`, …) → one gap.
- `attestation_ref`: null until pmic-hub signs series (the current `attestation` is an unsigned statement and stays where it is).

### pmic-macro-signals, pmic-public-sector-signals, pmic-crypto-signals [phase 2]
Same as above except the subject: `topic:pmic-<pack>:<vertical>`, with `jurisdiction:iso3166:<cc>` links for each
requested country. pmic-crypto `/v1/tools/address` → `wallet:caip10:…`, `not_scored`.

### brand-protection [phase 2]
- `/v1/brand/scan`, `/v1/brand/lookalikes`: `subject` `brand:bp:<brand_id>`, links `official_domain` per `official_domains[]`; `as_of`; `not_scored`, label `"<findings_total> findings"`; `evidence: []` and `evidence_more` → `/v1/brand/evidence` with `count = findings_total`; `coverage` → gaps where a check did not run.
- `/v1/brand/evidence`: `subject` `domain:dns:<domain>` with `lookalike_of` the brand; `as_of` `collected_at`; evidence from `sources[]` (RDAP, DNS, CT log, homepage fetch; tier 1 for RDAP/CT, 2 for homepage).

### agent-trust [phase 2, needs source capture]
- `domain-trust`, `brand-verify`, `seller-trust`: `subject` `domain:dns:<domain or hostname>`; score copied, scale 0–100 `better`.
- `sanctions-check`, `reputation`: `subject` `wallet:caip10:<caip2 chain>:<address>`; `reputation_score` (scale "0-100, higher is more trustworthy"); `coverage` → `coverage_pct` where numeric.
- **The real work:** today agent-trust returns `reasons[]` as plain strings, not sources. The routes already fetch RDAP, DNS, TLS certificates, Blockscout and the sanctions list; phase 2 records each fetch as an evidence item (publisher, URL, retrieved_at). Until then `evidence: []` plus one gap `{field: "evidence", reason: "sources not yet itemized", impact: "reasons only"}`.

### treasury-capital-score [not planned: the dossier carries protocols (owner, 2026-11-11)]
- `subject`: `protocol:tcs6:<entity.entity_id>`; identifiers `entity_type`, `peer_cohort`; links: registry wallets.
- `assessment`: status per the table; `score`, `coverage_pct` from `overall_score`; `label` `decision_band`; `confidence {score, label}` from `confidence` (0–100 already).
- `evidence`: `source_manifest` (first 50, `internal_only` dropped); `gaps`: `data_gaps`; `attestation_ref`: from `attestation` (`payload_hash`, `verification_status`).
- **Blocker:** the frozen v1 paid response schema (`methodology/tcs6_paid_response_schema_v1.json`) has
  `additionalProperties: false` at the top level, so adding `verified` is a contract change: a schema revision,
  golden-test update and owner Beta review (CLAUDE_1 §9). **Owner decision 2026-11-11: not now.** The dossier's
  `verified` block describes the same protocols with the same subject IDs. The mapping below is kept for later.

### prediction-market-intel, pokt-network-intel [optional, phase 3]
Outside the PMIC/trust/treasury/brand scope but cheap once the library exists: `market:polymarket:<slug>`;
`network_actor:pokt:<operator_id>` for `supplier-trust`, `topic:pokt:network` for the rest.

## Rollout

Every step follows the owner rules: Beta first, an owner-reviewed Beta response, then MainNet through PSM.

1. **Spec and mapping** (this folder). No deploys.
2. **Pilot: capital-integrity-dossier.** Add a small shared helper (`docs/envelope/` stays the spec; each service
   vendors a ~100-line `envelope.js` like it vendors other shared code) → minor version bump → `openapi.json` gains
   an optional `verified` property → Beta via PSM → relay test → owner review → MainNet. One card update in PSM
   (spec hash changes).
3. **Phase 2:** the five PMIC packs (one shared change in the pack template), brand-protection, agent-trust
   (with source capture). Each service Beta → review → MainNet; about 7 card updates.
4. **Phase 3:** the optional services, and cross-service link checks (every `links[].service` must answer for that
   `id`). TCS-6 keeps its frozen v1 contract; protocols get the shared block through the dossier.

**PNF / portal:** the gateway outputSchemas built from our portal descriptors do not set
`additionalProperties: false` (checked 2026-11-11 on all PMIC packs, TCS-6, dossier, brand-protection and
prediction-market-intel), so an extra optional field does not break them. Send PNF a short note with each release
anyway, as for the 2026-10 typed-fields change.

## Owner decisions (2026-11-11)

1. **Field name:** `verified`. (The schema keeps its id, `pocket-agentic-envelope/1`; "envelope" is only the spec's name.)
2. **TCS-6:** no contract revision for now. Protocols get the `verified` block through capital-integrity-dossier.
3. **Company IDs:** SEC CIK is canonical (`company:sec-cik:`), with `company:pmic:` for companies without one.
