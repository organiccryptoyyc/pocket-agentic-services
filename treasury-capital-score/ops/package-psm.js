// Assembles one network's Pocket Service Manager deployment folder.
//
//   node ops/package-psm.js beta   -> build/treasury-capital-score-beta/   (deploy id treasury-capital-score-beta)
//   node ops/package-psm.js main   -> ~/Downloads/treasury-capital-score/  (PSM services folder; deploy id treasury-capital-score)
//
// Each network is a separate deployment: its own container, image, data
// volume, pipeline, ingest token, and ingest route. The on-chain service id is
// treasury-capital-score on both; only the backend behind each relayer differs.
// Layout: card.json, service.json, backend/, deploy/docker-compose.yaml, deploy/routes.json.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const NETWORK = process.argv[2];
if (NETWORK !== "beta" && NETWORK !== "main") {
  console.error("usage: node ops/package-psm.js <beta|main> [out_parent_dir] [--new-token]");
  process.exit(2);
}
const SRC = path.join(__dirname, "..");
const DEPLOY_ID = NETWORK === "main" ? "treasury-capital-score" : "treasury-capital-score-beta";
const ROUTE = NETWORK === "main" ? "/tcs6-ingest" : "/tcs6-ingest-beta";
const OUT_ARG = process.argv.slice(3).find((a) => !a.startsWith("--"));
const PARENT = path.resolve(OUT_ARG ||(NETWORK === "main" ? path.join(os.homedir(), "Downloads") : path.join(SRC, "build")));
const OUT = path.join(PARENT, DEPLOY_ID);

// Per-network ingest token, kept in .secrets/ (gitignored) and written into the
// generated deploy/docker-compose.yaml (PSM does not ship .env files). A missing
// file is an error: deploying a fresh token would lock out the collector that
// already holds the old one. Pass --new-token only for a first deploy or a
// deliberate rotation (then give the collector the new token).
const crypto = require("crypto");
const SECRET = path.join(SRC, ".secrets", `${NETWORK}-ingest.env`);
if (!fs.existsSync(SECRET)) {
  if (!process.argv.includes("--new-token")) {
    console.error(`missing ${SECRET}\n` +
      `Copy the ${NETWORK} ingest token file from the checkout that deployed it, or pass --new-token ` +
      `to create one (the collector must then be given the new token).`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(SECRET), { recursive: true });
  fs.writeFileSync(SECRET, `TCS6_INGEST_TOKEN=${crypto.randomBytes(32).toString("hex")}
`, { mode: 0o600 });
}

const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to), { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ["server.js", "package.json", "Dockerfile"]) copy(f, `backend/${f}`);
for (const d of ["lib", "pipeline", "methodology", "data", "migrations"]) copy(d, `backend/${d}`);
const compose = fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{NETWORK}}", NETWORK).replaceAll("{{DEPLOY_ID}}", DEPLOY_ID)
  .replaceAll("{{DEPLOY_STAMP}}", new Date().toISOString())
  .replaceAll("{{INGEST_TOKEN}}", fs.readFileSync(SECRET, "utf8").match(/TCS6_INGEST_TOKEN=([0-9a-f]+)/)[1]);
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), compose);
fs.writeFileSync(path.join(OUT, "deploy/routes.json"), JSON.stringify([{ path: ROUTE, port: 8090 }], null, 2) + "\n");
copy("card.json", "card.json");
copy("service.json", "service.json");
console.log(JSON.stringify({ network: NETWORK, deploy_id: DEPLOY_ID, backend_url: `http://${DEPLOY_ID}-backend:8080`, ingest_route: ROUTE, folder: OUT }));
