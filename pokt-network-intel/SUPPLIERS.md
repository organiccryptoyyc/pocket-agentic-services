# pokt-network-intel: running and calling it

This page is for any supplier who wants to serve the Pocket service `pokt-network-intel`, and for anyone calling it.
It covers one release: `1.1.1` (tag `pokt-network-intel-v1.1.1`). **Run 1.1.1 or later:** in November 2026 Pocket's indexer changed its GraphQL schema, and on 1.1.0 the suppliers, throughput, applications, service-demand and supplier-trust routes fail. Pocket services are permissionless. You
don't need anyone's permission to stake a supplier for this service.

The service is a small read-only API over Pocket Network's own chain state: network pulse, governance and
tokenomics parameters, validators, suppliers, applications, relay throughput, per-service supply and demand,
and a trust score for one supplier. It has no npm dependencies, no keys and no state. It needs about 1 GB RAM
and outbound HTTPS only.

## 1. Run it

**Image:** `ghcr.io/organiccryptoyyc/pokt-network-intel:1.1.1` (linux/amd64 and linux/arm64). It listens on
port `8080`.

**One container per network.** The backend reads one network's chain, chosen at startup. If you supply both
MainNet and Beta, run two containers with different `POCKET_NETWORK`. Don't point both relayers at one
container: it would serve the wrong network's data on one of them, and the card's network probe would fail.

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_NETWORK` | `main` | `main` or `beta`. **Must match the network your supplier is staked on.** |
| `PORT` | `8080` | Listen port. |
| `POCKET_FETCH_TIMEOUT_MS` | `8000` | Timeout for each upstream call (one retry). |
| `POCKET_MAX_STALE_MS` | `3600000` | Longest a cached value is served after a failed refresh (see section 4). |
| `POCKET_LCD_URL` | Pocket's public LCD for the network | Your own Cosmos LCD, if you run a node. |
| `POCKET_RPC_URL` | Pocket's public Tendermint RPC for the network | Your own RPC. |
| `POCKET_INDEXER_URL` | Pocket's public GraphQL indexer for the network | Your own indexer (Pocketdex/PostGraphile). It must expose the report functions the public indexer has had since November 2026 (`getSupplierFleetList`, `getServiceSummaryList`, `getBlockStatsList`, and so on). |

Public defaults: MainNet `https://sauron-api.infra.pocket.network`, `https://sauron-rpc.infra.pocket.network`,
`https://data.pocket.network/graphql`. Beta: the same hosts with `.beta.` (`sauron-api.beta.infra.pocket.network`,
`sauron-rpc.beta.infra.pocket.network`, `data.beta.pocket.network/graphql`).

Plain Docker:

```
docker run -d --name pokt-network-intel-main --restart unless-stopped \
  -e POCKET_NETWORK=main --network <your-relayminer-network> \
  ghcr.io/organiccryptoyyc/pokt-network-intel:1.1.1
```

Compose: [`examples/docker-compose.yaml`](examples/docker-compose.yaml) runs one container per network.
With the Pocket Service Manager: `node ops/package-psm.js main` (or `beta`) builds a deployment folder.

## 2. Connect it

The backend must be reachable from your relay miner over your Docker network (no published port is needed).
Add one entry per network, in that network's relay miner config, pointing at that network's container.

`pocket-relay-miner` (`relayer-config.yaml`, the layout the Pocket Service Manager uses), under `services:`:

```yaml
  pokt-network-intel:
    default_backend: rest
    backends:
      rest:
        url: "http://pokt-network-intel-main:8080"   # the container for THIS network
        health_check:
          endpoint: "/v1/health"
          interval_seconds: 10
          timeout_seconds: 5
```

poktroll's classic RelayMiner, under `suppliers:`:

```yaml
  - service_id: pokt-network-intel
    listen_url: http://0.0.0.0:8545          # your relayer's existing listener
    service_config:
      backend_url: http://pokt-network-intel-main:8080
```

Then stake (or update) your supplier for service `pokt-network-intel` with `rpc_type: REST` on your public
relay endpoint.

Use the backend with `POCKET_NETWORK=beta` in the Beta relayer's entry. Gateway operators configure the
service as `passthrough` with `rpc_types: ["rest"]`; a SAGE entry is in
[`ops/sage-service.yaml`](ops/sage-service.yaml). Allow a relay timeout of about 20 s.

## 3. Verify it

These are the card's four healthchecks. Run them from a container on the same Docker network (for example
`docker run --rm --network <net> curlimages/curl ...`).

```
curl -s http://pokt-network-intel-main:8080/v1/version
# {"service":"pokt-network-intel","version":"1.1.1","network":"main","max_stale_ms":3600000}
#   probes: $.service is "pokt-network-intel", and $.network is "main" (MainNet card) or "beta" (Beta card)

curl -s http://pokt-network-intel-main:8080/v1/health
# {"status":"ok"}

curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://pokt-network-intel-main:8080/v1/tokenomics
# {"service":"pokt-network-intel","network":"main",...,"mint_ratio":<number>,...}
#   probe: $.mint_ratio is a number (a live governance parameter, so the value itself is not fixed)
```

On Beta, the same requests against the Beta container must show `"network":"beta"`. A Beta backend left on
the default (`main`) fails the network probe.

## 4. Call it

All calls are `POST` with a JSON body (send `{}` when there are no fields). Inputs are read from the body
only; query parameters and headers are ignored. The full contract is the OpenAPI document:
[`openapi.json`](https://raw.githubusercontent.com/organiccryptoyyc/pocket-agentic-services/pokt-network-intel-v1.1.1/pokt-network-intel/openapi.json)
(sha256 is in the service card).

| Endpoint | Body fields | Returns |
|---|---|---|
| `/v1/pulse` | none | Chain tip, indexer health, staked-actor counts |
| `/v1/tokenomics` | none | Live tokenomics and shared governance parameters |
| `/v1/validators` | `status` (`bonded`, `unbonding`, `unbonded`; default `bonded`), `limit` 1-100 (25), `offset` | Validator set with total bonded voting power |
| `/v1/suppliers` | `service_id` (optional), `limit` 1-100 (25), `offset` | Staked suppliers, network-wide by stake or for one service |
| `/v1/throughput` | `window_hours` 1-168 (24) | Claimed vs difficulty-estimated relays and compute units |
| `/v1/applications` | `service_id` (optional), `limit` 1-100 (25), `offset` | Staked applications, network-wide or for one service |
| `/v1/service-demand` | `service_ids` (1-20 strings; omit for the first 30 services) | Active suppliers and applications per service |
| `/v1/supplier-trust` | `operator_id` (required, `pokt1...`) | A 0-100 trust score for one supplier, with its inputs |

**Response envelope.** Every successful response is one JSON object that starts with:

```json
{ "service": "pokt-network-intel", "network": "main", "fetched_at": "2026-11-01T23:17:11.082Z",
  "cache": { "stale": false, "age_ms": 0 } }
```

followed by the endpoint's own fields.

- `cache.age_ms`: how old the served value is. Values are cached in memory: pulse 15 s; suppliers and
  applications 30 s; validators, throughput, service-demand and supplier-trust 60 s; tokenomics 1 h.
- `cache.stale`: `true` when a live refresh just failed and the last good value was served instead. That
  happens only while the value is younger than `POCKET_MAX_STALE_MS` (1 hour by default); after that the call
  returns `422`.

Because of caching, two suppliers can return different bytes for the same request; the card declares
`results: "variable"`.

**Errors** are always JSON `{"error":{"code","message"}}`, never 5xx or HTML:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_json`, `read_error` | The body is not valid JSON or could not be read |
| 404 | `not_found` | Unknown route, or `supplier-trust` for an operator that isn't staked |
| 413 | `payload_too_large` | Body over 1 MiB |
| 422 | `invalid_input` | A field is out of range or the wrong type |
| 422 | `upstream_unavailable` | The upstream failed and there is no cached value young enough to serve |

## 5. Support

- **Versions:** semantic versioning. Each release is a git tag `pokt-network-intel-v<version>` and an image
  with the same version; a tag never moves. The on-chain card names the exact image and pins the OpenAPI
  document by tag and sha256. Breaking changes to a response shape get a new major version.
- **New releases:** watch the repository's releases and tags on GitHub
  (`organiccryptoyyc/pocket-agentic-services`); the card's `updated` date and image tag change with each one.
- **Problems:** open an issue at https://github.com/organiccryptoyyc/pocket-agentic-services/issues with
  `pokt-network-intel` in the title.
- **License:** Apache License 2.0 (`LICENSE` at the repository root).
