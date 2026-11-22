// Independent witness (pocket-confidential Service 5, phase 1): a Liskov job re-reads a sample of
// the verified on-chain holdings in our evidence bundles, straight from the chain, and signs what it
// found. Never used in scoring.
//
// Backend (ingest): after the Pi's bundles are accepted, the entities that changed are collected for
// TCS6_WITNESS_DEBOUNCE_MIN (default 10) minutes after the last push, then sent as one task set of
// claims to the pocket-confidential queue's internal peer API (TCS6_WITNESS_QUEUE). The result is
// polled; each entity's signed witness is checked and stored as witness/<entity_id>.json together with
// the collected_at of the bundle it re-read. Off when TCS6_WITNESS_QUEUE is unset.
//
// Pipeline: witnessBlock() attaches the stored witness to the report only when it covers the exact
// bundle being scored; a newer bundle not yet re-read shows as "pending".
//
// Claims are public treasury data (registry addresses, quantities, observation times). Only plain
// balances are claims: holdings read another way (count_only caps, the Sky surplus buffer, RocketVault
// ledgers, Compound market reserves, tagged positions) would differ from balanceOf by design.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("./canonical");
const store = require("./store");

const ENTITY_WITNESS_SCHEMA = "pocket-confidential-entity-witness/0.1";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const VERDICTS = new Set(["confirmed", "partial", "differs", "unavailable", "not_checked"]);
const VERIFY_HOW = "Check the signature and repeat every read at its recorded block: node tools/verify-witness.mjs report.json " +
  "(https://github.com/organiccryptoyyc/pocket-agentic-services, pocket-confidential-queue). Check the job key on chain without a Liskov " +
  "account: https://docs.proof.computer/liskov/operate/verify-job-keys (acurast_origin, acurast_job_id, job_ed25519_public_key, artifact_digest).";

const witnessDir = () => path.join(store.DATA_DIR, "witness");
const witnessPath = (id) => path.join(witnessDir(), `${id}.json`);
const pendingPath = () => path.join(witnessDir(), "pending.json");

function specialHolders(entities) {
  const out = new Set();
  for (const e of entities || []) for (const a of e.treasury_addresses || []) {
    if (!a || typeof a.address !== "string") continue;
    const role = String(a.role || "");
    if (a.count_only || role === "vow_surplus_buffer" || role === "rocket_vault_balance" || (role.startsWith("comet_") && role.endsWith("_reserves"))) {
      out.add(`${e.entity_id}|${a.chain}:${a.address.toLowerCase()}`);
    }
  }
  return out;
}

function claimsFrom(bundle, special, now) {
  const out = [];
  for (const h of (bundle && bundle.holdings) || []) {
    if (h.control !== "verified" || h.bucket !== "onchain" || typeof h.asset_id !== "string") continue;
    const parts = h.asset_id.split(":");
    if (parts.length !== 3) continue;
    const [chain, tok, holder] = parts;
    const token = tok === "native" ? null : tok;
    if (!ADDR.test(holder) || (token !== null && !ADDR.test(token))) continue;
    if (special.has(`${bundle.entity_id}|${chain}:${holder.toLowerCase()}`)) continue;
    const t = Date.parse(h.holdings_observed_at);
    if (!Number.isFinite(t) || now - t > 30 * 86400_000 || typeof h.quantity !== "number" || !(h.quantity >= 0)) continue;
    const usd = h.prices && h.prices[0] && typeof h.prices[0].usd === "number" ? h.prices[0].usd : null;
    out.push({ ref: h.asset_id, entity_id: bundle.entity_id, chain, holder, token, quantity: h.quantity,
      value_usd: usd == null ? null : Math.round(h.quantity * usd * 100) / 100, observed_at: new Date(t).toISOString() });
  }
  return out;
}

function buildTaskSet(bundles, entities, network, now) {
  const special = specialHolders(entities);
  const claims = [];
  const collected = {};
  for (const b of bundles) {
    const c = claimsFrom(b, special, now);
    if (c.length) { claims.push(...c); collected[b.entity_id] = b.collected_at; }
  }
  const stamp = new Date(now).toISOString().replace(/[^0-9T]/g, "").slice(0, 15);
  return { task_set: { task_set_id: `tcs6-${network}-${stamp}`, network, source: `treasury-capital-score${network === "main" ? "" : "-beta"}`, claims }, collected };
}

function verifyEntityWitness(env) {
  const w = env && env.witness;
  if (!w || typeof env.signature !== "string") return "witness and signature are required";
  if (w.schema !== ENTITY_WITNESS_SCHEMA) return "unknown witness schema";
  if (!w.entity || !VERDICTS.has(w.entity.verdict) || !Array.isArray(w.checks)) return "witness has no entity verdict or checks";
  if (!/^[0-9a-f]{64}$/.test(String(w.job_ed25519_public_key)) || !/^[0-9a-f]{128}$/.test(env.signature)) return "bad key or signature format";
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(w.job_ed25519_public_key, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(canonicalJson(w), "utf8"), key, Buffer.from(env.signature, "hex")) ? null : "bad signature";
  } catch {
    return "bad signature";
  }
}

// --- backend: collect, send, poll ---------------------------------------------------------
function createWitnessClient({ queue, network, fetchImpl = fetch, now = () => Date.now(), debounceMs, maxHoldMs = 2 * 3600_000, pollMs = 60_000, maxWaitMs = 60 * 60_000, log = () => {} }) {
  const debounce = debounceMs ?? Number(process.env.TCS6_WITNESS_DEBOUNCE_MIN || 10) * 60_000;
  let dirty = new Set();
  let firstDirtyAt = null;
  let timer = null;
  let polling = null;

  function readPending() { return store.readJson(pendingPath()); }
  function writePending(p) { fs.mkdirSync(witnessDir(), { recursive: true }); store.writeJsonAtomic(pendingPath(), p); }

  async function flush() {
    timer = null;
    const ids = [...dirty];
    dirty = new Set();
    firstDirtyAt = null;
    if (!ids.length) return null;
    const bundles = ids.map((id) => store.readJson(store.paths.evidence(id))).filter(Boolean);
    const { task_set, collected } = buildTaskSet(bundles, store.loadRegistry(), network, now());
    if (!task_set.claims.length) { log("witness.skip", { reason: "no plain-balance claims", entities: ids.length }); return null; }
    const r = await fetchImpl(`${queue}/peer/witness/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_set }) });
    if (r.status !== 202 && r.status !== 200) { log("witness.post_failed", { status: r.status }); return null; }
    const prev = readPending() || { sets: [] };
    prev.sets = [...prev.sets.filter((s) => now() - Date.parse(s.posted_at) < maxWaitMs), { task_set_id: task_set.task_set_id, collected, posted_at: new Date(now()).toISOString() }];
    writePending(prev);
    log("witness.posted", { task_set_id: task_set.task_set_id, claims: task_set.claims.length, entities: Object.keys(collected).length });
    startPolling();
    return task_set.task_set_id;
  }

  async function pollOnce() {
    const p = readPending();
    if (!p || !p.sets.length) return 0;
    const keep = [];
    for (const s of p.sets) {
      if (now() - Date.parse(s.posted_at) > maxWaitMs) { log("witness.gave_up", { task_set_id: s.task_set_id }); continue; }
      let body;
      try {
        const r = await fetchImpl(`${queue}/peer/witness/result?task_set_id=${encodeURIComponent(s.task_set_id)}`);
        body = await r.json();
      } catch { keep.push(s); continue; }
      if (body.status === "queued" || body.status === "working") { keep.push(s); continue; }
      if (body.status !== "done") { log("witness.failed", { task_set_id: s.task_set_id, status: body.status }); continue; }
      let stored = 0;
      for (const env of body.entity_witnesses || []) {
        const id = env && env.witness && env.witness.entity && env.witness.entity.entity_id;
        if (!id || !(id in s.collected)) continue;
        const problem = verifyEntityWitness(env);
        if (problem) { log("witness.rejected", { task_set_id: s.task_set_id, entity_id: id, problem }); continue; }
        fs.mkdirSync(witnessDir(), { recursive: true });
        store.writeJsonAtomic(witnessPath(id), { task_set_id: s.task_set_id, evidence_collected_at: s.collected[id], received_at: new Date(now()).toISOString(), signed: env });
        stored++;
      }
      log("witness.stored", { task_set_id: s.task_set_id, entities: stored });
    }
    writePending({ sets: keep });
    return keep.length;
  }

  function startPolling() {
    if (polling) return;
    polling = setInterval(() => {
      pollOnce().then((open) => { if (!open) { clearInterval(polling); polling = null; } }).catch((e) => log("witness.poll_error", { error: String(e.message).slice(0, 120) }));
    }, pollMs);
    if (polling.unref) polling.unref();
  }

  return {
    noteAccepted(ids) {
      for (const id of ids) dirty.add(id);
      if (!ids.length) return;
      firstDirtyAt = firstDirtyAt ?? now();
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(debounce, firstDirtyAt + maxHoldMs - now()));
      timer = setTimeout(() => flush().catch((e) => log("witness.post_error", { error: String(e.message).slice(0, 120) })), wait);
      if (timer.unref) timer.unref();
    },
    flush, pollOnce, startPolling,
    resume() { const p = readPending(); if (p && p.sets && p.sets.length) startPolling(); },
  };
}

function startWitness(log) {
  const queue = process.env.TCS6_WITNESS_QUEUE;
  if (!queue) return null;
  const network = process.env.TCS6_NETWORK === "main" ? "main" : "beta";
  const client = createWitnessClient({ queue: queue.replace(/\/$/, ""), network, log });
  client.resume();
  log("witness.enabled", { network });
  return client;
}

// --- pipeline: the report block -----------------------------------------------------------
function witnessBlock(entityId, bundle) {
  const stored = store.readJson(witnessPath(entityId));
  if (!stored || !bundle) return null;
  if (stored.evidence_collected_at !== bundle.collected_at) {
    return {
      status: "pending",
      statement: `The evidence collected ${bundle.collected_at} has not been re-read by the independent witness yet; the last witness covered evidence collected ${stored.evidence_collected_at}. Not used in scoring.`,
      evidence_collected_at: bundle.collected_at, witnessed_at: null,
      sampled: 0, match: 0, match_in_window: 0, differs: 0, unavailable: 0, checked_value_pct: null,
      signature_verified: false, verify_with: VERIFY_HOW, signed: null,
    };
  }
  if (verifyEntityWitness(stored.signed)) return null;
  const w = stored.signed.witness;
  const e = w.entity;
  const statement =
    `A Liskov job (Acurast job ${w.acurast_job_id}) re-read ${e.sampled} of this report's ${e.claims} plain on-chain balances straight from the chain at the blocks they were observed: ` +
    `${e.match + e.match_in_window} matched within ${w.tolerance_pct}%, ${e.differs} differed, ${e.unavailable} could not be read` +
    (e.checked_value_pct == null ? "." : `, covering ${e.checked_value_pct}% of their value.`) +
    ` It confirms those holdings existed at those blocks; it does not confirm prices, control, obligations or the score. Not used in scoring.`;
  return {
    status: e.verdict,
    statement,
    evidence_collected_at: stored.evidence_collected_at,
    witnessed_at: w.computed_at,
    sampled: e.sampled, match: e.match, match_in_window: e.match_in_window, differs: e.differs, unavailable: e.unavailable,
    checked_value_pct: e.checked_value_pct,
    signature_verified: true,
    verify_with: VERIFY_HOW,
    signed: stored.signed,
  };
}

module.exports = { ENTITY_WITNESS_SCHEMA, specialHolders, claimsFrom, buildTaskSet, verifyEntityWitness, createWitnessClient, startWitness, witnessBlock, witnessPath, pendingPath };
