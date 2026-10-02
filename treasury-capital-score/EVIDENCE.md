# Evidence bundle contract (Pi collector → Hetzner)

The `tcs6-pi-collector` pushes one bundle per entity to
`https://agentic.organiccryptoyyc.com/tcs6-ingest/ingest/evidence` (bearer token; PSM route, prefix stripped). Walk every `perimeter: include` row of `data/registry.json` for the entity. The pipeline turns bundles into reports;
it never fetches anything itself. Full worked example:
[`test/fixtures/evidence-example.json`](test/fixtures/evidence-example.json).

Raw vendor payloads may be forwarded here (internal infrastructure), but only
the fields below are read, and only derived aggregates leave in a paid report.

| Field | Required | Meaning |
|---|---|---|
| `entity_id` | yes | Registry id. Unknown ids are rejected. |
| `collected_at` | yes | RFC 3339. Becomes the report's `as_of`; price freshness (60 min) and holdings freshness (90 d) are measured from it. Bundles older than `TCS6_MAX_EVIDENCE_AGE_HOURS` (24) are skipped and the previous report is kept. |
| `holdings[]` | yes | One row per position. |
| `holdings[].asset_class` | yes | `cash_equivalent` · `fiat_stablecoin` · `major_crypto` · `liquid_alt` · `lp_position` · `native_token` · `locked_unverifiable` |
| `holdings[].control` | yes | `verified` (counts) or `unverified` (reported only, never counted). |
| `holdings[].quantity` + `prices[]` | on-chain | `prices[]`: `{source_ref, usd, observed_at}`. Two sources within 2% → consistent; further apart → the lower price is used and the conflict lowers confidence. |
| `holdings[].fair_value_usd` | off-chain | Disclosed balance (filing, report). Use instead of quantity/prices. |
| `holdings[].holdings_observed_at` | yes | When the balance was observed or disclosed. |
| `holdings[].bucket` | yes | `onchain` or `offchain`. |
| `holdings[].exposure_id` | no | Same id on several rows = one economic exposure, counted once. |
| `holdings[].haircut_flags[]` | no | Documented blueprint conditions (e.g. `depeg_history`, `thin_depth`, `unlock_pending`). `redemption_limits`, `legal_restriction`, `lockup`, `unlock_pending`, `depeg_active`, `thin_depth`, and `custody_concentration` also remove an asset from D2's liquid assets (HQLA). `no_orderly_exit` on a native token forces 100%. |
| `holdings[].correlation_group` | no | Shared tag for exposures that fall together (e.g. `eth` for ETH/WETH/stETH, `native` for the token and its LPs). Two or more non-cash rows in one group above 50% cap D4 at 60. |
| `holdings[].haircut_severity` | no | Explicit 0–1 position within the class range; overrides flags. |
| `holdings[].realization_path_evidenced` | for `locked_unverifiable` | Without it the haircut is 100%. |
| `obligations` | yes | `{visibility: adequate|partial|unknown, bounded, material_unresolved_claim, items[], source_refs}`. Items: `{type: debt|payable|pledge|distribution|contingency, usd, probability?, source_refs}`. |
| `cash_uses_12m` | for D2 | `{usd, status, source_refs}`. Missing scores D2 at the blueprint's 0 anchor. |
| `flows_12m` | for D5 | `{recurring_treasury_inflows_usd, controllable_cash_uses_usd, repeatable, status, source_refs}`. |
| `governance` | for D6 | `{control_known, contradictory, reconciliation_pct, disclosure_age_days, has_treasury_policy, multisig:{threshold,signers}, timelock, independent_attestation, governance_transparent, governance_opaque, status, source_refs}`. Read Safe thresholds live at collection time (Morpho's was 6-of-10 on 2026-10-01, ahead of its docs). |
| `sources[]` | yes | Manifest rows per the paid schema. `rights_status` `internal_only` / `pending_review` sources are dropped from the delivered report with every reference to them. |
| `risks[]`, `gaps[]`, `perimeter_gaps[]`, `penalties[]` | no | Curated text in schema shape (e.g. Aave's resolved 2026 Kelp DAO exposure as a survived stress event). `penalties[]`: `{id, points, reason}`, non-duplicative only. |
