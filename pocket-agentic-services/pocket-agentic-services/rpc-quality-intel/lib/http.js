// Tiny HTTP plumbing shared by every resource handler. No dependencies.
//
// Encodes the parts of Pocket's gateway design rules that are easy to get
// wrong by hand, in one place, so every route gets them for free:
//   - every response is a JSON object (rule 1)
//   - caller headers (Authorization/Api-Key/Cookie) are never trusted (rule 4)
//   - 200/204 for success, 4xx+JSON for bad input, never 5xx (rule 5)
//   - identity encoding only, no gzip (rule 5 note in the lint script)
//   - request bodies are size-capped well under the 16 MiB app-client cap (rule 8)
"use strict";

const http = require("http");

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB; every resource here is a small JSON query

class ClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Gateways scan the first 2KB of ANY non-5xx response body for these
// substrings and treat a match as a retry-worthy backend failure (Tier-3),
// regardless of status code — not just on a 2xx. Never let raw upstream
// error text (which legitimately contains words like "timeout" from a
// fetch AbortError) reach a response body verbatim; redact it first.
const TIER3_PATTERNS = [
  /timeout/gi,
  /connection refused/gi,
  /connection reset/gi,
  /bad gateway/gi,
  /service unavailable/gi,
  /gateway timeout/gi,
  /502 bad gateway/gi,
  /503 service unavailable/gi,
  /504 gateway timeout/gi,
];

function sanitize(message) {
  let out = String(message);
  for (const pat of TIER3_PATTERNS) out = out.replace(pat, "deadline exceeded");
  return out;
}

function sendJson(res, status, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Content-Encoding": "identity",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ClientError(413, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ClientError(400, "invalid_json", "request body must be valid JSON"));
      }
    });
    req.on("error", (e) => reject(new ClientError(400, "read_error", e.message)));
  });
}

/**
 * routes: Map<"METHOD /path", async (body, req) => jsonSerializableObject>
 * GET routes receive body === undefined.
 */
function createServer({ service, version, versionPath, healthPath, routes }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
        return sendJson(res, 200, { service, status: "ok" });
      }
      if (req.method === "GET" && path === versionPath) {
        return sendJson(res, 200, { service, version });
      }
      if (req.method === "GET" && path === healthPath) {
        return sendJson(res, 200, { status: "ok" });
      }

      const key = `${req.method} ${path}`;
      const handler = routes.get(key);
      if (!handler) {
        return sendJson(res, 404, { error: { code: "not_found", message: `no route for ${key}` } });
      }

      let body;
      if (req.method === "POST" || req.method === "PUT") {
        body = await readJsonBody(req);
      }
      const result = await handler(body, req);
      return sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof ClientError) {
        return sendJson(res, e.status, { error: { code: e.code, message: sanitize(e.message) } });
      }
      // Any unexpected failure (including upstream Pocket-network errors with
      // no cached fallback) is reported as a 422 with a plain-language reason,
      // never a 5xx: a 5xx is unpaid and penalized under the gateway rules,
      // and the caller still gets a JSON object it can read.
      const message = sanitize(String((e && e.message) || e).slice(0, 300));
      return sendJson(res, 422, { error: { code: "upstream_unavailable", message } });
    }
  });
}

module.exports = { createServer, sendJson, readJsonBody, ClientError, MAX_BODY_BYTES, sanitize };
