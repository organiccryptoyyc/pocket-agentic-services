// Signed input attestation (Verified layer, 2.1 revision): the backend verifies what the Pi signed and passes it
// through unchanged. The vector in fixtures/attestation_vector.json is produced by the Pi collector's Python code
// (tests/test_attestation.py) with a fixed test key, so these tests also prove the two sides agree byte for byte.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-attest-test-"));

const { canonicalJson } = require("../lib/canonical");
const { verifyEnvelope, attestationBlock, loadKeys, keyIdOf, SCORING_POLICY_VERSION } = require("../lib/attestation");
const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attestation_vector.json"), "utf8"));
const SIGNED_AT = Date.parse(VEC.envelope.signature.signed_at);
const NOW = new Date(SIGNED_AT + 3600 * 1000); // one hour after signing
const clone = (x) => JSON.parse(JSON.stringify(x));

function keysFile(entries) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-keys-")), "keys.json");
  fs.writeFileSync(f, JSON.stringify({ keys: entries }));
  return f;
}
const KEYS = loadKeys(keysFile([{ key_id: VEC.key_id, alg: "Ed25519", public_key_b64url: VEC.public_key_b64url }]));
const bundleWith = (env) => ({ ...clone(VEC.bundle), attestation: env });

test("the Pi's canonical payload is byte-identical here, and its signature verifies", () => {
  assert.strictEqual(canonicalJson(VEC.envelope.payload), VEC.canonical_payload);
  assert.deepEqual(verifyEnvelope(VEC.envelope, bundleWith(VEC.envelope), KEYS, { now: NOW }), { status: "valid", detail: `signature verified with key ${VEC.key_id}` });
});

test("keys file: a key whose id doesn't match its public key is ignored", () => {
  assert.equal(keyIdOf(Buffer.from(VEC.public_key_b64url, "base64url")), VEC.key_id);
  const bad = loadKeys(keysFile([{ key_id: "tcs6-attest-wrongwrongwrong1", alg: "Ed25519", public_key_b64url: VEC.public_key_b64url }]));
  assert.deepEqual(Object.keys(bad), []);
  assert.deepEqual(Object.keys(loadKeys(path.join(os.tmpdir(), "no-such-keys-file.json"))), []);
});

test("every tamper, replay, staleness and malformed case is labelled, never thrown", () => {
  const v = (env, opts = {}, b = bundleWith(env)) => verifyEnvelope(env, b, KEYS, { now: NOW, ...opts }).status + ":" + verifyEnvelope(env, b, KEYS, { now: NOW, ...opts }).detail;
  let e = clone(VEC.envelope); e.payload.checks[0].status = e.payload.checks[0].status === "passed" ? "failed" : "passed";
  assert.match(v(e), /^invalid:payload hash mismatch/);
  e = clone(VEC.envelope); e.signature.signed_at = "2026-10-17T12:00:01Z";
  assert.match(v(e), /^invalid:bad signature/, "the signing time is covered by the signature");
  e = clone(VEC.envelope); e.signature.value = e.signature.value.slice(0, -4) + (e.signature.value.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.match(v(e), /^invalid:/);
  e = clone(VEC.envelope); e.signature.key_id = "tcs6-attest-unknownunknown1";
  assert.match(v(e), /^invalid:unknown key/);
  e = clone(VEC.envelope); e.signature.alg = "RS256";
  assert.match(v(e), /^invalid:unsupported algorithm/);
  e = clone(VEC.envelope); e.signature.value_encoding = "hex";
  assert.match(v(e), /^invalid:unsupported signature encoding/);
  // owner feedback 2026-10-17: hashes are "sha256:" + 64 lowercase hex, key ids are hex fingerprints
  assert.match(VEC.envelope.payload_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(VEC.envelope.payload.evidence_manifest_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(VEC.key_id, /^tcs6-attest-[0-9a-f]{16}$/);
  // an envelope in another schema (1.0) is labelled invalid and withheld, never passed through
  // owner feedback round 2: structured review items with exact reasons; scoring policy named outside the signed payload
  assert.equal(VEC.envelope.payload.schema_version, "tcs6-attestation/1.2");
  assert.equal(VEC.envelope.payload.materiality, "undetermined");
  assert.ok(VEC.envelope.payload.review_items.failed_checks.every((c) => c.failure_reason && c.materiality === "undetermined"));
  const blk = attestationBlock(bundleWith(VEC.envelope), { status: "valid", detail: "ok" });
  assert.equal(blk.scoring_policy_version, SCORING_POLICY_VERSION);
  assert.match(blk.statement, /computed under scoring policy version tcs-6\/1\.0 with materiality policy tcs6-materiality\/1\.2\./);
  e = clone(VEC.envelope); e.payload.schema_version = "tcs6-attestation/1.0";
  const old = verifyEnvelope(e, bundleWith(e), KEYS, { now: NOW });
  assert.match(old.status + ":" + old.detail, /^invalid:unsupported attestation schema/);
  const ob = attestationBlock(bundleWith(e), old);
  assert.equal(ob.payload, null);
  assert.equal(ob.signature, null);
  // a valid attestation replayed onto a different bundle
  assert.match(v(VEC.envelope, {}, { ...bundleWith(VEC.envelope), collected_at: "2026-10-18T00:00:00Z" }), /^invalid:attestation is for a different bundle/);
  assert.match(v(VEC.envelope, {}, { ...bundleWith(VEC.envelope), entity_id: "other" }), /^invalid:attestation is for a different bundle/);
  // replay: older than the newest accepted for this entity
  assert.match(v(VEC.envelope, { lastSignedAt: "2026-10-17T13:00:00Z" }), /^invalid:replay/);
  assert.match(v(VEC.envelope, { lastSignedAt: VEC.envelope.signature.signed_at }), /^valid:/, "the same attestation seen again is fine");
  // stale and future
  assert.match(v(VEC.envelope, { now: new Date(SIGNED_AT + 37 * 3600 * 1000) }), /^stale:/);
  assert.match(v(VEC.envelope, { now: new Date(SIGNED_AT - 3600 * 1000) }), /^invalid:signing time is in the future/);
  // malformed and missing
  assert.match(v("garbage"), /^invalid:/);
  assert.match(v({ payload: 1 }), /^invalid:/);
  assert.match(v(null), /^invalid:/);
  assert.equal(verifyEnvelope(undefined, { entity_id: "dao" }, KEYS, { now: NOW }).status, "missing");
});

test("the report carries the signed payload unchanged, validates, and scores identically with or without it", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "golden", fs.readdirSync(path.join(__dirname, "fixtures", "golden")).sort()[0]), "utf8"));
  const bundle = { ...golden.input.bundle, entity_id: VEC.bundle.entity_id, collected_at: VEC.bundle.collected_at };
  const base = S.computeBase(bundle);
  const plain = buildReport(golden.input.entity, bundle, base, [base.nrt]);
  const env = clone(VEC.envelope);
  const verdict = verifyEnvelope(env, { ...bundle, attestation: env }, KEYS, { now: NOW });
  const withAtt = buildReport(golden.input.entity, { ...bundle, attestation: env }, base, [base.nrt], { attestation: verdict });
  const r = validateReport(withAtt);
  assert.ok(r.ok, r.errors.join("\n"));
  assert.equal(withAtt.attestation.verification_status, "valid");
  assert.deepEqual(withAtt.attestation.payload, VEC.envelope.payload, "payload passed through unchanged");
  assert.strictEqual(canonicalJson(withAtt.attestation.payload), VEC.canonical_payload, "byte-for-byte after the report pipeline");
  assert.equal(withAtt.attestation.payload_hash, VEC.envelope.payload_hash);
  assert.deepEqual(withAtt.attestation.signature, VEC.envelope.signature);
  assert.match(withAtt.attestation.statement, /cross-source comparisons were completed: .* Signed using Ed25519 by key tcs6-attest-.* Verification status: valid/);
  // attestation_layer != scoring_layer
  for (const k of ["overall_score", "dimensions", "hard_gates", "headline", "confidence", "data_coverage"]) {
    assert.deepEqual(withAtt[k], plain[k], `${k} unchanged by the attestation`);
  }
  // conflicts are preserved in what the caller receives
  const statuses = withAtt.attestation.payload.checks.map((c) => c.status);
  for (const st of ["conflicted", "failed", "unavailable", "not_applicable", "passed"]) assert.ok(statuses.includes(st), st);
  // a verdict of invalid still delivers the envelope (so the caller can see what failed) but says so
  const bad = buildReport(golden.input.entity, { ...bundle, attestation: env }, base, [base.nrt], { attestation: { status: "invalid", detail: "bad signature" } });
  assert.equal(bad.attestation.verification_status, "invalid");
  assert.ok(validateReport(bad).ok);
});

test("attestationBlock: absent without attestation or summary; malformed envelopes are labelled invalid", () => {
  assert.equal(attestationBlock({ entity_id: "x" }, { status: "missing", detail: "-" }), null);
  const m = attestationBlock({ verification_summary: {}, attestation: "nonsense" }, { status: "invalid", detail: "malformed envelope" });
  assert.equal(m.verification_status, "invalid");
  assert.equal(m.payload, null);
});
