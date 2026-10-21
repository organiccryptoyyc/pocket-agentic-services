// Minimal read-only PostgreSQL client (no npm dependencies), for the AACT cross-check (P5).
// One connection per call: SSLRequest -> TLS (certificate verified) -> startup -> SCRAM-SHA-256,
// MD5 or cleartext auth -> simple-protocol queries -> Terminate. Text results only; NULL is null.
// Credentials come from the caller (the collector's .env); they are never logged or stored.
"use strict";

const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

const PROTOCOL_V3 = 196608;
const SSL_REQUEST = 80877103;
const DEFAULT_TIMEOUT_MS = 60000;

function message(type, body) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4, 0);
  return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
}
const cstr = (s) => Buffer.from(`${s}\0`, "utf8");

// Reads whole backend messages from a socket: next() resolves {type, body}.
function reader(sock) {
  let buf = Buffer.alloc(0);
  const waiting = [];
  let failure = null;
  const pump = () => {
    while (waiting.length) {
      if (failure) { waiting.shift().reject(failure); continue; }
      if (buf.length < 5) return;
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      const msg = { type: String.fromCharCode(buf[0]), body: buf.subarray(5, 1 + len) };
      buf = buf.subarray(1 + len);
      waiting.shift().resolve(msg);
    }
  };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  const fail = (e) => { failure = failure || e; pump(); };
  sock.on("error", fail);
  sock.on("close", () => fail(new Error("pg: connection closed")));
  return { next: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); pump(); }) };
}

function errorText(body) {
  const f = {};
  for (let i = 0; i < body.length && body[i] !== 0;) {
    const code = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    f[code] = body.toString("utf8", i + 1, end);
    i = end + 1;
  }
  return `pg ${f.C || ""}: ${f.M || "error"}`;
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));

async function authenticate(sock, rd, user, password) {
  let scram = null;
  for (;;) {
    const m = await rd.next();
    if (m.type === "E") throw new Error(errorText(m.body));
    if (m.type !== "R") throw new Error(`pg: unexpected ${m.type} during auth`);
    const code = m.body.readInt32BE(0);
    if (code === 0) return;
    if (code === 3) { sock.write(message("p", cstr(password))); continue; }
    if (code === 5) {
      const salt = m.body.subarray(4, 8);
      const inner = crypto.createHash("md5").update(password + user).digest("hex");
      const outer = crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
      sock.write(message("p", cstr(`md5${outer}`)));
      continue;
    }
    if (code === 10) {
      const mechs = m.body.toString("utf8", 4).split("\0");
      if (!mechs.includes("SCRAM-SHA-256")) throw new Error(`pg: no supported SASL mechanism (${mechs.filter(Boolean).join(",")})`);
      const nonce = crypto.randomBytes(18).toString("base64");
      const bare = `n=,r=${nonce}`;
      const first = Buffer.from(`n,,${bare}`);
      const len = Buffer.alloc(4);
      len.writeInt32BE(first.length, 0);
      sock.write(message("p", Buffer.concat([cstr("SCRAM-SHA-256"), len, first])));
      scram = { nonce, bare };
      continue;
    }
    if (code === 11 && scram) {
      const serverFirst = m.body.toString("utf8", 4);
      const a = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
      if (!a.r || !a.r.startsWith(scram.nonce) || !a.s || !a.i) throw new Error("pg: bad SCRAM server-first message");
      const salted = crypto.pbkdf2Sync(password.normalize("NFKC"), Buffer.from(a.s, "base64"), Number(a.i), 32, "sha256");
      const clientKey = hmac(salted, "Client Key");
      const withoutProof = `c=biws,r=${a.r}`;
      const authMessage = `${scram.bare},${serverFirst},${withoutProof}`;
      const proof = xor(clientKey, hmac(sha256(clientKey), authMessage)).toString("base64");
      scram.expect = hmac(hmac(salted, "Server Key"), authMessage).toString("base64");
      sock.write(message("p", Buffer.from(`${withoutProof},p=${proof}`)));
      continue;
    }
    if (code === 12 && scram) {
      const v = /(?:^|,)v=([^,]+)/.exec(m.body.toString("utf8", 4));
      if (!v || v[1] !== scram.expect) throw new Error("pg: SCRAM server signature mismatch");
      continue;
    }
    throw new Error(`pg: unsupported auth method ${code}`);
  }
}

async function waitReady(rd) {
  for (;;) {
    const m = await rd.next();
    if (m.type === "E") throw new Error(errorText(m.body));
    if (m.type === "Z") return;
  }
}

async function runQuery(sock, rd, sql) {
  sock.write(message("Q", cstr(sql)));
  let cols = [];
  const rows = [];
  let err = null;
  for (;;) {
    const m = await rd.next();
    if (m.type === "T") {
      const n = m.body.readInt16BE(0);
      cols = [];
      let i = 2;
      for (let k = 0; k < n; k++) {
        const end = m.body.indexOf(0, i);
        cols.push(m.body.toString("utf8", i, end));
        i = end + 1 + 18;
      }
    } else if (m.type === "D") {
      const n = m.body.readInt16BE(0);
      const row = {};
      let i = 2;
      for (let k = 0; k < n; k++) {
        const len = m.body.readInt32BE(i);
        i += 4;
        row[cols[k]] = len < 0 ? null : m.body.toString("utf8", i, i + len);
        if (len > 0) i += len;
      }
      rows.push(row);
    } else if (m.type === "E") {
      err = new Error(errorText(m.body));
    } else if (m.type === "Z") {
      if (err) throw err;
      return rows;
    }
  }
}

// Owner decision 2026-10-20 (option A): AACT's database certificate expired on 2025-11-20. With
// allowExpiredCertificate, the only fault accepted is an expired server (leaf) certificate. OpenSSL
// reports an expired leaf before it checks trust (an expired self-signed certificate also reads as
// CERT_HAS_EXPIRED), so the chain is verified here instead: every signature up to a trusted root
// (the system roots, or cfg.ca), every certificate above the leaf in date, the leaf already valid,
// and the name matching the host. Anything else is refused before any login is sent. Returns true
// when the exception was used, so the caller can record it.
function pems(ca) {
  const text = [].concat(ca).map(String).join("\n");
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map((p) => new crypto.X509Certificate(p));
}

function expiredOnly(sock, host, ca) {
  if (sock.authorizationError !== "CERT_HAS_EXPIRED") throw new Error(`pg: TLS certificate rejected (${sock.authorizationError})`);
  const peer = sock.getPeerCertificate(true);
  if (!peer || !peer.raw) throw new Error("pg: TLS certificate rejected (no certificate)");
  if (tls.checkServerIdentity(host, peer)) throw new Error(`pg: TLS certificate is not for ${host}`);
  const now = Date.now();
  const chain = [];
  for (let c = peer; c && c.raw && !chain.some((x) => x.raw.equals(c.raw)); c = c.issuerCertificate) chain.push(c);
  const certs = chain.map((c) => new crypto.X509Certificate(c.raw));
  if (Date.parse(certs[0].validFrom) > now) throw new Error("pg: TLS certificate not yet valid");
  for (const c of certs.slice(1)) {
    if (Date.parse(c.validTo) < now || Date.parse(c.validFrom) > now) throw new Error("pg: TLS issuer certificate out of date");
  }
  for (let k = 0; k + 1 < certs.length; k++) {
    if (!certs[k].checkIssued(certs[k + 1]) || !certs[k].verify(certs[k + 1].publicKey)) throw new Error("pg: TLS certificate rejected (broken chain)");
  }
  const roots = ca ? pems(ca) : pems(tls.rootCertificates);
  const top = certs[certs.length - 1];
  const anchored = roots.some((r) => (r.fingerprint256 === top.fingerprint256)
    || (top.checkIssued(r) && top.verify(r.publicKey) && Date.parse(r.validTo) >= now && Date.parse(r.validFrom) <= now));
  if (!anchored) throw new Error("pg: TLS certificate rejected (not from a trusted authority)");
  return true;
}

// Runs each SQL statement in order on one connection; returns an array of row arrays.
// cfg: {host, port, database, user, password, ssl = true, allowExpiredCertificate = false, ca (tests only), timeoutMs}
// The returned array carries certExpired: true when the expired-certificate exception was used.
async function query(cfg, statements) {
  const { host, port = 5432, database, user, password, ssl = true, allowExpiredCertificate = false, ca, timeoutMs = DEFAULT_TIMEOUT_MS } = cfg;
  let certExpired = false;
  if (!host || !database || !user || !password) throw new Error("pg: host, database, user and password are required");
  let raw = net.connect(port, host);
  let sock = raw;
  const timer = setTimeout(() => raw.destroy(new Error(`pg: timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    await new Promise((resolve, reject) => { raw.once("connect", resolve); raw.once("error", reject); });
    if (ssl) {
      const b = Buffer.alloc(8);
      b.writeInt32BE(8, 0);
      b.writeInt32BE(SSL_REQUEST, 4);
      raw.write(b);
      const answer = await new Promise((resolve, reject) => { raw.once("data", (d) => resolve(d.toString("latin1", 0, 1))); raw.once("error", reject); });
      if (answer !== "S") throw new Error("pg: server refused SSL");
      sock = tls.connect({ socket: raw, servername: host, rejectUnauthorized: !allowExpiredCertificate, ...(ca ? { ca } : {}) });
      await new Promise((resolve, reject) => { sock.once("secureConnect", resolve); sock.once("error", reject); });
      if (!sock.authorized) certExpired = expiredOnly(sock, host, ca); // throws for any other fault, before any login is sent
    }
    const rd = reader(sock);
    const params = Buffer.concat([cstr("user"), cstr(user), cstr("database"), cstr(database), cstr("application_name"), cstr("pmic-verify"), Buffer.from([0])]);
    const ver = Buffer.alloc(4);
    ver.writeInt32BE(PROTOCOL_V3, 0);
    sock.write(message(null, Buffer.concat([ver, params])));
    await authenticate(sock, rd, user, password);
    await waitReady(rd);
    const out = [];
    for (const sql of [].concat(statements)) out.push(await runQuery(sock, rd, sql));
    sock.write(message("X", Buffer.alloc(0)));
    out.certExpired = certExpired;
    return out;
  } finally {
    clearTimeout(timer);
    sock.destroy();
    raw.destroy();
  }
}

module.exports = { query };
