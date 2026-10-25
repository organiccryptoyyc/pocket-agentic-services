// Assembles one network's Pocket Service Manager deployment folder.
//
//   node ops/package-psm.js beta   -> build/capital-integrity-dossier-beta/   (deploy id capital-integrity-dossier-beta)
//   node ops/package-psm.js main   -> ~/Downloads/capital-integrity-dossier/  (PSM services folder; deploy id capital-integrity-dossier)
//
// Each network is a separate deployment that reads that network's TCS-6 data volume read-only. The on-chain
// service id is capital-integrity-dossier on both. Layout: card.json, service.json, backend/, deploy/docker-compose.yaml.
// No secrets: the dossier has no ingest listener.
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
const DEPLOY_ID = NETWORK === "main" ? "capital-integrity-dossier" : "capital-integrity-dossier-beta";
// Docker Compose names a project's volume <project>_<volume>; the TCS-6 project is its deploy id.
const TCS6_VOLUME = NETWORK === "main" ? "treasury-capital-score_tcs6-data" : "treasury-capital-score-beta_tcs6-data";
const PARENT = path.resolve(process.argv[3] || (NETWORK === "main" ? path.join(os.homedir(), "Downloads") : path.join(SRC, "build")));
const OUT = path.join(PARENT, DEPLOY_ID);

const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to), { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ["server.js", "package.json", "Dockerfile"]) copy(f, `backend/${f}`);
copy("lib", "backend/lib");
const compose = fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{NETWORK}}", NETWORK).replaceAll("{{DEPLOY_ID}}", DEPLOY_ID).replaceAll("{{TCS6_VOLUME}}", TCS6_VOLUME);
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), compose);
copy("card.json", "card.json");
copy("service.json", "service.json");
console.log(JSON.stringify({ network: NETWORK, deploy_id: DEPLOY_ID, backend_url: `http://${DEPLOY_ID}-backend:8080`, tcs6_volume: TCS6_VOLUME, folder: OUT }));
