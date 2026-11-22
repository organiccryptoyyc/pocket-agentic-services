#!/usr/bin/env node
// Check a pocket-confidential witness (schema pocket-confidential-witness/0.1) yourself.
//
//   node tools/verify-witness.mjs witness.json [--rpc ethereum=https://your-node ...] [--offline]
//
// witness.json is {"witness": {...}, "signature": "<hex>"} as TCS-6 or the queue returned it.
// 1. The Ed25519 signature over the canonical JSON of the witness, with the job key it names.
// 2. For every check that has a block: the block hash at that block number, then the same read
//    (eth_getBalance, or balanceOf and decimals by eth_call) at that block. The raw value must
//    equal read_raw exactly. By default it asks the RPC recorded in the check; pass --rpc to use
//    your own node for a chain (recommended: then the second read does not share our gateway).
// 3. Then check the job key itself on chain with PROOF's public recipe (no Liskov account):
//    https://docs.proof.computer/liskov/operate/verify-job-keys
//    with acurast_origin, acurast_job_id, job_ed25519_public_key and artifact_digest from the witness.
// Node 18+, no dependencies.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

function canonical(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return JSON.stringify(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  throw new Error(`unsupported ${typeof v}`);
}
function verifyEd25519(pubHex, msg, sigHex) {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(msg, "utf8"), key, Buffer.from(sigHex, "hex"));
  } catch { return false; }
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !a.includes("="));
if (!file) { console.error("usage: node tools/verify-witness.mjs witness.json [--rpc chain=url ...] [--offline]"); process.exit(2); }
const rpcOverride = {};
args.forEach((a, i) => { if (a === "--rpc" && args[i + 1]) { const [c, ...u] = args[i + 1].split("="); rpcOverride[c] = u.join("="); } });
const offline = args.includes("--offline");

const doc = JSON.parse(readFileSync(file, "utf8"));
const { witness: w, signature } = doc.witness && doc.signature ? doc : doc.sealed ?? doc;
let failures = 0, repeated = 0, skipped = 0;
const say = (ok, text) => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${text}`); };

say(w && w.schema === "pocket-confidential-witness/0.1", `schema ${w && w.schema}`);
say(verifyEd25519(String(w.job_ed25519_public_key), canonical(w), String(signature)), `signature by job key ${w.job_ed25519_public_key}`);
console.log(`      job ${w.acurast_job_id} launched by ${w.acurast_origin}, artifact ${w.artifact_digest}`);
console.log(`      check that key on chain: https://docs.proof.computer/liskov/operate/verify-job-keys`);
console.log(`      task set ${w.task_set_id}: ${w.claims_count} claims (sha256 ${w.claims_sha256}), ${w.checks.length} sampled`);

let id = 0;
async function rpc(url, method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 + 1000 * attempt * attempt));
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (attempt === 3) throw e; }
  }
}

if (!offline) {
  for (const c of w.checks) {
    const label = `${c.entity_id} ${c.chain} ${c.token ?? "native"} @ ${c.holder} (${c.status})`;
    if (c.block_number == null) { skipped++; console.log(`SKIP  ${label}: no block recorded (${c.error ?? "unavailable"})`); continue; }
    const url = rpcOverride[c.chain] || c.rpc;
    try {
      const hex = "0x" + c.block_number.toString(16);
      const b = await rpc(url, "eth_getBlockByNumber", [hex, false]);
      const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
      const raw = c.token
        ? BigInt((await rpc(url, "eth_call", [{ to: c.token, data: "0x70a08231" + pad(c.holder) }, hex])).slice(0, 66))
        : BigInt(await rpc(url, "eth_getBalance", [c.holder, hex]));
      const dec = c.token ? Number(BigInt((await rpc(url, "eth_call", [{ to: c.token, data: "0x313ce567" }, hex])).slice(0, 66))) : 18;
      repeated++;
      const ok = b && b.hash === c.block_hash && raw.toString() === c.read_raw && dec === c.decimals;
      say(ok, `${label}: block ${c.block_number} hash ${b && b.hash === c.block_hash ? "same" : "DIFFERENT"}, raw ${raw === BigInt(c.read_raw) ? "same" : `DIFFERENT (${raw})`}, decimals ${dec}${rpcOverride[c.chain] ? " (your node)" : ""}`);
    } catch (e) {
      skipped++;
      console.log(`SKIP  ${label}: ${String(e.message).slice(0, 100)} (an archive node is needed for old blocks)`);
    }
  }
}
const reads = offline ? "reads not repeated (--offline)" : `${repeated} read(s) repeated, ${skipped} skipped`;
console.log(failures ? `\n${failures} check(s) failed; ${reads}` : `\nNo failures; ${reads}`);
process.exit(failures ? 1 : 0);
