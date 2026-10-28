// Capital Integrity Dossier: a Pocket Network service.
//
// A disclosed multi-call report on one TCS-6 protocol (PNF rule D12):
//   POST /v1/dossier/plan      {"entity_id": "aave"}                  -> dossier_id, sections, calls_required, estimate, notice
//   POST /v1/dossier/section   {"dossier_id", "section"}              -> one section of the pinned snapshot
//   POST /v1/dossier/entities  {}                                     -> the protocols a dossier can cover
// plus GET /v1/version and /v1/health. Every section is built from TCS-6 data already collected, scored
// and attested (read-only mount of the TCS-6 data volume); this server never calls a chain or a vendor.
"use strict";

const { createServer } = require("./lib/http");
const store = require("./lib/store");
const D = require("./lib/dossier");

const SERVICE = "capital-integrity-dossier";
const VERSION = "1.1.0";
const PORT = Number(process.env.PORT || 8080);
const PAIR_REFRESH_MS = 5 * 60 * 1000;

let lastRefresh = null;
function refresh() {
  try {
    store.refreshPairs();
    store.purgeExpired();
    lastRefresh = new Date().toISOString();
  } catch (e) {
    console.error(JSON.stringify({ refresh_error: String(e && e.message) }));
  }
}

function health() {
  return { network: process.env.DOSSIER_NETWORK || "local", entities: store.listEntities().length, last_snapshot_refresh: lastRefresh };
}

if (require.main === module) {
  store.ensureDirs();
  refresh();
  setInterval(refresh, PAIR_REFRESH_MS).unref();
  const server = createServer({
    service: SERVICE,
    version: VERSION,
    versionPath: "/v1/version",
    healthPath: "/v1/health",
    health,
    routes: new Map([
      ["POST /v1/dossier/plan", async (body) => D.plan(body)],
      ["POST /v1/dossier/section", async (body) => D.section(body)],
      ["POST /v1/dossier/entities", async () => D.entities()],
    ]),
  });
  server.listen(PORT, () => console.log(JSON.stringify({ service: SERVICE, version: VERSION, port: PORT, tcs6_dir: store.TCS6_DIR, data_dir: store.DATA_DIR })));
}

module.exports = { SERVICE, VERSION };
