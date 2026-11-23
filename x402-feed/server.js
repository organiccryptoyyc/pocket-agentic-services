// x402-feed: a read-only, token-protected door from our x402 seller (alpha1) to the
// service backends on the supplier's internal Docker network.
//
//   POST /v1/<service>/<path>   Authorization: Bearer <FEED_TOKEN>   body: the backend's JSON input
//
// Only the routes in ROUTES are forwarded, always as POST to
// http://<service><suffix>-backend:8080/v1/<path>. Nothing else is reachable through it.
// The feed holds no keys besides its own token, stores nothing and logs no request bodies.
// Port 8080: health only (PSM's deploy check). Port 8095: the feed, published by PSM
// add-routes as /x402-feed (MainNet) or /x402-feed-beta (Beta).
"use strict";
const http = require("http");
const crypto = require("crypto");

const VERSION = "0.1.0";
const NETWORK = process.env.FEED_NETWORK === "main" ? "main" : "beta";
const SUFFIX = NETWORK === "main" ? "" : "-beta";
const TOKEN = process.env.FEED_TOKEN || "";
const FEED_PORT = Number(process.env.FEED_PORT || 8095);
const HEALTH_PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const RATE_PER_MIN = Number(process.env.FEED_RATE_PER_MIN || 120);

const PMIC_COMMON = ["verticals", "brief", "overview", "signals", "signal", "explain", "catalog"];
// service id -> allowed paths under /v1/ (the backend's own route names).
const ROUTES = {
  "treasury-capital-score": ["tcs6/score", "tcs6/entities"],
  "capital-integrity-dossier": ["dossier/plan", "dossier/section", "dossier/entities", "dossier/availability"],
  "brand-protection": ["brand/scan", "brand/lookalikes", "brand/evidence"], // brand/photo held until Nodle replies
  "agent-trust": ["domain-trust", "brand-verify", "seller-trust", "sanctions-check", "reputation", "preflight"],
  "prediction-market-intel": ["top-markets", "market-momentum", "rotation-diff", "market-quality"],
  "pmic-company-signals": [...PMIC_COMMON, "events", "evidence-packet"],
  "pmic-pharma-signals": [...PMIC_COMMON, "events", "evidence-packet"],
  "pmic-public-sector-signals": [...PMIC_COMMON, "evidence-packet"],
  "pmic-crypto-signals": [...PMIC_COMMON, "token-risk"],
  "pmic-macro-signals": [...PMIC_COMMON, "inflation/adjust"],
};

function backendHost(service) {
  // The dossier and TCS-6 MainNet deployments carry the plain id; Beta adds -beta.
  return `${service}${SUFFIX}-backend`;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function tokenOk(header) {
  if (!TOKEN || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One shared bucket: the only legitimate caller is alpha1.
let windowStart = Date.now();
let used = 0;
function rateOk() {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; used = 0; }
  used += 1;
  return used <= RATE_PER_MIN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseTarget(pathname) {
  const m = /^\/v1\/([a-z0-9-]+)\/([a-z0-9/-]+)$/.exec(pathname);
  if (!m) return null;
  const [, service, path] = m;
  if (!ROUTES[service] || !ROUTES[service].includes(path)) return null;
  return { service, path };
}

async function forward(target, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`http://${backendHost(target.service)}:8080/v1/${target.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `x402-feed/${VERSION}` },
      body,
      signal: ctrl.signal,
      redirect: "error",
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_RESPONSE) return { status: 502, body: JSON.stringify({ error: "response_too_large" }) };
    return { status: r.status, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

async function handleFeed(req, res) {
  const url = new URL(req.url, "http://feed");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return json(res, 200, { status: "ok", service: "x402-feed", version: VERSION, network: NETWORK });
  }
  if (!tokenOk(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && url.pathname === "/v1/routes") return json(res, 200, { network: NETWORK, routes: ROUTES });
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const target = parseTarget(url.pathname);
  if (!target) return json(res, 404, { error: "unknown_route" });
  if (!rateOk()) return json(res, 429, { error: "rate_limited" });
  let body;
  try {
    body = await readBody(req);
    if (body.length) JSON.parse(body.toString("utf8"));
    else body = Buffer.from("{}");
  } catch (e) {
    return json(res, e.status || 400, { error: e.status ? "body_too_large" : "invalid_json" });
  }
  const started = Date.now();
  try {
    const out = await forward(target, body);
    res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(out.body);
    console.log(JSON.stringify({ at: new Date().toISOString(), service: target.service, path: target.path, status: out.status, ms: Date.now() - started }));
  } catch (e) {
    const timeout = e.name === "AbortError";
    console.log(JSON.stringify({ at: new Date().toISOString(), service: target.service, path: target.path, error: timeout ? "timeout" : "upstream", ms: Date.now() - started }));
    json(res, timeout ? 504 : 502, { error: timeout ? "upstream_timeout" : "upstream_unavailable" });
  }
}

function health(req, res) {
  json(res, 200, { status: "ok", service: "x402-feed", version: VERSION, network: NETWORK });
}

if (require.main === module) {
  if (!/^[0-9a-f]{64}$/.test(TOKEN)) { console.error("FEED_TOKEN must be 64 hex characters"); process.exit(1); }
  http.createServer((req, res) => handleFeed(req, res).catch(() => json(res, 500, { error: "internal" }))).listen(FEED_PORT);
  http.createServer(health).listen(HEALTH_PORT);
  console.log(JSON.stringify({ started: VERSION, network: NETWORK, feed_port: FEED_PORT, health_port: HEALTH_PORT }));
}

module.exports = { ROUTES, parseTarget, backendHost, tokenOk, VERSION };
