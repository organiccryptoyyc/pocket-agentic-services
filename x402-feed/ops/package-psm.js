// Assembles one network's PSM deployment folder for x402-feed.
//   node ops/package-psm.js beta   -> build/x402-feed-beta/  (route /x402-feed-beta)
//   node ops/package-psm.js main   -> build/x402-feed/       (route /x402-feed)
// First deploy of a network only: add --new-token. The token file lives OUTSIDE the repo:
// %USERPROFILE%\.x402-feed\<network>.env. It is never printed.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const NETWORK = process.argv[2];
if (NETWORK !== "beta" && NETWORK !== "main") { console.error("usage: node ops/package-psm.js <beta|main> [--new-token]"); process.exit(2); }
const SRC = path.join(__dirname, "..");
const DEPLOY_ID = NETWORK === "main" ? "x402-feed" : "x402-feed-beta";
const ROUTE = NETWORK === "main" ? "/x402-feed" : "/x402-feed-beta";
const OUT = path.join(SRC, "build", DEPLOY_ID);
const SECRET = path.join(os.homedir(), ".x402-feed", `${NETWORK}.env`);
if (!fs.existsSync(SECRET)) {
  if (!process.argv.includes("--new-token")) { console.error(`missing ${SECRET}; first deploy only: --new-token`); process.exit(1); }
  fs.mkdirSync(path.dirname(SECRET), { recursive: true });
  fs.writeFileSync(SECRET, `FEED_TOKEN=${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
}
const token = fs.readFileSync(SECRET, "utf8").match(/FEED_TOKEN=([0-9a-f]{64})/)[1];
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ["server.js", "package.json", "Dockerfile"]) fs.cpSync(path.join(SRC, f), path.join(OUT, "backend", f));
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{NETWORK}}", NETWORK).replaceAll("{{DEPLOY_ID}}", DEPLOY_ID).replaceAll("{{ROUTE}}", ROUTE).replaceAll("{{FEED_TOKEN}}", token));
fs.writeFileSync(path.join(OUT, "deploy/routes.json"), JSON.stringify({ routes: [{ path: ROUTE, port: 8095 }] }, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "service.json"), JSON.stringify({ service_id: DEPLOY_ID, name: "x402 feed (alpha1 door)", networks: {} }, null, 2) + "\n");
console.log(JSON.stringify({ network: NETWORK, deploy_id: DEPLOY_ID, route: ROUTE, folder: OUT }));
