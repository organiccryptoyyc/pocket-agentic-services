// Writes the marketplace files for every bundle from bundles/<service_id>.json:
//   ops/<service_id>/card.json               Pocket service card (registered on chain via PSM)
//   ops/<service_id>/portal-descriptor.json  Agentic Portal listing (agent.pocket.network)
//   ops/<service_id>/sage-service.yaml       SAGE gateway entry (send to the Pocket partner channel)
//   ops/<service_id>/openapi.json            request and response shapes for agents
//
//   node pmic/packs/ops/build-listings.js
// Re-run after editing a bundle. registrationTx stays a placeholder until PSM registers the service.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REPO = "https://github.com/organiccryptoyyc/pocket-agentic-services";
const RAW = "https://raw.githubusercontent.com/organiccryptoyyc/pocket-agentic-services/main/pmic/packs";
const SUPPLIER = "pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx";
const OWNER = "pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw";
const ENDPOINT = "https://agentic.organiccryptoyyc.com";
const CU = 100000;

const needsEntity = (v) => v.kind === "entity_composite" || v.kind === "entity_events";

function routesOf(b) {
  const r = ["POST /v1/verticals", "POST /v1/brief", "POST /v1/overview", "POST /v1/signals", "POST /v1/signal", "POST /v1/explain", "POST /v1/catalog"];
  if (b.events_scope) r.push("POST /v1/events");
  if ((b.extra_routes || []).includes("inflation_adjust")) r.push("POST /v1/inflation/adjust");
  return r;
}

function example(b) {
  const v = b.verticals[0];
  return { vertical: v.id, ...(needsEntity(v) ? { entity_id: b.entities[0] } : {}) };
}

function card(b) {
  const verts = b.verticals.map((v) => `${v.id} (${v.question})`).join("; ");
  return {
    schema: "pocket-service-card/v1",
    description: `${b.description} POST /v1/brief {vertical${b.entities ? ", entity_id" : ""}} returns one scored brief; POST /v1/overview returns every brief at once; POST /v1/verticals lists them. Verticals: ${verts}. Raw scored series: /v1/signals, /v1/signal, /v1/explain, /v1/catalog${b.events_scope ? ", /v1/events" : ""}. Every response is a single JSON object. Research signal, not investment advice.`,
    rpc_types: [{ type: "REST", intent: "expected", backend_hint: `${b.service_id}-backend on :8080; mount at /`, notes: `${routesOf(b).join(", ")}; GET /v1/version, /v1/health. JSON body only. Bad input returns 400 + JSON.` }],
    apis: [`${b.service_id}-briefs`],
    specs: [
      { kind: "openapi", api: `${b.service_id}-briefs`, url: `${RAW}/ops/${b.service_id}/openapi.json` },
      { kind: "docs", api: `${b.service_id}-briefs`, url: `${RAW}/README.md`, notes: "How briefs are scored." },
    ],
    access: "public",
    results: "variable",
    serving: {
      backend: "Node.js HTTP server (zero npm dependencies) behind a RelayMiner at http://<container>:8080. No caller auth. Answers come from a private hub refreshed by a scheduled collector of official public data; 5-minute cache.",
      implementations: [`${b.service_id} >= 0.1`],
      min_disk_gb: 1,
      min_ram_gb: 1,
      healthcheck: [
        { rpc_type: "REST", request: { path: "/v1/version", method: "GET" }, expect: { json_path: "$.service", matches: `^${b.service_id}$` }, notes: "Identity probe." },
        { rpc_type: "REST", request: { path: "/v1/health", method: "GET" }, expect: { json_path: "$.status", matches: "^ok$" }, notes: "Readiness probe." },
        { rpc_type: "REST", request: { path: "/v1/verticals", method: "POST", body: {} }, expect: { json_path: "$.service", matches: `^${b.service_id}$` }, notes: "Functional probe." },
      ],
      notes: "Gateway operators: configure as type passthrough with rpc_types [\"rest\"].",
    },
    docs: `${REPO}/blob/main/pmic/packs/README.md`,
    updated: new Date().toISOString().slice(0, 10),
  };
}

function portal(b) {
  const methods = { "GET /v1/health": "read", "GET /v1/version": "read" };
  for (const r of routesOf(b)) methods[r] = "read";
  return {
    serviceId: b.service_id,
    displayName: b.display_name,
    description: `${b.description} POST /v1/brief with a small JSON body for one scored, cited brief; POST /v1/overview for all of them at once. Results vary as public data updates (5-minute cache). Research signal, not investment advice. Pay per request in USDC; no account, no API key.`,
    category: b.category,
    protocols: ["rest"],
    inputSchema: {
      type: "object",
      description: "Body for POST /v1/brief (other routes take similar small bodies).",
      properties: {
        vertical: { type: "string", enum: b.verticals.map((v) => v.id), description: "Which brief. POST /v1/verticals describes each." },
        ...(b.entities ? { entity_id: { type: "string", enum: b.entities, description: `Company (lower-case ticker); required for ${b.verticals.filter(needsEntity).map((v) => v.id).join(", ")}.` } } : {}),
        horizon: { type: "string", enum: ["7d", "30d", "90d", "365d"], description: `Comparison window; default ${b.default_horizon}.` },
      },
      required: ["vertical"],
    },
    outputSchema: {
      type: "object",
      description: "{service, vertical, title, status, score (0-100), label, trend, trend_basis, summary, drivers[], risk_flags[], confidence{score,label}, coverage, inputs[], watch[], citations[{url}], method}. Errors return a JSON object with an error field (HTTP 400).",
    },
    methods,
    example: { method: "POST", path: "/v1/brief", request: example(b), responseSummary: { service: b.service_id, note: "Fill from a live MainNet capture." } },
    pocket: {
      network: "mainnet",
      serviceId: b.service_id,
      computeUnitsPerRelay: CU,
      supplierOperator: SUPPLIER,
      supplierEndpoint: ENDPOINT,
      owner: OWNER,
      registrationTx: "{{REGISTRATION_TX}}",
      healthChecks: [`GET /v1/version contains "service":"${b.service_id}"`, 'GET /v1/health contains "status":"ok"', `POST /v1/verticals {} contains "service":"${b.service_id}"`],
    },
  };
}

function sage(b) {
  return `# SAGE gateway configuration for ${b.service_id}. Send to the Pocket partner channel /
# portal@pokt.foundation. Gateways do NOT read the service card; without this entry SAGE refuses
# REST requests for the service and it is not discoverable on agent.pocket.network.
gateway_config:
  services:
    - id: ${b.service_id}
      type: passthrough
      rpc_types: ["rest"]
      timeout_config:
        relay_timeout: 15s        # relay path is a hub read behind a 5-minute cache
  active_health_checks:
    local:
      - service_id: ${b.service_id}
        enabled: true
        checks:
          - name: version
            type: rest
            method: GET
            path: /v1/version
            expected_status_code: 200
            reputation_signal: critical_error
            timeout: 5s
          - name: health
            type: rest
            method: GET
            path: /v1/health
            expected_status_code: 200
            reputation_signal: major_error
            timeout: 5s
        # No sync_check / sync_allowance: not a blockchain service.
`;
}

function openapi(b) {
  const err = { description: "Bad input: JSON object with error {code, message}.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  const ok = (ref) => ({ description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const body = (props, required = []) => ({ required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } });
  const H = { type: "string", enum: ["7d", "30d", "90d", "365d"] };
  const E = b.entities ? { entity_id: { type: "string", enum: b.entities } } : {};
  const paths = {
    "/v1/verticals": { post: { summary: "List the verticals this service sells.", requestBody: body({}), responses: { 200: ok("Object"), 400: err } } },
    "/v1/brief": { post: { summary: "One scored brief.", requestBody: body({ vertical: { type: "string", enum: b.verticals.map((v) => v.id) }, ...E, horizon: H, ...(b.verticals.some((v) => v.kind === "country_table") ? { countries: { type: "array", items: { type: "string" } } } : {}) }, ["vertical"]), responses: { 200: ok("Brief"), 400: err } } },
    "/v1/overview": { post: { summary: b.entities && b.verticals.every(needsEntity) ? "Every brief for one company." : "Every brief at once, compact.", requestBody: body({ ...E, horizon: H }), responses: { 200: ok("Object"), 400: err } } },
    "/v1/signals": { post: { summary: "Ranked scored series inside this service's scope.", requestBody: body({ source_id: { type: "string", enum: b.hub_scope.map((f) => f.source_id) }, horizon: H, sort: { type: "string", enum: ["composite", "change", "abs_change", "confidence", "deviation"] }, direction: { type: "string", enum: ["asc", "desc"] }, min_confidence: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 200 } }), responses: { 200: ok("Object"), 400: err } } },
    "/v1/signal": { post: { summary: "One scored series.", requestBody: body({ series_id: { type: "string" } }, ["series_id"]), responses: { 200: ok("Object"), 400: err } } },
    "/v1/explain": { post: { summary: "Why a series moved over the horizon.", requestBody: body({ series_id: { type: "string" }, horizon: H }, ["series_id"]), responses: { 200: ok("Object"), 400: err } } },
    "/v1/catalog": { post: { summary: "Series this service covers.", requestBody: body({ entity_id: { type: "string" }, q: { type: "string" } }), responses: { 200: ok("Object"), 400: err } } },
    "/v1/version": { get: { summary: "Service identity.", responses: { 200: ok("Object") } } },
    "/v1/health": { get: { summary: "Readiness.", responses: { 200: ok("Object") } } },
  };
  if (b.events_scope) paths["/v1/events"] = { post: { summary: "Dated events with source links.", requestBody: body({ ...E, event_type: { type: "string" }, severity: { type: "string", enum: ["low", "medium", "high"] }, since: { type: "string", format: "date" }, limit: { type: "integer" } }), responses: { 200: ok("Object"), 400: err } } };
  if ((b.extra_routes || []).includes("inflation_adjust")) paths["/v1/inflation/adjust"] = { post: { summary: "What an amount is worth in another month, by US CPI (months the hub holds).", requestBody: body({ amount: { type: "number" }, from: { type: "string", pattern: "^\\d{4}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}$" } }, ["amount", "from"]), responses: { 200: ok("Object"), 400: err } } };
  return {
    openapi: "3.0.3",
    info: { title: b.display_name, version: b.version, description: b.description },
    servers: [{ url: ENDPOINT }],
    paths,
    components: {
      schemas: {
        Object: { type: "object" },
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
        Brief: {
          type: "object",
          properties: {
            service: { type: "string" }, vertical: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["ok", "insufficient_data"] },
            score: { type: "integer", minimum: 0, maximum: 100, nullable: true }, label: { type: "string", nullable: true }, trend: { type: "string" },
            trend_basis: { type: "string", nullable: true, enum: ["score_history", "input_trends", null] }, summary: { type: "string" },
            drivers: { type: "array", items: { type: "object" } }, risk_flags: { type: "array", items: { type: "string" } },
            confidence: { type: "object", properties: { score: { type: "integer" }, label: { type: "string" } } },
            inputs: { type: "array", items: { type: "object" } }, watch: { type: "array", items: { type: "object" } },
            citations: { type: "array", items: { type: "object", properties: { url: { type: "string" }, label: { type: "string" } } } },
          },
        },
      },
    },
  };
}

for (const f of fs.readdirSync(path.join(ROOT, "bundles")).filter((x) => x.endsWith(".json"))) {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, "bundles", f), "utf8"));
  const dir = path.join(ROOT, "ops", b.service_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "card.json"), JSON.stringify(card(b), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "portal-descriptor.json"), JSON.stringify(portal(b), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "sage-service.yaml"), sage(b));
  fs.writeFileSync(path.join(dir, "openapi.json"), JSON.stringify(openapi(b), null, 2) + "\n");
  const size = Buffer.byteLength(JSON.stringify(card(b)));
  console.log(JSON.stringify({ service_id: b.service_id, card_bytes: size, routes: routesOf(b).length }));
}
