// Build a witness task set from TCS-6 evidence bundles and post it to the queue's peer API.
// Runs inside the TCS-6 container (it reads the bundles TCS-6 already holds; nothing is written):
//   docker exec -i treasury-capital-score-beta-backend node - beta < tools/tcs6-claims.js
// A claim is one verified on-chain holding: entity, chain, holder, token, quantity, the USD value
// TCS-6 gave it (for the sample weight only) and the time the collector observed it. Public data only.
"use strict";
const fs = require("fs");
const path = require("path");

const NETWORK = process.argv[2] === "main" ? "main" : "beta";
const DIR = path.join(process.env.TCS6_DATA_DIR || "/var/lib/tcs6", "evidence");
const QUEUE = process.env.CQ_PEER || `http://pocket-confidential-queue${NETWORK === "main" ? "" : "-beta"}-backend:8091`;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const REGISTRY = process.env.TCS6_REGISTRY || "/app/data/registry.json";

// Only plain balances are claims. Addresses whose holding TCS-6 reads another way are left out:
// a curated cap (count_only), the Sky surplus buffer (Vat.dai - Vat.sin), a RocketVault ledger
// entry (balanceOfToken) and Compound market reserves (getReserves()). The witness re-reads
// balanceOf, which for those would differ by design.
function specialHolders(registry) {
  const out = new Map(); // "chain:address" -> reason
  const ents = Array.isArray(registry) ? registry : registry.entities || [];
  for (const e of ents) for (const a of e.treasury_addresses || []) {
    if (!a || typeof a.address !== "string") continue;
    const role = String(a.role || "");
    const why = a.count_only ? "count_only cap" : role === "vow_surplus_buffer" ? "Vat surplus" : role === "rocket_vault_balance" ? "RocketVault ledger"
      : role.startsWith("comet_") && role.endsWith("_reserves") ? "Comet getReserves()" : null;
    if (why) out.set(`${e.entity_id}|${a.chain}:${a.address.toLowerCase()}`, why);
  }
  return out;
}

function claimsFrom(bundle, now, special = new Map()) {
  const out = [];
  for (const h of bundle.holdings || []) {
    if (h.control !== "verified" || h.bucket !== "onchain" || typeof h.asset_id !== "string") continue;
    const parts = h.asset_id.split(":");
    if (parts.length !== 3) continue; // tagged positions (special readers) are not plain balances
    const [chain, tok, holder] = parts;
    const token = tok === "native" ? null : tok;
    if (!ADDR.test(holder) || (token !== null && !ADDR.test(token))) continue;
    if (special.has(`${bundle.entity_id}|${chain}:${holder.toLowerCase()}`)) continue;
    const t = Date.parse(h.holdings_observed_at);
    if (!Number.isFinite(t) || now - t > 30 * 86400_000 || typeof h.quantity !== "number" || !(h.quantity >= 0)) continue;
    const usd = h.prices && h.prices[0] && typeof h.prices[0].usd === "number" ? h.prices[0].usd : null;
    out.push({ ref: h.asset_id, entity_id: bundle.entity_id, chain, holder, token, quantity: h.quantity, value_usd: usd == null ? null : Math.round(h.quantity * usd * 100) / 100, observed_at: new Date(t).toISOString() });
  }
  return out;
}

async function main() {
  const now = Date.now();
  const special = specialHolders(JSON.parse(fs.readFileSync(REGISTRY, "utf8")));
  const claims = [];
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
    try { claims.push(...claimsFrom(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")), now, special)); } catch { /* unreadable bundle: skipped */ }
  }
  const task_set = { task_set_id: `tcs6-${NETWORK}-${new Date(now).toISOString().replace(/[^0-9T]/g, "").slice(0, 13)}`, network: NETWORK, source: `treasury-capital-score${NETWORK === "main" ? "" : "-beta"}`, claims };
  const entities = new Set(claims.map((c) => c.entity_id)).size;
  console.log(JSON.stringify({ task_set_id: task_set.task_set_id, claims: claims.length, entities, special_addresses_left_out: special.size }));
  if (process.env.DRY) return;
  const r = await fetch(`${QUEUE}/peer/witness/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_set }) });
  console.log(r.status, await r.text());
}

if (require.main === module || require.main === undefined) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { claimsFrom, specialHolders };
