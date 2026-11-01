// Writes the two service cards from one definition (PNF issue #6):
//   card.json       MainNet card (healthcheck pins $.network to main)
//   card.beta.json  Beta card    (healthcheck pins $.network to beta)
// The spec and docs URLs point at the release tag, and the spec carries the sha256 of openapi.json,
// so a card on chain never moves with main. Run after any change to openapi.json or the version:
//   node ops/build-card.js            (writes both)
//   node ops/build-card.js --check    (exits 1 if either file is out of date; used by npm test)
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { version } = require("../package.json");
const REPO = "organiccryptoyyc/pocket-agentic-services";
const TAG = `pokt-network-intel-v${version}`;
const IMAGE = `ghcr.io/organiccryptoyyc/pokt-network-intel:${version}`;
const UPDATED = "2026-11-01";

const spec = fs.readFileSync(path.join(ROOT, "openapi.json"));
const sha256 = crypto.createHash("sha256").update(spec).digest("hex");

function card(network) {
  return {
    schema: "pocket-service-card/v1",
    description: "POKT Network Intelligence: live Pocket Network (Shannon) chain state as JSON. Network pulse, governance and tokenomics parameters, validators, suppliers, applications, relay throughput, per-service supply and demand, and a 0-100 trust score for one supplier. Read live from Pocket's public indexer and LCD on each cache expiry; no hardcoded chain values. Endpoints and shapes: the OpenAPI spec in specs[].",
    rpc_types: [
      {
        type: "REST",
        intent: "expected",
        backend_hint: "pokt-network-intel on :8080; mount at /",
        notes: "POST /v1/{pulse,tokenomics,validators,suppliers,throughput,applications,service-demand,supplier-trust}; GET /v1/version, /v1/health. JSON body only; errors are 4xx JSON, never 5xx.",
      },
    ],
    apis: ["pokt-network-intel"],
    specs: [
      {
        kind: "openapi",
        api: "pokt-network-intel",
        url: `https://raw.githubusercontent.com/${REPO}/${TAG}/pokt-network-intel/openapi.json`,
        sha256,
      },
    ],
    access: "public",
    results: "variable",
    serving: {
      backend: `Image ${IMAGE} (Node, no dependencies, no keys, no state) behind a RelayMiner at http://<container>:8080. One container per network: set POCKET_NETWORK=${network}. Needs outbound HTTPS to Pocket's public indexer and LCD, or your own via POCKET_LCD_URL, POCKET_RPC_URL, POCKET_INDEXER_URL.`,
      implementations: [IMAGE],
      min_disk_gb: 1,
      min_ram_gb: 1,
      healthcheck: [
        { rpc_type: "REST", request: { path: "/v1/version", method: "GET" }, expect: { json_path: "$.service", matches: "^pokt-network-intel$" }, notes: "Identity probe." },
        { rpc_type: "REST", request: { path: "/v1/version", method: "GET" }, expect: { json_path: "$.network", matches: `^${network}$` }, notes: `Network probe: the backend must read ${network === "main" ? "MainNet" : "Beta"} (POCKET_NETWORK=${network}).` },
        { rpc_type: "REST", request: { path: "/v1/health", method: "GET" }, expect: { json_path: "$.status", matches: "^ok$" }, notes: "Readiness probe." },
        { rpc_type: "REST", request: { path: "/v1/tokenomics", method: "POST", body: {} }, expect: { json_path: "$.mint_ratio", matches: "^[0-9.]+$" }, notes: "Functional probe: reads a live governance parameter." },
      ],
      notes: "Responses are cached 15s to 1h per endpoint; a failed refresh serves the last good value tagged cache.stale for at most 1 hour (POCKET_MAX_STALE_MS), then returns 422. Gateways: passthrough, rpc_types [\"rest\"].",
    },
    docs: `https://github.com/${REPO}/blob/${TAG}/pokt-network-intel/SUPPLIERS.md`,
    updated: UPDATED,
  };
}

const out = { "card.json": card("main"), "card.beta.json": card("beta") };
let stale = false;
for (const [file, c] of Object.entries(out)) {
  const text = JSON.stringify(c, null, 2) + "\n";
  const target = path.join(ROOT, file);
  const bytes = Buffer.byteLength(text); // the file is submitted as is
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (have !== text) { console.error(`${file} is out of date: run node ops/build-card.js`); stale = true; }
  } else {
    fs.writeFileSync(target, text);
    console.log(`${file}: ${bytes} bytes, spec sha256 ${sha256}`);
  }
  if (bytes > 4096) { console.error(`${file} is ${bytes} bytes, over the 4 KiB target`); stale = true; }
}
process.exit(stale ? 1 : 0);
