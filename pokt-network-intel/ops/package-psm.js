// Assembles one network's Pocket Service Manager deployment folder for pokt-network-intel.
//
//   node ops/package-psm.js beta   -> build/pokt-network-intel-beta/   (deploy id pokt-network-intel-beta)
//   node ops/package-psm.js main   -> ~/Downloads/pokt-network-intel/  (PSM services folder; deploy id pokt-network-intel)
//
// One container per network (PNF issue #6): POCKET_NETWORK is set to the network, and the folder's
// card.json is that network's card (Beta: card.beta.json), whose healthcheck pins $.network.
// No secrets: the service holds no keys or tokens.
// Layout: card.json, service.json, backend/, deploy/docker-compose.yaml.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const NETWORK = process.argv[2];
if (NETWORK !== "beta" && NETWORK !== "main") {
  console.error("usage: node ops/package-psm.js <beta|main> [out_parent_dir]");
  process.exit(2);
}
const SRC = path.join(__dirname, "..");
const DEPLOY_ID = NETWORK === "main" ? "pokt-network-intel" : "pokt-network-intel-beta";
const PARENT = path.resolve(process.argv[3] || (NETWORK === "main" ? path.join(os.homedir(), "Downloads") : path.join(SRC, "build")));
const OUT = path.join(PARENT, DEPLOY_ID);

const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to), { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ["server.js", "package.json", "Dockerfile", ".dockerignore"]) copy(f, `backend/${f}`);
copy("lib", "backend/lib");
const compose = fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{NETWORK}}", NETWORK).replaceAll("{{DEPLOY_ID}}", DEPLOY_ID);
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), compose);
copy(NETWORK === "main" ? "card.json" : "card.beta.json", "card.json");
copy("service.json", "service.json");
console.log(JSON.stringify({ network: NETWORK, deploy_id: DEPLOY_ID, backend_url: `http://${DEPLOY_ID}-backend:8080`, folder: OUT }));
