// Writes the marketplace files for every bundle from bundles/<service_id>.json:
//   ops/<service_id>/card.json               Pocket service card (registered on chain via PSM)
//   ops/<service_id>/portal-descriptor.json  Agentic Portal listing (agent.pocket.network)
//   ops/<service_id>/sage-service.yaml       SAGE gateway entry (send to the Pocket partner channel)
//   ops/<service_id>/openapi.json            request and response shapes for agents
//   ops/pocket-health-checks-entry.yaml      entries for pocket-network-resources/pocket-health-checks.yaml
//
//   node pmic/packs/ops/build-listings.js
// Re-run after editing a bundle. registrationTx comes from REGISTRATION_TX below (placeholder until registered).
"use strict";

// MainNet registration txs (2026-10-04, 1,000 POKT each).
const REGISTRATION_TX = {
  "pmic-macro-signals": "13C220122C7865E33430599E3EFCDE8CE1B76784A1CBCB5BC8915F8BF53B568C",
  "pmic-company-signals": "76013FFEACCA53888EE67ACD08C2D26B4BA08CA1C649A0945975C8A2BD2F074F",
  "pmic-pharma-signals": "F5ABC787554042422697E628E834592EA280E2D416B41B3794A1B440F276667E",
  "pmic-crypto-signals": "689195FDE0976ECDCDAAC0A81D86BD586F07621339851790F5EF12B81AF4745D"
};

// Example requests from live MainNet relays, and the shape of the answer as it really comes back
// (trimmed to a few fields, but every field keeps its real type). Gateways may derive a response
// schema from this example, so a summary that turns an object into a string breaks real answers.
const SAMPLES = {
  "pmic-macro-signals": {
    request: { vertical: "inflation" },
    response: { service: "pmic-macro-signals", vertical: "inflation", title: "Inflation pressure", status: "ok", score: 59, label: "steady", trend: "steady", trend_basis: "score_history", summary: "Inflation pressure: 59/100, steady.", drivers: [{ series_id: "fred:CPILFESL", label: "Core CPI", score: 94 }], risk_flags: ["mixed_signals", "extreme_level"], confidence: { score: 93, label: "high" }, inputs: [], watch: [], citations: [{ label: "Core CPI", url: "https://fred.stlouisfed.org/series/CPILFESL" }] },
  },
  "pmic-company-signals": {
    request: { vertical: "filing-risk", entity_id: "nvda" },
    response: { service: "pmic-company-signals", vertical: "filing-risk", title: "Filing risk", entity: { entity_id: "nvda", name: "NVIDIA" }, horizon: "365d", status: "ok", score: 45, label: "active", summary: "Filing risk for NVIDIA: 45/100, active.", counts: { high: 0, medium: 6, other_8k: 7 }, drivers: [], risk_flags: [], confidence: { score: 90, label: "high" }, watch: [], citations: [{ label: "8-K", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=8-K" }] },
  },
  "pmic-pharma-signals": {
    request: { vertical: "company-safety", entity_id: "lly", horizon: "365d" },
    response: { service: "pmic-pharma-signals", vertical: "company-safety", title: "Company drug safety", entity: { entity_id: "lly", name: "Eli Lilly and Co." }, horizon: "365d", status: "ok", score: 52, label: "normal", trend: "steady", trend_basis: "input_trends", summary: "Company drug safety for Eli Lilly and Co.: 52/100, normal.", drivers: [], risk_flags: [], confidence: { score: 88, label: "high" }, inputs: [], watch: [], recent_events: [], citations: [{ label: "FAERS adverse event reports", url: "https://api.fda.gov/drug/event.json" }] },
  },
};

// The answer to POST /v1/brief, as JSON Schema both the openapi spec and the portal descriptor carry.
// Fields that can be null carry no type: OpenAPI 3.0's "nullable" is ignored by plain JSON Schema
// validators (a gateway refused an insufficient_data brief with score null for it).
const BRIEF = {
  type: "object",
  properties: {
    service: { type: "string" }, pack_version: { type: "string" }, vertical: { type: "string" }, title: { type: "string" }, question: { type: "string" },
    entity: { description: "The company ({entity_id, name, ...}) on company briefs; absent otherwise." },
    horizon: { type: "string" }, status: { type: "string", enum: ["ok", "insufficient_data"] },
    score: { type: ["integer", "null"], minimum: 0, maximum: 100, description: "Integer 0-100, or null when status is insufficient_data." },
    label: { type: ["string", "null"], description: "The vertical's label for the score, or null with no score." }, trend: { type: "string" },
    trend_basis: { type: ["string", "null"], description: "score_history, input_trends, or null when there is no trend." }, summary: { type: "string" },
    drivers: { type: "array", items: { type: "object" } }, risk_flags: { type: "array", items: { type: "string" } },
    confidence: { type: "object", properties: { score: { type: "integer" }, label: { type: "string" } } },
    inputs: { type: "array", items: { type: "object" } }, watch: { type: "array", items: { type: "object" } },
    recent_events: { type: "array", items: { type: "object" } },
    citations: { type: "array", items: { type: "object", properties: { url: { type: "string" }, label: { type: "string" } } } },
  },
  required: ["service", "vertical", "status", "summary"],
};

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REPO = "https://github.com/organiccryptoyyc/pocket-agentic-services";
const RAW = "https://raw.githubusercontent.com/organiccryptoyyc/pocket-agentic-services/main/pmic/packs";
const SUPPLIER = "pokt1a0e9xlhmrpsw44upzmxqj7ct6eh7enqr7tzysx";
const OWNER = "pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw";
const ENDPOINT = "https://agentic.organiccryptoyyc.com";
const CU = 100000;

const needsEntity = (v) => v.kind === "entity_composite" || v.kind === "entity_events" || v.kind === "peer_table";

function routesOf(b) {
  const r = ["POST /v1/verticals", "POST /v1/brief", "POST /v1/overview", "POST /v1/signals", "POST /v1/signal", "POST /v1/explain", "POST /v1/catalog"];
  if (b.events_scope) r.push("POST /v1/events");
  if ((b.extra_routes || []).includes("inflation_adjust")) r.push("POST /v1/inflation/adjust");
  if ((b.extra_routes || []).includes("crypto_tools")) r.push("POST /v1/tools/address", "POST /v1/tools/units");
  return r;
}

// Without a live capture, an example that shows the answer's shape (types only, no invented numbers).
function shapeOnly(b) {
  const v = b.verticals[0];
  return { service: b.service_id, vertical: v.id, title: v.title, status: "ok", summary: `${v.title}: score/100 and label, with the inputs that drive it.`, drivers: [], risk_flags: [], confidence: { score: 0, label: "low" }, inputs: [], watch: [], citations: [] };
}

function example(b) {
  const v = b.verticals[0];
  return { vertical: v.id, ...(needsEntity(v) ? { entity_id: b.entities[0] } : {}) };
}

// The card description is capped at 2,048 characters on chain. Verticals are listed with their
// questions when that fits, and by id only when it does not (POST /v1/verticals has the questions).
const CARD_DESCRIPTION_MAX = 2048;

function cardDescription(b) {
  const text = (verts) => `${b.description} POST /v1/brief {vertical${b.entities ? ", entity_id" : ""}} returns one scored brief; POST /v1/overview returns every brief at once; POST /v1/verticals lists them. Verticals: ${verts}. Raw scored series: /v1/signals, /v1/signal, /v1/explain, /v1/catalog${b.events_scope ? ", /v1/events" : ""}. Every response is a single JSON object. Research signal, not investment advice.`;
  const long = text(b.verticals.map((v) => `${v.id} (${v.question})`).join("; "));
  if (long.length <= CARD_DESCRIPTION_MAX) return long;
  const short = text(b.verticals.map((v) => v.id).join(", "));
  if (short.length > CARD_DESCRIPTION_MAX) throw new Error(`${b.service_id}: card description is ${short.length} characters, over ${CARD_DESCRIPTION_MAX}`);
  return short;
}

function card(b) {
  return {
    schema: "pocket-service-card/v1",
    description: cardDescription(b),
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
      ...BRIEF,
      description: "The answer to POST /v1/brief. score, label and trend_basis are null on insufficient_data briefs; entity is an object on company briefs. Errors return {error: {code, message}} with HTTP 400; other routes return their own JSON objects (see the openapi spec).",
    },
    methods,
    example: { method: "POST", path: "/v1/brief", request: SAMPLES[b.service_id] ? SAMPLES[b.service_id].request : example(b), responseSummary: SAMPLES[b.service_id] ? SAMPLES[b.service_id].response : shapeOnly(b) },
    pocket: {
      network: "mainnet",
      serviceId: b.service_id,
      computeUnitsPerRelay: CU,
      supplierOperator: SUPPLIER,
      supplierEndpoint: ENDPOINT,
      owner: OWNER,
      registrationTx: REGISTRATION_TX[b.service_id] || "{{REGISTRATION_TX}}",
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
          - name: verticals
            type: rest
            method: POST
            path: /v1/verticals
            body: '{}'
            expected_status_code: 200
            expected_response_contains: '"service":"${b.service_id}"'
            reputation_signal: major_error
            timeout: 5s
        # No sync_check / sync_allowance: not a blockchain service.
`;
}

// OpenAPI 3.0.3 has no type lists: ["integer", "null"] becomes {type: "integer", nullable: true}.
// The portal descriptor keeps plain JSON Schema type lists (what PNF validates against).
function oas30(schema) {
  if (Array.isArray(schema)) return schema.map(oas30);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "type" ? v : oas30(v);
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    out.type = types.length === 1 ? types[0] : types;
    if (schema.type.includes("null")) out.nullable = true;
  }
  return out;
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
  if ((b.extra_routes || []).includes("crypto_tools")) {
    paths["/v1/tools/address"] = { post: { summary: "Check an address: EVM (EIP-55 checksum), Pocket/Cosmos/Bitcoin bech32, Bitcoin and Tron base58check, Solana. No network calls.", requestBody: body({ address: { type: "string" } }, ["address"]), responses: { 200: ok("Object"), 400: err } } };
    paths["/v1/tools/units"] = { post: { summary: "Convert units of one asset exactly (wei/gwei/eth, sat/btc, lamport/sol, upokt/pokt, sun/trx), or any token with 'decimals' between 'raw' and 'token'.", requestBody: body({ amount: { type: "string" }, from: { type: "string" }, to: { type: "string" }, decimals: { type: "integer" } }, ["amount", "from", "to"]), responses: { 200: ok("Object"), 400: err } } };
  }
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
        Brief: oas30(BRIEF),
      },
    },
  };
}

function healthEntry(b) {
  return `- service_id: ${b.service_id}
  # ${b.display_name}: an agentic REST service (not a blockchain), so no sync_check or
  # sync_allowance. Identity, readiness and one functional check, matching the service card.
  check_interval: 30s
  enabled: true
  checks:
    - name: version
      type: rest
      method: GET
      path: /v1/version
      expected_status_code: 200
      expected_response_contains: '"${b.service_id}"'
      timeout: 5s
      reputation_signal: critical_error
    - name: health
      type: rest
      method: GET
      path: /v1/health
      expected_status_code: 200
      expected_response_contains: '"status":"ok"'
      timeout: 5s
      reputation_signal: major_error
    - name: verticals
      type: rest
      method: POST
      path: /v1/verticals
      body: '{}'
      expected_status_code: 200
      expected_response_contains: '"service":"${b.service_id}"'
      timeout: 5s
      reputation_signal: major_error
`;
}

const entries = [];
for (const f of fs.readdirSync(path.join(ROOT, "bundles")).filter((x) => x.endsWith(".json")).sort()) {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, "bundles", f), "utf8"));
  entries.push(healthEntry(b));
  const dir = path.join(ROOT, "ops", b.service_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "card.json"), JSON.stringify(card(b), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "portal-descriptor.json"), JSON.stringify(portal(b), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "sage-service.yaml"), sage(b));
  fs.writeFileSync(path.join(dir, "openapi.json"), JSON.stringify(openapi(b), null, 2) + "\n");
  const size = Buffer.byteLength(JSON.stringify(card(b)));
  console.log(JSON.stringify({ service_id: b.service_id, card_bytes: size, routes: routesOf(b).length }));
}
fs.writeFileSync(path.join(ROOT, "ops", "pocket-health-checks-entry.yaml"), entries.join(""));
