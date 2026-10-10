// Assembles the PMIC hub's Pocket Service Manager deployment folder.
//
//   node pmic/ops/package-psm.js            -> ~/Downloads/pmic-hub/   (deploy id pmic-hub)
//   node pmic/ops/package-psm.js <parent>   -> <parent>/pmic-hub/
//
// Layout: service.json + card.json (so PSM lists it under Deploy service), backend/ (the same image
// the Pi runs), deploy/docker-compose.yaml, deploy/routes.json. The hub is not a paid service: the
// card is only there for PSM's listing, and it is never registered or staked.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = path.join(__dirname, "..");
const DEPLOY_ID = "pmic-hub";
const ROUTE = "/pmic-ingest";
const OUT = path.join(path.resolve(process.argv[2] || path.join(os.homedir(), "Downloads")), DEPLOY_ID);

// Ingest token (shared with the Pi's PMIC_PUSH_TOKEN) and API token (shared with the service
// packs), generated once into .secrets/ (gitignored) and written into the generated compose file
// (PSM does not ship .env files). Re-running keeps the same tokens.
const SECRET = path.join(SRC, ".secrets", "hub.env");
if (!fs.existsSync(SECRET)) {
  fs.mkdirSync(path.dirname(SECRET), { recursive: true });
  const t = () => crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET, `PMIC_INGEST_TOKEN=${t()}\nPMIC_API_TOKEN=${t()}\n`, { mode: 0o600 });
}
const secrets = fs.readFileSync(SECRET, "utf8");
const token = (k) => secrets.match(new RegExp(`^${k}=([0-9a-f]+)$`, "m"))[1];

const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to), { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of ["server.js", "package.json", "Dockerfile"]) copy(f, `backend/${f}`);
for (const d of ["lib", "bin", "config", "migrations"]) copy(d, `backend/${d}`);
const compose = fs.readFileSync(path.join(SRC, "ops/psm/docker-compose.template.yaml"), "utf8")
  .replaceAll("{{INGEST_TOKEN}}", token("PMIC_INGEST_TOKEN"))
  .replaceAll("{{API_TOKEN}}", token("PMIC_API_TOKEN"))
  // Optional: the Pi's price bank public key (printed by `sh ops/pricebank-setup.sh` on the Pi),
  // added to .secrets/hub.env as PRICEBANK_PUBLIC_KEY=<64 hex>. Public, but kept beside the tokens.
  .replaceAll("{{PRICEBANK_PUBLIC_KEY}}", (secrets.match(/^PRICEBANK_PUBLIC_KEY=([0-9a-f]{64})$/m) || [])[1] || "");
fs.mkdirSync(path.join(OUT, "deploy"), { recursive: true });
fs.writeFileSync(path.join(OUT, "deploy/docker-compose.yaml"), compose);
fs.writeFileSync(path.join(OUT, "deploy/routes.json"), JSON.stringify({ routes: [{ path: ROUTE, port: 8091 }] }, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "service.json"), JSON.stringify({
  service_id: DEPLOY_ID, name: "PMIC hub (private, do not register)", card: "card.json", networks: {},
}, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "card.json"), JSON.stringify({
  schema: "pocket-service-card/v1",
  description: "PMIC hub: the private data layer under the PMIC service packs. It receives pushes from the Pi collector and answers the packs over the pocket-supplier network. Not a relay service: never register or stake it.",
  rpc_types: [{ type: "REST", intent: "expected", backend_hint: "pmic-hub-backend on :8080", notes: "Private. GET /v1/health; POST /v1/* with a bearer token." }],
  access: "private",
}, null, 2) + "\n");
console.log(JSON.stringify({
  deploy_id: DEPLOY_ID,
  folder: OUT,
  ingest_route: ROUTE,
  pi_push_url: `https://agentic.organiccryptoyyc.com${ROUTE}/ingest/sync`,
  pricebank_push_url: `https://agentic.organiccryptoyyc.com${ROUTE}/ingest/pricebank`,
  pricebank_public_key: /^PRICEBANK_PUBLIC_KEY=[0-9a-f]{64}$/m.test(secrets) ? "set" : "NOT SET (add PRICEBANK_PUBLIC_KEY=<hex> to tokens_file, then rebuild)",
  pi_push_token: "PMIC_INGEST_TOKEN in tokens_file (not printed, so screenshots stay safe)",
  packs_hub_url: `http://${DEPLOY_ID}-backend:8080`,
  tokens_file: SECRET,
}, null, 2));
