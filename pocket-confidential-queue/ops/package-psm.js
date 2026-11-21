// Assembles one network's PSM deployment folder for pocket-confidential-queue.
//   node ops/package-psm.js beta   -> build/pocket-confidential-queue-beta/  (route /cq-job-beta)
//   node ops/package-psm.js main   -> build/pocket-confidential-queue/       (route /cq-job)
// First deploy of a network only: add --new-token (writes .secrets/<network>-job.env).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NETWORK = process.argv[2];
if (NETWORK !== "beta" && NETWORK !== "main") { console.error("usage: node ops/package-psm.js <beta|main> [--new-token]"); process.exit(2); }
const SRC = path.join(__dirname, "..");
const DEPLOY_ID = NETWORK === "main" ? "pocket-confidential-queue" : "pocket-confidential-queue-beta";
const ROUTE = NETWORK === "main" ? "/cq-job" : "/cq-job-beta";
const OUT = path.join(SRC, "build", DEPLOY_ID);
const SECRET = path.join(SRC, ".secrets", `${NETWORK}-job.env`);
if (!fs.existsSync(SECRET)) {
  if (!process.argv.includes("--new-token")) { console.error(`missing ${SECRET}; first deploy only: --new-token`); process.exit(1); }
  fs.mkdirSync(path.dirname(SECRET), { recursive: true });
  fs.writeFileSync(SECRET, `CQ_JOB_TOKEN=${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
}
const token = fs.readFileSync(SECRET, "utf8").match(/CQ_JOB_TOKEN=([0-9a-f]{64})/)[1];
fs.rmSync(OUT, { recursive: true, force: true });
const copy = (f, t) => fs.cpSync(path.join(SRC, f), path.join(OUT, t), { recursive: true });
for (const f of ["server.js", "package.json", "Dockerfile"]) copy(f, `backend/${f}`);
copy("lib", "backend/lib");
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{NETWORK}}", NETWORK).replaceAll("{{DEPLOY_ID}}", DEPLOY_ID).replaceAll("{{ROUTE}}", ROUTE)
  .replaceAll("{{DEPLOY_STAMP}}", new Date().toISOString()).replaceAll("{{JOB_TOKEN}}", token));
fs.writeFileSync(path.join(OUT, "deploy/routes.json"), JSON.stringify({ routes: [{ path: ROUTE, port: 8090 }] }, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "service.json"), JSON.stringify({ service_id: DEPLOY_ID, name: "Pocket Confidential Queue", compute_units_per_relay: 100000, networks: {} }, null, 2) + "\n");
console.log(JSON.stringify({ network: NETWORK, deploy_id: DEPLOY_ID, job_route: ROUTE, folder: OUT }));
