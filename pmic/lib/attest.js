// Verified layer, Phase 3: signed input attestations for PMIC series (owner decisions 2026-10-18).
//
// The collector (Pi) signs one attestation per series from the cross-checks in the confirmations
// table (lib/verify.js): the latest result of every check that concerns the series. Same format as
// the TCS-6 attestation 1.2 (counters that always add up, every check listed, review items, an
// evidence manifest and a statement), with its own Ed25519 key, separate from the TCS-6 key.
//
//   payload        deterministic object; canonical JSON (RFC 8785 for these value types) is what is hashed
//   payload_hash   "sha256:" + 64 lowercase hex of SHA-256(canonical payload)
//   signature      Ed25519 over the canonical signing record {alg, attestation_id, key_id, payload_hash, signed_at}
//   key_id         "pmic-attest-" + first 16 hex of SHA-256(raw 32-byte public key)
//
// Attestation only: it never changes a series, a score or a brief (owner 2026-10-18). Sources whose
// terms keep them internal (verify.INTERNAL_ONLY, e.g. ProPublica, D16) are never included.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("./canonical");
const { kvGet, kvSet } = require("./db");
const { ClientError } = require("./http");

const SCHEMA_VERSION = "pmic-attestation/1.1";
const METHOD_VERSION = "pmic-verify/1.5";
const ALG = "Ed25519";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_FILE = "attest_ed25519.pem";
const RESIGN_AFTER_MS = 24 * 3600 * 1000; // re-sign unchanged evidence daily so readers can tell fresh from stale

// Source-independence class of each comparison source. Only independent_economic_source is an independent
// confirmation of the figure; republication and transport checks confirm the copy or the read.
const CLASS_OF_SOURCE = {
  emsc: "independent_economic_source",
  chainlink: "partially_independent",
  imf: "partially_independent",
  fluview: "partially_independent",
  govinfo: "partially_independent",
  fred: "republication_check", bls: "republication_check", bea: "republication_check", treasury: "republication_check",
  nyfed: "republication_check", fiscaldata: "republication_check", eia: "republication_check", ecb: "republication_check",
  nvd: "republication_check",
  "pokt-lcd": "transport_corroboration",
};
const classOf = (source) => CLASS_OF_SOURCE[source] || (source.startsWith("rpc:") ? "transport_corroboration" : "unclassified");
const INDEPENDENCE = {
  independent_economic_source: "a different organisation measuring the same thing with its own network or method",
  partially_independent: "a different source or method that may share inputs with ours (a DEX pool against an oracle that aggregates markets; two agencies' estimates; two surveillance systems); not fully independent",
  republication_check: "the original publisher's figure against the copy we serve (FRED against BLS, BEA, Treasury, EIA, the New York Fed); confirms the copy, not the figure",
  transport_corroboration: "the same chain or ledger state read through a second node or API; confirms retrieval, not economic truth",
  unclassified: "a second source not yet classified",
};
const STATUS_OF = { agree: "passed", partial: "partial", disagree: "conflicted", unavailable: "unavailable" };
const SCORE_BOUNDARY = "attestation only: these checks report on the inputs of the series and do not change any PMIC value, score or brief.";
const CONFLICT_POLICY = "conflicts and unavailable sources are preserved and flagged, never resolved automatically and never replaced by the other source's value.";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256hex = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
const keyIdOf = (raw) => "pmic-attest-" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
const rawPublic = (keyObject) => keyObject.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);

// ---- keys --------------------------------------------------------------------------------------
function keyPath(dataDir) {
  return path.join(dataDir, KEY_FILE);
}

// Creates the private key once (mode 600). Returns only public facts; never the private key.
function keygen(dataDir) {
  const p = keyPath(dataDir);
  let priv;
  let created = false;
  if (fs.existsSync(p)) {
    priv = crypto.createPrivateKey(fs.readFileSync(p, "utf8"));
  } else {
    const kp = crypto.generateKeyPairSync("ed25519");
    priv = kp.privateKey;
    fs.writeFileSync(p, priv.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    created = true;
  }
  const raw = rawPublic(crypto.createPublicKey(priv));
  return { key_id: keyIdOf(raw), alg: ALG, public_key_b64url: b64u(raw), created };
}

function loadPrivate(dataDir) {
  const p = keyPath(dataDir);
  return fs.existsSync(p) ? crypto.createPrivateKey(fs.readFileSync(p, "utf8")) : null;
}

// ---- payload -----------------------------------------------------------------------------------
// The series a confirmation row concerns, or null (rows about records, e.g. Form 990, are not series).
function seriesOfRow(row, feedSeries) {
  if (row.field.startsWith("series:")) return row.field.slice("series:".length);
  if (row.field.startsWith("rpc.total_supply:")) {
    try { return JSON.parse(row.our_value).series_id || null; } catch { return null; }
  }
  if (row.field.startsWith("pokt.live:")) return feedSeries.get(row.field.slice("pokt.live:".length)) || null;
  return null;
}

function checkOf(row, label) {
  const source = row.upstream_service;
  const our = row.our_value ? JSON.parse(row.our_value) : null;
  const tol = row.tolerance_pct;
  const rule = row.agreement === "unavailable" && tol === null ? "second source unavailable"
    : tol === null ? "passed if both move in the same direction week over week (a change under 5% of the prior value is flat); partial if one is flat"
    : tol === 0 ? "passed if both sources return the identical value"
    : `passed if within ${tol}% (or the check's absolute tolerance); partial within the wider tolerance for sources whose methods differ`;
  const check = {
    check_id: `${row.field}|${source}`,
    field: row.field,
    label,
    primary_source: "pmic",
    comparison_source: source,
    independence: classOf(source),
    rule,
    status: STATUS_OF[row.agreement],
    pmic_value: our,
    comparison_reading_sha256: row.upstream_value_hash ? `sha256:${row.upstream_value_hash}` : null,
    comparison_reading_disclosed: false,
    delta_pct: row.delta_pct,
    tolerance_pct: tol,
    observed_at: row.observed_at,
    run_id: row.run_id,
  };
  return { ...check, evidence_hash: sha256hex(canonicalJson(check)) };
}

function counters(checks) {
  const c = { attempted: checks.length };
  for (const st of ["passed", "partial", "conflicted", "unavailable"]) c[st] = checks.filter((x) => x.status === st).length;
  c.completed = c.passed + c.partial + c.conflicted;
  c.requiring_review = c.conflicted;
  return c;
}

function statement(p) {
  const c = p.counters;
  const conflicted = p.checks.filter((x) => x.status === "conflicted").map((x) => `${x.comparison_source} (${x.check_id})`);
  const unavailable = p.checks.filter((x) => x.status === "unavailable").map((x) => x.comparison_source);
  const all = c.attempted === 1 ? (c.completed ? "One check was" : "No check was")
    : c.completed === c.attempted ? `All ${c.attempted} checks were` : `${c.completed} of ${c.attempted} checks were`;
  const when = p.window.first === p.window.last ? `at ${p.window.first}` : `from ${p.window.first} through ${p.window.last} UTC`;
  const were = (n) => (n === 1 ? "was" : "were");
  return `Attestation of cross-source checks on the PMIC series ${p.subject.series_id} (primary reading: the PMIC value) performed ${when} ` +
    `under method version ${p.method_version}. ${all} completed: ${c.passed} passed, ${c.partial} ${were(c.partial)} within the wider tolerance, ` +
    `${c.conflicted} conflicted, and ${c.unavailable} ${were(c.unavailable)} unavailable.` +
    (conflicted.length ? ` Conflicted: ${conflicted.join("; ")}.` : "") +
    (unavailable.length ? ` Unavailable: ${unavailable.join("; ")}.` : "") +
    " Each check records the PMIC value, the comparison source's reading as a SHA-256 commitment rather than the source payload, the " +
    "tolerance, the result, and the source-independence classification. Only independent_economic_source represents an independent confirmation of the " +
    "figure; republication and transport checks confirm only the copied value or the data retrieval. Because the comparison reading is not " +
    "included, its digest commits to that reading but does not by itself permit the reading to be independently reconstructed. Conflicts and unavailable " +
    "sources are preserved and never resolved automatically. " +
    `This attestation does not change any PMIC value, score, or brief. Review required: ${c.requiring_review ? "yes" : "no"}. ` +
    `Evidence manifest SHA-256: ${p.evidence_manifest_hash.slice("sha256:".length)}.`;
}

// Payloads for every series that has at least one check: Map series_id -> payload.
function buildPayloads(db, catalog, { internalOnly = new Set() } = {}) {
  const series = new Map(catalog.series.map((s) => [s.series_id, s]));
  const feedSeries = new Map(catalog.series.filter((s) => s.source_id === "pokt" && s.params && s.params.feed).map((s) => [s.params.feed, s.series_id]));
  const rows = db.prepare(`SELECT c.* FROM confirmations c JOIN (SELECT field, upstream_service, MAX(id) AS id FROM confirmations
      GROUP BY field, upstream_service) l ON c.id = l.id ORDER BY c.field, c.upstream_service`).all();
  const by = new Map();
  for (const r of rows) {
    if (internalOnly.has(r.upstream_service)) continue;
    const sid = seriesOfRow(r, feedSeries);
    if (!sid || !series.has(sid)) continue;
    if (!by.has(sid)) by.set(sid, []);
    by.get(sid).push(r);
  }
  const latestObs = db.prepare("SELECT observation_time FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1");
  const out = new Map();
  for (const [sid, list] of by) {
    const s = series.get(sid);
    const checks = list.map((r) => checkOf(r, s.label || sid)).sort((a, b) => (a.check_id < b.check_id ? -1 : 1));
    const times = checks.map((c) => c.observed_at).sort();
    const manifest = checks.map((c) => ({ check_id: c.check_id, evidence_hash: c.evidence_hash }));
    const obs = latestObs.get(sid);
    const p = {
      type: "pmic-input-attestation",
      schema_version: SCHEMA_VERSION,
      method_version: METHOD_VERSION,
      subject: { service: "pmic", series_id: sid, entity_id: s.entity_id, latest_observation_time: obs ? obs.observation_time : null },
      window: { first: times[0], last: times[times.length - 1] },
      counters: counters(checks),
      independence_classes: INDEPENDENCE,
      conflict_policy: CONFLICT_POLICY,
      score_boundary: SCORE_BOUNDARY,
      checks,
      review_items: { conflicted_check_ids: checks.filter((c) => c.status === "conflicted").map((c) => c.check_id),
        unavailable_check_ids: checks.filter((c) => c.status === "unavailable").map((c) => c.check_id) },
      review_required: checks.some((c) => c.status === "conflicted"),
      evidence_manifest: manifest,
      evidence_manifest_hash: sha256hex(canonicalJson(manifest)),
    };
    p.attestation_id = "att-" + crypto.createHash("sha256").update(`pmic|${sid}|${p.evidence_manifest_hash}`).digest("hex").slice(0, 24);
    p.statement = statement(p);
    out.set(sid, p);
  }
  return out;
}

// ---- sign / verify -----------------------------------------------------------------------------
function sign(payload, privateKey, signedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
  const raw = rawPublic(crypto.createPublicKey(privateKey));
  const record = { alg: ALG, attestation_id: payload.attestation_id, key_id: keyIdOf(raw), payload_hash: sha256hex(canonicalJson(payload)), signed_at: signedAt };
  const value = crypto.sign(null, Buffer.from(canonicalJson(record), "utf8"), privateKey);
  return { payload, payload_hash: record.payload_hash,
    signature: { alg: ALG, key_id: record.key_id, signed_at: signedAt, attestation_id: record.attestation_id, value: b64u(value), value_encoding: "base64url" } };
}

// {key_id: KeyObject} from [{key_id, alg, public_key_b64url}]; an id that doesn't match its key is ignored.
function keysFrom(list) {
  const out = {};
  for (const k of list || []) {
    if (!k || k.alg !== ALG || typeof k.public_key_b64url !== "string") continue;
    const raw = Buffer.from(k.public_key_b64url, "base64url");
    if (raw.length !== 32 || keyIdOf(raw) !== k.key_id) continue;
    out[k.key_id] = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  }
  return out;
}

const MAX_AGE_H = 72;
// -> {status: valid|stale|invalid, detail}
function verifyEnvelope(env, seriesId, keys, now = new Date()) {
  try {
    if (!env || typeof env !== "object" || !env.payload || !env.signature) return { status: "invalid", detail: "malformed envelope" };
    const p = env.payload;
    const sig = env.signature;
    if (p.schema_version !== SCHEMA_VERSION) return { status: "invalid", detail: `unsupported schema ${String(p.schema_version).slice(0, 40)}` };
    if (sig.alg !== ALG || sig.value_encoding !== "base64url") return { status: "invalid", detail: "unsupported signature" };
    if (sha256hex(canonicalJson(p)) !== env.payload_hash) return { status: "invalid", detail: "payload hash mismatch" };
    if (sig.attestation_id !== p.attestation_id) return { status: "invalid", detail: "attestation id mismatch" };
    if (!p.subject || p.subject.series_id !== seriesId) return { status: "invalid", detail: "attestation is for another series" };
    const key = keys[sig.key_id];
    if (!key) return { status: "invalid", detail: `unknown key ${String(sig.key_id).slice(0, 40)}` };
    const record = { alg: ALG, attestation_id: sig.attestation_id, key_id: sig.key_id, payload_hash: env.payload_hash, signed_at: sig.signed_at };
    if (!crypto.verify(null, Buffer.from(canonicalJson(record), "utf8"), key, Buffer.from(sig.value, "base64url"))) return { status: "invalid", detail: "bad signature" };
    const t = Date.parse(sig.signed_at);
    if (!Number.isFinite(t)) return { status: "invalid", detail: "unreadable signing time" };
    if (t > now.getTime() + 5 * 60 * 1000) return { status: "invalid", detail: "signing time is in the future" };
    if (now.getTime() - t > MAX_AGE_H * 3.6e6) return { status: "stale", detail: `signed more than ${MAX_AGE_H} h ago` };
    return { status: "valid", detail: `signature verified with key ${sig.key_id}` };
  } catch (e) {
    return { status: "invalid", detail: `malformed: ${String(e && e.message).slice(0, 80)}` };
  }
}

// ---- collector side: sign what changed, push to the hub ----------------------------------------
// Signs a series when its payload changed (new evidence, or new wording) or its last signature is a day old. Returns the
// envelopes to push (only those signed now); state in kv "attest:<series_id>".
function signDue(db, catalog, dataDir, { now = new Date(), internalOnly = new Set() } = {}) {
  const priv = loadPrivate(dataDir);
  if (!priv) return { signed: [], skipped: "no signing key (node bin/collect.js --attest-keygen)" };
  const signed = [];
  for (const [sid, payload] of buildPayloads(db, catalog, { internalOnly })) {
    const st = kvGet(db, `attest:${sid}`);
    const payloadHash = sha256hex(canonicalJson(payload));
    const fresh = st && (st.payload_hash ? st.payload_hash === payloadHash : st.manifest === payload.evidence_manifest_hash)
      && now.getTime() - Date.parse(st.signed_at) < RESIGN_AFTER_MS;
    if (fresh) continue;
    const env = sign(payload, priv, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
    kvSet(db, `attest:${sid}`, { manifest: payload.evidence_manifest_hash, payload_hash: payloadHash, signed_at: env.signature.signed_at, attestation_id: payload.attestation_id, pushed: false, envelope: env });
    signed.push(sid);
  }
  return { signed };
}

function pending(db) {
  return db.prepare("SELECT k, v FROM kv WHERE k LIKE 'attest:%'").all().map((r) => [r.k.slice(7), JSON.parse(r.v)]).filter(([, v]) => !v.pushed);
}

function markPushed(db, ids) {
  for (const id of ids) {
    const st = kvGet(db, `attest:${id}`);
    if (st) kvSet(db, `attest:${id}`, { ...st, pushed: true });
  }
}

// ---- hub side ----------------------------------------------------------------------------------
function storeEnvelopes(db, envelopes, keys, now = new Date()) {
  if (!Array.isArray(envelopes)) throw new ClientError(400, "invalid_input", "body needs attestations[]");
  const up = db.prepare(`INSERT INTO attestations (series_id, attestation_id, signed_at, envelope_json, received_at) VALUES (?,?,?,?,?)
    ON CONFLICT (series_id) DO UPDATE SET attestation_id=excluded.attestation_id, signed_at=excluded.signed_at, envelope_json=excluded.envelope_json, received_at=excluded.received_at
    WHERE excluded.signed_at >= attestations.signed_at`);
  let accepted = 0;
  const rejected = [];
  for (const env of envelopes) {
    const sid = env && env.payload && env.payload.subject && env.payload.subject.series_id;
    const v = verifyEnvelope(env, sid, keys, now);
    if (v.status !== "valid") { rejected.push({ series_id: sid || null, reason: v.detail }); continue; }
    up.run(sid, env.payload.attestation_id, env.signature.signed_at, JSON.stringify(env), now.toISOString());
    accepted++;
  }
  return { accepted, rejected };
}

function query(db, body) {
  const ids = Array.isArray(body && body.series_ids) ? body.series_ids.filter((x) => typeof x === "string").slice(0, 200) : null;
  if (!ids) throw new ClientError(400, "invalid_input", "field 'series_ids' (array) is required");
  const out = {};
  if (ids.length) {
    for (const r of db.prepare(`SELECT series_id, envelope_json FROM attestations WHERE series_id IN (${ids.map(() => "?").join(",")})`).all(...ids)) {
      out[r.series_id] = JSON.parse(r.envelope_json);
    }
  }
  return { attestations: out };
}

function loadKeysFile(file = path.join(__dirname, "..", "config", "attestation_keys.json")) {
  try {
    return keysFrom(JSON.parse(fs.readFileSync(file, "utf8")).keys);
  } catch {
    return {};
  }
}

module.exports = { SCHEMA_VERSION, METHOD_VERSION, MAX_AGE_H, CLASS_OF_SOURCE, keygen, keyIdOf, buildPayloads, sign, keysFrom, loadKeysFile,
  verifyEnvelope, signDue, pending, markPushed, storeEnvelopes, query };
