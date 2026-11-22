// Independent witness (pocket-confidential Service 5): claims from bundles, the signed per-entity
// witness, the report block (attached unchanged, never scored) and the backend's send/poll cycle.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TCS6_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-witness-test-"));
process.env.TCS6_REGISTRY = path.join(process.env.TCS6_DATA_DIR, "registry.json");

const { canonicalJson } = require("../lib/canonical");
const W = require("../lib/witness");
const S = require("../lib/scoring");
const store = require("../lib/store");
const { buildReport } = require("../lib/report");
const { validateReport } = require("../lib/schema");

const HOLDER = "0x1111111111111111111111111111111111111111";
const CAPPED = "0x2222222222222222222222222222222222222222";
const USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";
const T = "2026-11-22T00:00:00.000Z";
const NOW = Date.parse(T) + 3600_000;

fs.writeFileSync(process.env.TCS6_REGISTRY, JSON.stringify({ entities: [
  { entity_id: "sky", scoreable: true, treasury_addresses: [
    { chain: "ethereum", address: HOLDER, role: "treasury" },
    { chain: "ethereum", address: CAPPED, role: "genesis_agent_subproxy", count_only: { USDS: 25000000 } }] },
  { entity_id: "rp", scoreable: true, treasury_addresses: [{ chain: "ethereum", address: HOLDER, role: "rocket_vault_balance" }] },
] }));

function holding(asset_id, extra = {}) {
  return { asset_id, control: "verified", bucket: "onchain", quantity: 10, holdings_observed_at: T, prices: [{ usd: 2 }], ...extra };
}
const BUNDLE = { entity_id: "sky", collected_at: T, holdings: [
  holding(`ethereum:${USDS}:${HOLDER}`),
  holding(`ethereum:native:${HOLDER}`),
  holding(`ethereum:${USDS}:${CAPPED}`),                // count_only cap: left out
  holding(`ethereum:${USDS}:${HOLDER}:sky_tag`),        // tagged reader: left out
  holding(`ethereum:${USDS}:${HOLDER}`, { control: "unverified" }),
  holding("offchain:tbills", { bucket: "offchain" }),
] };

function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { pub, sign: (w) => crypto.sign(null, Buffer.from(canonicalJson(w), "utf8"), privateKey).toString("hex") };
}
function entityWitness(k, over = {}) {
  const w = { schema: W.ENTITY_WITNESS_SCHEMA, task_set_id: "tcs6-beta-x", claims_sha256: "ab".repeat(32), tolerance_pct: 0.5, computed_at: "2026-11-22T01:00:00Z",
    acurast_job_id: "411669", acurast_origin: "22".repeat(32), artifact_digest: "sha256:" + "cd".repeat(32), job_ed25519_public_key: k.pub,
    entity: { entity_id: "sky", claims: 2, sampled: 2, match: 2, match_in_window: 0, differs: 0, unavailable: 0, checked_value_pct: 100, verdict: "confirmed" },
    checks: [{ ref: `ethereum:native:${HOLDER}`, status: "match", error: null }], ...over };
  return { witness: w, signature: k.sign(w) };
}

test("claims are plain verified on-chain balances; capped, tagged and special-reader holdings are left out", () => {
  const special = W.specialHolders(store.loadRegistry());
  assert.ok(special.has(`sky|ethereum:${CAPPED}`));
  assert.ok(special.has(`rp|ethereum:${HOLDER}`));
  assert.ok(!special.has(`sky|ethereum:${HOLDER}`), "special roles are per entity");
  const claims = W.claimsFrom(BUNDLE, special, NOW);
  assert.deepStrictEqual(claims.map((c) => c.ref), [`ethereum:${USDS}:${HOLDER}`, `ethereum:native:${HOLDER}`]);
  assert.strictEqual(claims[0].value_usd, 20);
  assert.strictEqual(claims[1].token, null);
  const { task_set, collected } = W.buildTaskSet([BUNDLE, { entity_id: "rp", collected_at: T, holdings: [holding(`ethereum:native:${HOLDER}`)] }], store.loadRegistry(), "beta", NOW);
  assert.deepStrictEqual(Object.keys(collected), ["sky"], "an entity with no plain claims is not sent");
  assert.match(task_set.task_set_id, /^tcs6-beta-\d{8}T\d{6}$/);
});

test("signed entity witness: verified, tampering refused", () => {
  const k = signer();
  const env = entityWitness(k);
  assert.strictEqual(W.verifyEntityWitness(env), null);
  assert.strictEqual(W.verifyEntityWitness({ ...env, witness: { ...env.witness, entity: { ...env.witness.entity, differs: 1 } } }), "bad signature");
  assert.strictEqual(W.verifyEntityWitness({ ...env, signature: signer().sign(env.witness) }), "bad signature");
  assert.match(W.verifyEntityWitness({ witness: { ...env.witness, schema: "x" }, signature: env.signature }), /schema/);
});

test("report block: attached unchanged for the exact bundle, pending for a newer one, never scored, schema-valid", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "golden", fs.readdirSync(path.join(__dirname, "fixtures", "golden")).sort()[0]), "utf8"));
  const bundle = { ...golden.input.bundle, entity_id: "sky", collected_at: T };
  const base = S.computeBase(bundle);
  const k = signer();
  const env = entityWitness(k);
  fs.mkdirSync(path.dirname(W.witnessPath("sky")), { recursive: true });
  fs.writeFileSync(W.witnessPath("sky"), JSON.stringify({ task_set_id: "tcs6-beta-x", evidence_collected_at: T, received_at: T, signed: env }));

  const block = W.witnessBlock("sky", bundle);
  assert.strictEqual(block.status, "confirmed");
  assert.strictEqual(block.signature_verified, true);
  assert.match(block.statement, /\(Acurast job 411669\) re-read 2 of this report's 2/);
  assert.match(block.statement, /Not used in scoring/);
  const plain = buildReport(golden.input.entity, bundle, base, [base.nrt]);
  const withW = buildReport(golden.input.entity, bundle, base, [base.nrt], { witness: block });
  assert.deepStrictEqual(validateReport(withW).errors, []);
  assert.deepStrictEqual(withW.independent_witness.signed, env, "signed witness reaches the caller unchanged");
  assert.strictEqual(W.verifyEntityWitness(JSON.parse(JSON.stringify(withW.independent_witness.signed))), null, "still verifies after JSON round trip");
  const strip = (r) => { const { report_id, independent_witness, ...rest } = r; return rest; };
  assert.deepStrictEqual(strip(withW), strip(plain), "nothing else in the report changes");
  assert.strictEqual(plain.independent_witness, undefined);

  const newer = { ...bundle, collected_at: "2026-11-22T04:00:00Z" };
  const pending = W.witnessBlock("sky", newer);
  assert.strictEqual(pending.status, "pending");
  assert.strictEqual(pending.signed, null);
  assert.deepStrictEqual(validateReport(buildReport(golden.input.entity, newer, S.computeBase(newer), [base.nrt], { witness: pending })).errors, []);

  fs.writeFileSync(W.witnessPath("sky"), JSON.stringify({ task_set_id: "x", evidence_collected_at: T, received_at: T, signed: { ...env, signature: "0".repeat(128) } }));
  assert.strictEqual(W.witnessBlock("sky", bundle), null, "a bad signature is never shown");
  assert.strictEqual(W.witnessBlock("nobody", bundle), null);
});

test("backend: changed entities are sent once after the quiet period, results checked and stored per entity", async () => {
  store.ensureDirs();
  store.writeJsonAtomic(store.paths.evidence("sky"), BUNDLE);
  const k = signer();
  const posted = [];
  let status = "queued";
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/peer/witness/tasks")) { posted.push(JSON.parse(init.body)); return new Response("{}", { status: 202 }); }
    if (status !== "done") return new Response(JSON.stringify({ status }), { status: 200 });
    return new Response(JSON.stringify({ status: "done", entity_witnesses: [entityWitness(k), entityWitness(k, { entity: { ...entityWitness(k).witness.entity, entity_id: "other" } }), { ...entityWitness(k), signature: "0".repeat(128) }] }), { status: 200 });
  };
  const logs = [];
  const c = W.createWitnessClient({ queue: "http://q:8091", network: "beta", fetchImpl, now: () => NOW, debounceMs: 60_000, log: (e, d) => logs.push([e, d]) });
  const id = await (c.noteAccepted(["sky"]), c.flush());
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].task_set.claims.length, 2);
  assert.strictEqual(await c.flush(), null, "nothing new: nothing sent");
  assert.strictEqual(await c.pollOnce(), 1, "still open while the job works");
  status = "done";
  try { fs.unlinkSync(W.witnessPath("sky")); } catch {}
  assert.strictEqual(await c.pollOnce(), 0);
  const stored = JSON.parse(fs.readFileSync(W.witnessPath("sky"), "utf8"));
  assert.strictEqual(stored.task_set_id, id);
  assert.strictEqual(stored.evidence_collected_at, T);
  assert.ok(!fs.existsSync(W.witnessPath("other")), "an entity that was not sent is ignored");
  assert.ok(logs.some(([e]) => e === "witness.rejected"), "a bad signature is rejected and logged");
});
