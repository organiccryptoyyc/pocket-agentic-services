# Service pack template

Starting point for each of the ~50 paid Pocket services that sit on the PMIC hub. A pack is a
`pack.json` (which slice of the catalog it covers) plus this `server.js`; it never fetches public
data itself.

## Make a pack

1. Copy this folder to `../../<service_id>/` (a top-level package, like every other service here).
2. Edit `pack.json`: `service_id`, `display_name`, `scope` (any of `category`, `industry`,
   `geography`, `entity_id`, `source_id`, `metric_name`), `events_scope`, `default_horizon`.
3. Fill the three files in `ops/` (replace every `{{...}}`): `card.template.json` → `card.json`,
   `sage-service.template.yaml` → `ops/sage-service.yaml`, `portal-descriptor.template.json` →
   `ops/portal-descriptor.json`. Check the service id is free on Beta and MainNet first.
4. Run against a hub: `PMIC_HUB_URL=http://localhost:8088 PMIC_API_TOKEN=... node server.js`.
5. Deploy on the `pocket-supplier` network next to `pmic-hub`, with the pack container as its own
   RelayMiner backend, and add it to the supplier's stake (same gated steps as TCS-6's RUNBOOK).

A pack that needs more than a filtered view (for example a composite across several series) adds
its own route in `server.js` built from hub answers, and keeps each underlying citation.

## Routes

`POST /v1/signals`, `/v1/signal`, `/v1/explain`, `/v1/events`, `/v1/catalog`, `GET /v1/version`,
`/v1/health`. Scope is merged last, so a caller can narrow a pack but never widen it; a
`series_id` outside the scope is a 400. Hub answers are cached for `cache_seconds` and the last
good answer is served (with `cache.stale: true`) if the hub is briefly unreachable.

`lib/http.js` and `lib/net.js` are vendored byte-for-byte from `prediction-market-intel`.
