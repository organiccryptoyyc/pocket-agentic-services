// Verifies the signed input attestation the Pi collector attaches to an evidence bundle, and exposes it in the
// paid report unchanged. The Pi signs; this side only checks and labels:
//
//   valid    the payload hash recomputes (RFC 8785 canonical JSON, lib/canonical.js), the Ed25519 signature over
//            the canonical signing record verifies with a published key (config/attestation_keys.json), the
//            attestation is for this bundle (entity and collected_at), it is not older than the last one accepted
//            for this entity (replay), and it was signed within ATTEST_MAX_AGE_H
//   stale    everything above holds except the age
//   invalid  anything else (detail says which); a bad attestation never blocks the report
//   missing  the bundle carries no attestation (a verification_summary alone is not one)
//
// Hashes are "sha256:" + 64 lowercase hex; key ids are "tcs6-attest-" + the first 16 hex of SHA-256(public key);
// the signature value is base64url (labelled value_encoding). Only the SCHEMA_VERSIONS are passed through: an
// envelope in any other schema is labelled invalid and withheld, so the paid response keeps its strict schema.
//
// The Pi signs inputs and never scores, so the scoring-policy version is added here, outside the signed payload:
// it is the version of lib/scoring.js that computed this report.
//
// The payload, hash and signature are passed through exactly as received: never reformatted, recounted or
// trimmed, so anyone can re-verify them. Verdicts never touch scoring (attestation_layer != scoring_layer).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("./canonical");

const ALG = "Ed25519";
const SCHEMA_VERSIONS = ["tcs6-attestation/1.1", "tcs6-attestation/1.2"];
const { METHOD_VERSION: SCORING_POLICY_VERSION } = require("./scoring");
const ATTEST_MAX_AGE_H = 36; // the collector runs every 4 h and the pipeline every 12 h
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEYS_FILE = path.join(__dirname, "..", "config", "attestation_keys.json");

const b64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const sha256hex = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
const keyIdOf = (raw) => "tcs6-attest-" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

// {key_id: KeyObject} from config/attestation_keys.json {"keys": [{key_id, alg, public_key_b64url}]}.
// A key whose id does not match its public key is ignored (a typo can't impersonate another key).
function loadKeys(file = KEYS_FILE) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8")).keys || [];
  } catch {
    return {};
  }
  const out = {};
  for (const k of list) {
    if (!k || k.alg !== ALG || typeof k.public_key_b64url !== "string") continue;
    const raw = b64u(k.public_key_b64url);
    if (raw.length !== 32 || keyIdOf(raw) !== k.key_id) continue;
    out[k.key_id] = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  }
  return out;
}

function verifyEnvelope(env, bundle, keys, { lastSignedAt = null, now = new Date() } = {}) {
  if (!bundle || bundle.attestation === undefined) return { status: "missing", detail: "No signed attestation was delivered with this report's evidence." };
  try {
    const sig = env.signature;
    const payload = env.payload;
    if (!sig || !payload || typeof payload !== "object") return { status: "invalid", detail: "malformed envelope" };
    if (!SCHEMA_VERSIONS.includes(payload.schema_version)) return { status: "invalid", detail: `unsupported attestation schema ${String(payload.schema_version).slice(0, 40)}`, withhold: true };
    if (sig.alg !== ALG) return { status: "invalid", detail: "unsupported algorithm" };
    if (sig.value_encoding !== "base64url") return { status: "invalid", detail: "unsupported signature encoding" };
    if (sha256hex(canonicalJson(payload)) !== env.payload_hash) return { status: "invalid", detail: "payload hash mismatch" };
    if (sig.attestation_id !== payload.attestation_id) return { status: "invalid", detail: "attestation id mismatch" };
    const key = keys[sig.key_id];
    if (!key) return { status: "invalid", detail: `unknown key ${String(sig.key_id).slice(0, 40)}` };
    const record = { alg: ALG, attestation_id: sig.attestation_id, key_id: sig.key_id, payload_hash: env.payload_hash, signed_at: sig.signed_at };
    if (!crypto.verify(null, Buffer.from(canonicalJson(record), "utf8"), key, b64u(sig.value))) return { status: "invalid", detail: "bad signature" };
    const subject = payload.subject || {};
    if (subject.entity_id !== bundle.entity_id || subject.bundle_collected_at !== bundle.collected_at) {
      return { status: "invalid", detail: "attestation is for a different bundle" };
    }
    const signed = Date.parse(sig.signed_at);
    if (!Number.isFinite(signed)) return { status: "invalid", detail: "unreadable signing time" };
    if (lastSignedAt && signed < Date.parse(lastSignedAt)) return { status: "invalid", detail: "replay: older than the last attestation accepted for this entity" };
    if (signed > now.getTime() + 5 * 60 * 1000) return { status: "invalid", detail: "signing time is in the future" };
    if (now.getTime() - signed > ATTEST_MAX_AGE_H * 3.6e6) return { status: "stale", detail: `signed more than ${ATTEST_MAX_AGE_H} h before this report` };
    return { status: "valid", detail: `signature verified with key ${sig.key_id}` };
  } catch (e) {
    return { status: "invalid", detail: `malformed: ${String(e && e.message).slice(0, 80)}` };
  }
}

// The report's `attestation` block: the received envelope unchanged plus the verdict and the full statement.
function attestationBlock(bundle, verdict) {
  const env = bundle && bundle.attestation;
  if (!env && !(bundle && bundle.verification_summary)) return null; // older bundles (and golden fixtures): no block
  if (verdict.status === "missing" || verdict.withhold || !env || typeof env !== "object" || !env.payload || typeof env.payload !== "object") {
    return { verification_status: verdict.status === "missing" ? "missing" : "invalid", verification_detail: verdict.detail,
      scoring_policy_version: SCORING_POLICY_VERSION, statement: verdict.detail, payload: null, payload_hash: null, signature: null };
  }
  const sig = env.signature || {};
  const statement = `${typeof env.payload.statement === "string" ? env.payload.statement : ""} This report's score was computed under scoring policy version ${SCORING_POLICY_VERSION}, which does not yet apply a materiality rule to failed or conflicted checks. Signed using ${sig.alg} by key ${sig.key_id} at ${sig.signed_at}. Verification status: ${verdict.status} (${verdict.detail}).`;
  return { verification_status: verdict.status, verification_detail: verdict.detail, scoring_policy_version: SCORING_POLICY_VERSION, statement,
    payload: env.payload, payload_hash: env.payload_hash ?? null, signature: env.signature ?? null };
}

module.exports = { verifyEnvelope, attestationBlock, loadKeys, keyIdOf, SCHEMA_VERSIONS, SCORING_POLICY_VERSION, ATTEST_MAX_AGE_H };
