// node --test test/queue.test.js   (no network beyond 127.0.0.1)
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { createApp } = require("../server");
const { canonical, sha256hex, PROTOCOL, CIPHER, EVIDENCE_SCHEMA } = require("../lib/verify");

const TOKEN = "j".repeat(48);

function jobKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { pub, sign: (s) => crypto.sign(null, Buffer.from(s, "utf8"), privateKey).toString("hex") };
}

function announcement(k, encKey, now) {
  const a = {
    protocol: PROTOCOL, cipher: CIPHER, application_id: "app-x", deployment_id: "dep-1", acurast_job_id: "job-1", processor: "p-1",
    artifact_digest: "sha256:ab", policy_digest: "cd", job_ed25519_public_key: k.pub, encryption_public_key: encKey,
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 6 * 3600_000).toISOString(),
  };
  return { announcement: a, signature: k.sign(canonical(a)) };
}

function sealedRequest(to, id) {
  return { protocol: PROTOCOL, cipher: CIPHER, service: "treasury-stress", request_id: id, to, ephemeral_public_key: "AAAA", iv: "BBBB", ciphertext: "CCCC", tag: "DDDD", input_commitment: sha256hex(id) };
}

function seal(k, req, result) {
  const evidence = { schema: EVIDENCE_SCHEMA, service: req.service, service_version: "0.1.0", request_id: req.request_id, input_commitment: req.input_commitment, output_hash: sha256hex(canonical(result)), job_ed25519_public_key: k.pub };
  return { result, evidence, signature: k.sign(canonical({ result, evidence })) };
}

async function start(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-"));
  const app = createApp({ dataDir: dir, jobToken: TOKEN, now });
  await new Promise((r) => app.publicServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => app.jobServer.listen(0, "127.0.0.1", r));
  const pub = `http://127.0.0.1:${app.publicServer.address().port}`;
  const job = `http://127.0.0.1:${app.jobServer.address().port}`;
  const call = async (base, method, p, body, auth) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, dir, pub: (m, p, b) => call(pub, m, p, b), job: (m, p, b, auth = TOKEN) => call(job, m, p, b, auth), close: () => { app.publicServer.close(); app.jobServer.close(); } };
}

const ENC = "x".repeat(43);

test("full cycle: key, submit, lease, sealed result, read back", async () => {
  let t = Date.parse("2026-11-20T00:00:00Z");
  const q = await start(() => t);
  try {
    assert.strictEqual((await q.pub("GET", "/v1/key")).status, 503, "no key before the job announces");
    const k = jobKey();
    assert.strictEqual((await q.job("POST", "/job/keys", announcement(k, ENC, t), "wrong-token-wrong-token-wrong-token")).status, 401);
    assert.strictEqual((await q.job("POST", "/job/keys", announcement(k, ENC, t))).status, 200);
    const key = await q.pub("GET", "/v1/key");
    assert.strictEqual(key.body.announcement.encryption_public_key, ENC);

    const req = sealedRequest(ENC, "a".repeat(24));
    const sub = await q.pub("POST", "/v1/submit", { request: req });
    assert.strictEqual(sub.status, 202);
    assert.strictEqual((await q.pub("POST", "/v1/submit", { request: req })).status, 409, "duplicate request_id refused");
    assert.strictEqual((await q.pub("POST", "/v1/result", { request_id: req.request_id })).body.status, "queued");

    const leased = await q.job("GET", `/job/requests?to=${ENC}&max=5`);
    assert.deepStrictEqual(leased.body.requests.map((r) => r.request_id), [req.request_id]);
    assert.strictEqual((await q.pub("POST", "/v1/result", { request_id: req.request_id })).body.status, "working");
    assert.strictEqual((await q.job("GET", `/job/requests?to=${ENC}`)).body.requests.length, 0, "leased requests are not handed out twice");

    // A result signed by another key, or for another input, is refused.
    const other = jobKey();
    assert.strictEqual((await q.job("POST", "/job/results", { request_id: req.request_id, sealed: seal(other, req, { status: "within_limits" }) })).status, 400);
    const wrongInput = seal(k, { ...req, input_commitment: sha256hex("other") }, { status: "x" });
    assert.match((await q.job("POST", "/job/results", { request_id: req.request_id, sealed: wrongInput })).body.error.message, /different input/);

    const good = seal(k, req, { status: "within_limits", scenarios: [] });
    assert.strictEqual((await q.job("POST", "/job/results", { request_id: req.request_id, sealed: good })).status, 200);
    const done = await q.pub("POST", "/v1/result", { request_id: req.request_id });
    assert.strictEqual(done.body.status, "done");
    assert.deepStrictEqual(done.body.sealed, good);

    // Nothing on disk but ciphertext, commitments and signed results.
    const disk = fs.readFileSync(path.join(q.dir, "queue-state.json"), "utf8");
    assert.ok(!/private|secret|token/i.test(disk));
  } finally {
    q.close();
  }
});

test("forged or expired announcements are refused; stale keys and bad requests too", async () => {
  let t = Date.parse("2026-11-20T00:00:00Z");
  const q = await start(() => t);
  try {
    const k = jobKey();
    const a = announcement(k, ENC, t);
    const forged = { ...a, announcement: { ...a.announcement, encryption_public_key: "y".repeat(43) } };
    assert.match((await q.job("POST", "/job/keys", forged)).body.error.message, /bad announcement signature/);
    const old = announcement(k, ENC, t - 7 * 3600_000);
    assert.match((await q.job("POST", "/job/keys", old)).body.error.message, /expired/);

    await q.job("POST", "/job/keys", a);
    assert.strictEqual((await q.pub("POST", "/v1/submit", { request: sealedRequest("z".repeat(43), "b".repeat(24)) })).body.error.code, "stale_key");
    assert.strictEqual((await q.pub("POST", "/v1/submit", { request: { ...sealedRequest(ENC, "c".repeat(24)), input_commitment: "nope" } })).status, 400);
    assert.strictEqual((await q.job("GET", `/job/requests?to=${"z".repeat(43)}`)).body.error.code, "unknown_key");
  } finally {
    q.close();
  }
});

test("an unfinished lease comes back after 2 minutes; errors are stored as codes", async () => {
  let t = Date.parse("2026-11-20T00:00:00Z");
  const q = await start(() => t);
  try {
    const k = jobKey();
    await q.job("POST", "/job/keys", announcement(k, ENC, t));
    const req = sealedRequest(ENC, "d".repeat(24));
    await q.pub("POST", "/v1/submit", { request: req });
    assert.strictEqual((await q.job("GET", `/job/requests?to=${ENC}`)).body.requests.length, 1);
    t += 121_000;
    assert.strictEqual((await q.job("GET", `/job/requests?to=${ENC}`)).body.requests.length, 1, "lease expired, handed out again");
    await q.job("POST", "/job/results", { request_id: req.request_id, error: { code: "decrypt_failed", message: null } });
    const r = await q.pub("POST", "/v1/result", { request_id: req.request_id });
    assert.deepStrictEqual([r.body.status, r.body.error.code], ["error", "decrypt_failed"]);
  } finally {
    q.close();
  }
});

test("signals: public briefs ride along with leased work, cached, failures marked unavailable", async () => {
  const { createSignals } = require("../lib/signals");
  let calls = 0;
  const src = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      calls++;
      const { vertical } = JSON.parse(b);
      if (vertical === "broken") { res.writeHead(503); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "pmic-macro-signals", vertical, status: "ok", score: 42, label: "moderate", trend: "flat", confidence: { score: 70, label: "medium" }, verified: { as_of: "2026-11-01" } }));
    });
  });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  let t = Date.parse("2026-11-20T00:00:00Z");
  const signals = createSignals({ sources: [{ service: "pmic-macro-signals", base: `http://127.0.0.1:${src.address().port}`, verticals: ["macro-regime", "broken"] }], now: () => t });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-"));
  const app = createApp({ dataDir: dir, jobToken: TOKEN, now: () => t, signals });
  await new Promise((r) => app.publicServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => app.jobServer.listen(0, "127.0.0.1", r));
  const pub = `http://127.0.0.1:${app.publicServer.address().port}`;
  const job = `http://127.0.0.1:${app.jobServer.address().port}`;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
  try {
    const k = jobKey();
    await fetch(`${job}/job/keys`, { method: "POST", headers: H, body: JSON.stringify(announcement(k, ENC, t)) });
    // No work: no signals fetched.
    const empty = await (await fetch(`${job}/job/requests?to=${ENC}`, { headers: H })).json();
    assert.strictEqual(empty.signals, null);
    assert.strictEqual(calls, 0);
    await fetch(`${pub}/v1/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: sealedRequest(ENC, "e".repeat(24)) }) });
    const got = await (await fetch(`${job}/job/requests?to=${ENC}`, { headers: H })).json();
    assert.strictEqual(got.requests.length, 1);
    const byId = Object.fromEntries(got.signals.items.map((i) => [i.id, i]));
    assert.strictEqual(byId["pmic-macro-signals:macro-regime"].score, 42);
    assert.strictEqual(byId["pmic-macro-signals:macro-regime"].as_of, "2026-11-01");
    assert.match(byId["pmic-macro-signals:macro-regime"].brief_sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(byId["pmic-macro-signals:broken"].status, "unavailable");
    assert.strictEqual(calls, 2);
    // Cached for 30 minutes, then refreshed.
    await signals.get(); assert.strictEqual(calls, 2);
    t += 31 * 60_000; await signals.get(); assert.strictEqual(calls, 4);
    const h = await (await fetch(`${pub}/v1/health`)).json();
    assert.deepStrictEqual([h.signals.ok, h.signals.total], [1, 2]);
  } finally {
    app.publicServer.close(); app.jobServer.close(); src.close();
  }
});
