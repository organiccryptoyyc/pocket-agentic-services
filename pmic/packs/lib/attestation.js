// Signed input attestations on PMIC briefs (Verified layer, Phase 3; owner decisions 2026-10-18).
//
// The collector signs one attestation per series (pmic/lib/attest.js); the hub stores them; this pack
// fetches the ones for the series a brief cites, verifies each again with the published key
// (config/attestation_keys.json) and passes every envelope through unchanged, so anyone can re-verify.
//
//   valid    payload hash recomputes, Ed25519 signature verifies with a published key, the envelope is
//            for this series, and it was signed within MAX_AGE_H
//   stale    all of that except the age
//   invalid  anything else (detail says which)
//   missing  no attestation exists for the series (no cross-check is run for it)
//
// Attestation only: nothing here changes a score, a label or any other field of the brief.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = "pmic-attestation/1.1";
const ALG = "Ed25519";
const MAX_AGE_H = 72;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEYS_FILE = path.join(__dirname, "..", "config", "attestation_keys.json");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
const sha256hex = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
const keyIdOf = (raw) => "pmic-attest-" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

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
    const raw = Buffer.from(k.public_key_b64url, "base64url");
    if (raw.length !== 32 || keyIdOf(raw) !== k.key_id) continue;
    out[k.key_id] = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  }
  return out;
}

function verify(env, seriesId, keys, now = new Date()) {
  try {
    if (!env || typeof env !== "object" || !env.payload || !env.signature) return { status: "invalid", detail: "malformed envelope" };
    const p = env.payload;
    const sig = env.signature;
    if (p.schema_version !== SCHEMA_VERSION) return { status: "invalid", detail: "unsupported attestation schema" };
    if (sig.alg !== ALG || sig.value_encoding !== "base64url") return { status: "invalid", detail: "unsupported signature" };
    if (sha256hex(canonicalJson(p)) !== env.payload_hash) return { status: "invalid", detail: "payload hash mismatch" };
    if (sig.attestation_id !== p.attestation_id) return { status: "invalid", detail: "attestation id mismatch" };
    if (!p.subject || p.subject.series_id !== seriesId) return { status: "invalid", detail: "attestation is for another series" };
    const key = keys[sig.key_id];
    if (!key) return { status: "invalid", detail: "unknown key" };
    const record = { alg: ALG, attestation_id: sig.attestation_id, key_id: sig.key_id, payload_hash: env.payload_hash, signed_at: sig.signed_at };
    if (!crypto.verify(null, Buffer.from(canonicalJson(record), "utf8"), key, Buffer.from(sig.value, "base64url"))) return { status: "invalid", detail: "bad signature" };
    const t = Date.parse(sig.signed_at);
    if (!Number.isFinite(t) || t > now.getTime() + 5 * 60 * 1000) return { status: "invalid", detail: "bad signing time" };
    if (now.getTime() - t > MAX_AGE_H * 3.6e6) return { status: "stale", detail: `signed more than ${MAX_AGE_H} h ago` };
    return { status: "valid", detail: `signature verified with key ${sig.key_id}` };
  } catch (e) {
    return { status: "invalid", detail: "malformed envelope" };
  }
}

// The series a response cites (briefs: citations and drivers; /v1/signal: its own series_id).
function seriesOf(out) {
  const ids = new Set();
  for (const c of out.citations || []) if (c && typeof c.series_id === "string") ids.add(c.series_id);
  for (const d of out.drivers || []) if (d && typeof d.series_id === "string") ids.add(d.series_id);
  if (typeof out.series_id === "string") ids.add(out.series_id);
  return [...ids].sort();
}

// The `attestation` block for a response, given {series_id: envelope} from the hub.
function block(ids, envelopes, keys, now = new Date()) {
  const series = ids.map((sid) => {
    const env = envelopes[sid];
    if (!env) return { series_id: sid, verification_status: "missing", verification_detail: "no cross-check is run for this series", envelope: null };
    const v = verify(env, sid, keys, now);
    return { series_id: sid, verification_status: v.status, verification_detail: v.detail, envelope: v.status === "invalid" ? null : env };
  });
  const count = (st) => series.filter((s) => s.verification_status === st).length;
  const summary = { series: series.length, valid: count("valid"), stale: count("stale"), invalid: count("invalid"), missing: count("missing") };
  const review = series.filter((s) => s.envelope && s.envelope.payload.review_required).map((s) => s.series_id);
  const statement = `Signed input attestations for the ${summary.series} series this answer cites: ${summary.valid} verified, ${summary.stale} stale, ` +
    `${summary.invalid} invalid, ${summary.missing} with no cross-check. Each envelope is passed through exactly as the collector signed it ` +
    `(Ed25519 over an RFC 8785 payload; public key in config/attestation_keys.json). ` +
    (review.length ? `Review required for: ${review.join(", ")}. ` : "No series requires review. ") +
    "The attestations do not change any score, label or value in this answer.";
  return { schema_version: SCHEMA_VERSION, summary, statement, series };
}

// Answers that aggregate many series by country (country tables) and do not list them individually.
function aggregateBlock() {
  return { schema_version: SCHEMA_VERSION, summary: { series: 0, valid: 0, stale: 0, invalid: 0, missing: 0 },
    statement: "This answer aggregates many series by country or state and does not list them individually, so no per-series " +
      "attestation is attached here. Each underlying series' signed attestation is returned with POST /v1/signal {series_id}. " +
      "The attestations do not change any score, label or value.",
    series: [] };
}

// Answers that list events or rank peers and cite no individual series (filing risk, peer tables).
function noSeriesBlock() {
  return { schema_version: SCHEMA_VERSION, summary: { series: 0, valid: 0, stale: 0, invalid: 0, missing: 0 },
    statement: "This answer lists events or ranks peers and does not cite individual data series, so no per-series attestation " +
      "applies. Each underlying series' signed attestation is returned with POST /v1/signal {series_id}. " +
      "The attestations do not change any score, label or value.",
    series: [] };
}

module.exports = { loadKeys, verify, seriesOf, block, aggregateBlock, noSeriesBlock, canonicalJson, keyIdOf, SCHEMA_VERSION, MAX_AGE_H };
