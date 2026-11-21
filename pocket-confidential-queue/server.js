// pocket-confidential-queue: the Pocket side of the confidential decision layer.
//
// Public API on :8080 (behind the RelayMiner, for customers and agents):
//   GET  /v1/version, /v1/health
//   GET  /v1/key                      the current signed key announcement from the Liskov job
//   POST /v1/submit  {request}        a request sealed to that key (protocol pocket-confidential/0.1)
//   POST /v1/result  {request_id}     queued | working | done (signed result) | error
//
// Job API on :8090 (a private Caddy route, bearer token; only the Liskov job calls it):
//   POST /job/keys                    signed key announcement
//   GET  /job/requests?to=&max=       sealed requests for that key (leased for 2 minutes)
//   POST /job/results                 {request_id, sealed | error}
//
// The queue cannot read requests: it holds no decryption key. It checks signatures, expiry,
// sizes and that each result is signed by the job key the request was sealed to.
"use strict";

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { checkAnnouncement, checkRequest, checkSealed } = require("./lib/verify");
const { createStore } = require("./lib/store");
const { createSignals, defaultSources } = require("./lib/signals");

const SERVICE = "pocket-confidential-queue";
const VERSION = "0.2.0";
const MAX_BODY = 256 * 1024;
const MAX_REQUEST = 128 * 1024;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error(`body over ${MAX_BODY} bytes`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("body is not JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m || !token) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

const err = (res, status, code, message) => send(res, status, { error: { code, message } });

function createApp({ dataDir, jobToken, now = () => Date.now(), signals = null }) {
  const store = createStore(dataDir, now);

  async function publicHandler(req, res) {
    try {
      const url = new URL(req.url, "http://x");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /v1/version") return send(res, 200, { service: SERVICE, version: VERSION, protocol: "pocket-confidential/0.1" });
      if (route === "GET /v1/health") {
        const b = signals && signals.peek();
        return send(res, 200, { service: SERVICE, status: "ok", key_available: Boolean(store.currentAnnouncement()), signals: b ? { fetched_at: b.fetched_at, ok: b.items.filter((i) => i.status === "ok").length, total: b.items.length } : null });
      }
      if (route === "GET /v1/key") {
        const a = store.currentAnnouncement();
        if (!a) return err(res, 503, "no_key", "no confidential worker is online; try again later");
        return send(res, 200, { service: SERVICE, ...a, note: "Check the signature, then check job_ed25519_public_key and artifact_digest against the Liskov runtime evidence before sealing a request to encryption_public_key." });
      }
      if (route === "POST /v1/submit") {
        const body = await readJson(req);
        const r = body.request;
        const problems = checkRequest(r, MAX_REQUEST);
        if (problems.length) return err(res, 400, "bad_request", problems.join("; "));
        if (!store.announcementFor(r.to)) return err(res, 409, "stale_key", "the request is sealed to a key that is not current; fetch GET /v1/key and seal again");
        const s = store.submit(r);
        if (!s.ok) return err(res, s.reason === "queue full" ? 503 : 409, s.reason === "queue full" ? "queue_full" : "duplicate", s.reason);
        return send(res, 202, { service: SERVICE, request_id: r.request_id, status: "queued", input_commitment: r.input_commitment });
      }
      if (route === "POST /v1/result") {
        const body = await readJson(req);
        const id = String(body.request_id || "");
        const r = store.get(id);
        if (!r) return err(res, 404, "not_found", "no such request (results are kept 24 hours)");
        const base = { service: SERVICE, request_id: id, input_commitment: r.request.input_commitment };
        if (r.status === "done") return send(res, 200, { ...base, status: "done", sealed: r.sealed });
        if (r.status === "error") return send(res, 200, { ...base, status: "error", error: r.error });
        return send(res, 200, { ...base, status: r.status === "leased" ? "working" : "queued" });
      }
      return err(res, 404, "not_found", "GET /v1/key, POST /v1/submit, POST /v1/result, GET /v1/version, GET /v1/health");
    } catch (e) {
      return err(res, e.status || 400, "bad_request", String(e.message).slice(0, 200));
    }
  }

  async function jobHandler(req, res) {
    try {
      const url = new URL(req.url, "http://x");
      const route = `${req.method} ${url.pathname}`;
      if (!["POST /job/keys", "GET /job/requests", "POST /job/results"].includes(route)) return err(res, 404, "not_found", "POST /job/keys, GET /job/requests, POST /job/results");
      if (!tokenOk(req.headers.authorization, jobToken)) return err(res, 401, "unauthorized", "bearer token required");
      if (route === "POST /job/keys") {
        const a = await readJson(req);
        const problems = checkAnnouncement(a, now());
        if (problems.length) return err(res, 400, "bad_announcement", problems.join("; "));
        store.addAnnouncement({ announcement: a.announcement, signature: a.signature });
        return send(res, 200, { ok: true, expires_at: a.announcement.expires_at });
      }
      if (route === "GET /job/requests") {
        const to = url.searchParams.get("to") || "";
        if (!store.announcementFor(to)) return err(res, 409, "unknown_key", "publish the key announcement first");
        const max = Math.min(50, Math.max(1, Number(url.searchParams.get("max")) || 10));
        const leased = store.lease(to, max);
        // Public market signals ride along with work, identical for every customer.
        const bundle = leased.length && signals ? await signals.get() : null;
        return send(res, 200, { requests: leased, signals: bundle });
      }
      const body = await readJson(req);
      const id = String(body.request_id || "");
      const r = store.get(id);
      if (!r) return err(res, 404, "not_found", "no such request");
      if (r.status === "done") return send(res, 200, { ok: true, already: true });
      if (body.error) {
        const code = String(body.error.code || "service_failed").slice(0, 40);
        const message = body.error.message == null ? null : String(body.error.message).slice(0, 200);
        store.complete(id, { status: "error", error: { code, message } });
        return send(res, 200, { ok: true });
      }
      const ann = store.announcementFor(r.request.to);
      if (!ann) return err(res, 409, "unknown_key", "the key this request was sealed to has expired");
      const problems = checkSealed(body.sealed, r.request, ann.announcement.job_ed25519_public_key);
      if (problems.length) return err(res, 400, "bad_result", problems.join("; "));
      store.complete(id, { status: "done", sealed: body.sealed });
      return send(res, 200, { ok: true });
    } catch (e) {
      return err(res, e.status || 400, "bad_request", String(e.message).slice(0, 200));
    }
  }

  return { store, publicServer: http.createServer(publicHandler), jobServer: http.createServer(jobHandler) };
}

if (require.main === module) {
  const token = process.env.CQ_JOB_TOKEN;
  if (!token || token.length < 32) {
    console.error(JSON.stringify({ fatal: "CQ_JOB_TOKEN missing or shorter than 32 characters" }));
    process.exit(1);
  }
  const signals = createSignals({ sources: defaultSources(process.env.CQ_NETWORK === "beta" ? "beta" : "main") });
  const app = createApp({ dataDir: path.resolve(process.env.CQ_DATA_DIR || "/var/lib/pocket-confidential-queue"), jobToken: token, signals });
  signals.get().catch(() => {}); // warm the cache at start
  const port = Number(process.env.PORT || 8080);
  const jobPort = Number(process.env.CQ_JOB_PORT || 8090);
  app.publicServer.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ service: SERVICE, version: VERSION, listening: port })));
  app.jobServer.listen(jobPort, "0.0.0.0", () => console.log(JSON.stringify({ job_api: "listening", port: jobPort })));
}

module.exports = { createApp, SERVICE, VERSION };
