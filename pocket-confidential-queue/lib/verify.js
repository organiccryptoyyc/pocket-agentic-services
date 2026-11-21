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

module.exports = { PROTOCOL, CIPHER, EVIDENCE_SCHEMA, canonical, sha256hex, verifyEd25519, checkAnnouncement, checkRequest, checkSealed };
