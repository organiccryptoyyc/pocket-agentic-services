// Checks the queue runs on what the Liskov job sends. Same rules as
// pocket-confidential/src/protocol.ts (protocol pocket-confidential/0.1), in plain JS so the
// queue needs no build step. The queue never decrypts anything: it only checks signatures,
// expiry and that a result matches the request it answers.
"use strict";

const crypto = require("crypto");

const PROTOCOL = "pocket-confidential/0.1";
const CIPHER = "x25519-hkdf-sha256-aes-256-gcm";
const EVIDENCE_SCHEMA = "pocket-confidential-evidence/0.1";
const ED_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function canonical(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  throw new Error(`canonical: unsupported ${typeof v}`);
}

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

function verifyEd25519(publicKeyHex, message, signatureHex) {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

function checkAnnouncement(a, now = Date.now()) {
  const p = [];
  const x = a && a.announcement;
  if (!x || typeof a.signature !== "string") return ["announcement and signature are required"];
  if (x.protocol !== PROTOCOL || x.cipher !== CIPHER) p.push("unknown protocol or cipher");
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(x.encryption_public_key))) p.push("encryption_public_key must be a 32-byte base64url key");
  if (!verifyEd25519(String(x.job_ed25519_public_key), canonical(x), a.signature)) p.push("bad announcement signature");
  const exp = Date.parse(x.expires_at);
  if (!(exp > now)) p.push("announcement expired");
  if (exp - now > 24 * 3600_000) p.push("announcement lasts more than 24 hours");
  return p;
}

const B64U = /^[A-Za-z0-9_-]+$/;
function checkRequest(r, maxBytes) {
  const p = [];
  if (!r || typeof r !== "object") return ["request must be an object"];
  if (r.protocol !== PROTOCOL || r.cipher !== CIPHER) p.push("unknown protocol or cipher");
  if (typeof r.service !== "string" || !/^[a-z0-9-]{1,40}$/.test(r.service)) p.push("service must be a lowercase id");
  if (typeof r.request_id !== "string" || !/^[0-9a-f]{16,64}$/.test(r.request_id)) p.push("request_id must be 16-64 hex characters");
  for (const f of ["to", "ephemeral_public_key", "iv", "ciphertext", "tag"]) if (typeof r[f] !== "string" || !B64U.test(r[f])) p.push(`${f} must be base64url`);
  if (typeof r.input_commitment !== "string" || !/^[0-9a-f]{64}$/.test(r.input_commitment)) p.push("input_commitment must be a SHA-256 hex digest");
  if (Buffer.byteLength(JSON.stringify(r)) > maxBytes) p.push(`request over ${maxBytes} bytes`);
  return p;
}

// A sealed result must be signed by the job key the request was sent to, for that request's
// committed input, with an output hash that matches the result.
function checkSealed(sealed, req, jobKeyHex) {
  const p = [];
  const e = sealed && sealed.evidence;
  if (!e || typeof sealed.signature !== "string") return ["sealed result needs evidence and signature"];
  if (e.schema !== EVIDENCE_SCHEMA) p.push("unknown evidence schema");
  if (e.request_id !== req.request_id) p.push("result is for another request");
  if (e.input_commitment !== req.input_commitment) p.push("result is for a different input");
  if (String(e.job_ed25519_public_key).toLowerCase() !== String(jobKeyHex).toLowerCase()) p.push("signed by a different job key");
  if (e.output_hash !== sha256hex(canonical(sealed.result))) p.push("output hash does not match the result");
  if (!verifyEd25519(String(e.job_ed25519_public_key), canonical({ result: sealed.result, evidence: e }), sealed.signature)) p.push("bad result signature");
  return p;
}

// Witness task sets (TCS-6 claims) and the job's signed witness. Same rules as
// pocket-confidential/src/witness.ts.
const WITNESS_SCHEMA = "pocket-confidential-witness/0.1";
const ENTITY_WITNESS_SCHEMA = "pocket-confidential-entity-witness/0.1";
const MAX_CLAIMS = 2000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
function checkTaskSet(t, now = Date.now()) {
  const p = [];
  if (!t || typeof t !== "object") return ["task_set must be an object"];
  if (typeof t.task_set_id !== "string" || !/^[A-Za-z0-9_.:-]{8,80}$/.test(t.task_set_id)) p.push("task_set_id must be 8-80 characters [A-Za-z0-9_.:-]");
  if (typeof t.network !== "string" || typeof t.source !== "string") p.push("network and source are required");
  if (!Array.isArray(t.claims) || !t.claims.length) return [...p, "claims must be a non-empty array"];
  if (t.claims.length > MAX_CLAIMS) p.push(`at most ${MAX_CLAIMS} claims`);
  t.claims.forEach((c, i) => {
    if (!c || typeof c !== "object") return p.push(`claims[${i}] must be an object`);
    if (typeof c.ref !== "string" || c.ref.length > 200) p.push(`claims[${i}].ref invalid`);
    if (typeof c.entity_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.entity_id)) p.push(`claims[${i}].entity_id invalid`);
    if (typeof c.chain !== "string" || c.chain.length > 32) p.push(`claims[${i}].chain invalid`);
    if (typeof c.holder !== "string" || !ADDR.test(c.holder)) p.push(`claims[${i}].holder invalid`);
    if (c.token !== null && (typeof c.token !== "string" || !ADDR.test(c.token))) p.push(`claims[${i}].token invalid`);
    if (typeof c.quantity !== "number" || !Number.isFinite(c.quantity) || c.quantity < 0) p.push(`claims[${i}].quantity invalid`);
    if (c.value_usd !== null && (typeof c.value_usd !== "number" || !Number.isFinite(c.value_usd))) p.push(`claims[${i}].value_usd invalid`);
    const ts = Date.parse(c.observed_at);
    if (!Number.isFinite(ts) || ts > now + 300_000 || now - ts > 30 * 86400_000) p.push(`claims[${i}].observed_at invalid or older than 30 days`);
  });
  return p.slice(0, 20);
}

// The witness must answer this task set, commit to exactly its claims, and be signed by a job
// key the queue currently holds an announcement for.
function checkWitness(body, taskSet, jobKeys) {
  const p = [];
  const w = body && body.witness;
  if (!w || typeof body.signature !== "string") return ["witness and signature are required"];
  if (w.schema !== WITNESS_SCHEMA) p.push("unknown witness schema");
  if (w.task_set_id !== taskSet.task_set_id) p.push("witness is for another task set");
  if (w.claims_sha256 !== sha256hex(canonical(taskSet.claims))) p.push("witness does not commit to the claims it was given");
  const key = String(w.job_ed25519_public_key || "").toLowerCase();
  if (!jobKeys.map((k) => k.toLowerCase()).includes(key)) p.push("signed by a job key the queue does not hold");
  if (!verifyEd25519(key, canonical(w), body.signature)) p.push("bad witness signature");
  if (!Array.isArray(w.checks) || !Array.isArray(w.entities)) p.push("checks and entities are required");
  // Per-entity witnesses (witness 0.2+): each signed by the same key, for the same task set and
  // claims, one per entity in the full witness.
  // Witness 0.2+ signs each entity too; a witness without them (an older job still draining after a
  // release) is refused, so its lease expires and the current job takes the task set again.
  if (!Array.isArray(body.entity_witnesses) || !body.entity_witnesses.length) return [...p, "entity_witnesses are required (witness 0.2 or later)"];
  {
    const names = new Set((w.entities || []).map((e) => e.entity_id));
    const seen = new Set();
    body.entity_witnesses.forEach((x, i) => {
      const ew = x && x.witness;
      if (!ew || typeof x.signature !== "string") return p.push(`entity_witnesses[${i}] needs witness and signature`);
      if (ew.schema !== ENTITY_WITNESS_SCHEMA) p.push(`entity_witnesses[${i}] unknown schema`);
      if (ew.task_set_id !== taskSet.task_set_id || ew.claims_sha256 !== w.claims_sha256) p.push(`entity_witnesses[${i}] is for another task set`);
      if (String(ew.job_ed25519_public_key || "").toLowerCase() !== key) p.push(`entity_witnesses[${i}] signed by another key`);
      const id = ew.entity && ew.entity.entity_id;
      if (!names.has(id) || seen.has(id)) p.push(`entity_witnesses[${i}] entity not in the witness or repeated`);
      seen.add(id);
      if (!verifyEd25519(key, canonical(ew), x.signature)) p.push(`entity_witnesses[${i}] bad signature`);
    });
  }
  return p.slice(0, 20);
}

module.exports = { PROTOCOL, CIPHER, EVIDENCE_SCHEMA, WITNESS_SCHEMA, ENTITY_WITNESS_SCHEMA, canonical, sha256hex, verifyEd25519, checkAnnouncement, checkRequest, checkSealed, checkTaskSet, checkWitness };
