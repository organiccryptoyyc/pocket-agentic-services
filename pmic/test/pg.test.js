// lib/pg.js against a fake PostgreSQL server: SCRAM-SHA-256 login, two queries, NULLs, errors.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const crypto = require("node:crypto");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const pg = require("../lib/pg");

const msg = (type, body) => { const l = Buffer.alloc(4); l.writeInt32BE(body.length + 4, 0); return Buffer.concat([Buffer.from(type), l, body]); };
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; };
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

function fakeServer(password, { badSignature = false, tlsCert = null } = {}) {
  const salt = crypto.randomBytes(16);
  const iter = 4096;
  const salted = crypto.pbkdf2Sync(password, salt, iter, 32, "sha256");
  const seen = [];
  const handle = (sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let st = {};
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          const len = buf.readInt32BE(0);
          const body = buf.subarray(4, len);
          buf = buf.subarray(len);
          started = true;
          seen.push(["startup", body.subarray(4).toString("utf8").split("\0").filter(Boolean)]);
          sock.write(msg("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])));
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        if (type === "p" && !st.bare) {
          const mech = body.toString("utf8", 0, body.indexOf(0));
          const first = body.toString("utf8", body.indexOf(0) + 5);
          st.bare = first.slice(3);
          st.cnonce = /r=([^,]+)/.exec(first)[1];
          st.nonce = st.cnonce + crypto.randomBytes(9).toString("base64");
          st.serverFirst = `r=${st.nonce},s=${salt.toString("base64")},i=${iter}`;
          seen.push(["sasl", mech]);
          sock.write(msg("R", Buffer.concat([int32(11), Buffer.from(st.serverFirst)])));
        } else if (type === "p") {
          const final = body.toString("utf8");
          const withoutProof = final.slice(0, final.indexOf(",p="));
          const proof = Buffer.from(final.slice(final.indexOf(",p=") + 3), "base64");
          const authMessage = `${st.bare},${st.serverFirst},${withoutProof}`;
          const clientKey = hmac(salted, "Client Key");
          const storedKey = crypto.createHash("sha256").update(clientKey).digest();
          const expected = Buffer.from(clientKey.map((x, i) => x ^ hmac(storedKey, authMessage)[i]));
          if (!expected.equals(proof)) {
            sock.write(msg("E", Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0")));
            sock.end();
            return;
          }
          const sig = badSignature ? "AAAA" : hmac(hmac(salted, "Server Key"), authMessage).toString("base64");
          sock.write(Buffer.concat([msg("R", Buffer.concat([int32(12), Buffer.from(`v=${sig}`)])), msg("R", int32(0)),
            msg("S", Buffer.from("server_version\x0016\x00")), msg("Z", Buffer.from("I"))]));
        } else if (type === "Q") {
          const sql = body.toString("utf8", 0, body.length - 1);
          seen.push(["query", sql]);
          if (/boom/.test(sql)) {
            sock.write(Buffer.concat([msg("E", Buffer.from("SERROR\0C42P01\0Mrelation \"boom\" does not exist\0\0")), msg("Z", Buffer.from("I"))]));
            continue;
          }
          const field = (name) => Buffer.concat([Buffer.from(`${name}\0`), Buffer.alloc(18)]);
          const val = (v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]));
          sock.write(Buffer.concat([
            msg("T", Buffer.concat([int16(2), field("month"), field("n")])),
            msg("D", Buffer.concat([int16(2), val("2026-08-01"), val("12")])),
            msg("D", Buffer.concat([int16(2), val(null), val("")])),
            msg("C", Buffer.from("SELECT 2\0")), msg("Z", Buffer.from("I"))]));
        } else if (type === "X") {
          seen.push(["terminate"]);
          sock.end();
        }
      }
    });
    sock.on("error", () => {});
  };
  const server = net.createServer((raw) => {
    if (!tlsCert) return handle(raw);
    raw.once("data", () => { // SSLRequest
      raw.write("S");
      handle(new tls.TLSSocket(raw, { isServer: true, key: tlsCert.key, cert: tlsCert.cert }));
    });
    raw.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, tlsCert ? undefined : "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

test("pg: SCRAM-SHA-256 login, rows with NULL and empty strings, several statements, clean terminate", async () => {
  const { server, port, seen } = await fakeServer("s3cret");
  try {
    const [a, b] = await pg.query({ host: "127.0.0.1", port, database: "aact", user: "u1", password: "s3cret", ssl: false }, ["SELECT 1", "SELECT 2"]);
    assert.deepEqual(a, [{ month: "2026-08-01", n: "12" }, { month: null, n: "" }]);
    assert.equal(b.length, 2);
    assert.deepEqual(seen[0], ["startup", ["user", "u1", "database", "aact", "application_name", "pmic-verify"]]);
    assert.deepEqual(seen[1], ["sasl", "SCRAM-SHA-256"]);
    assert.deepEqual(seen.filter((s) => s[0] === "query").map((s) => s[1]), ["SELECT 1", "SELECT 2"]);
  } finally {
    server.close();
  }
});

test("pg: wrong password, bad server signature and SQL errors are errors (and the password never appears)", async () => {
  const { server, port } = await fakeServer("s3cret");
  const bad = await fakeServer("s3cret", { badSignature: true });
  try {
    await assert.rejects(pg.query({ host: "127.0.0.1", port, database: "aact", user: "u1", password: "nope", ssl: false }, "SELECT 1"),
      (e) => /28P01/.test(e.message) && !/nope/.test(e.message));
    await assert.rejects(pg.query({ host: "127.0.0.1", port: bad.port, database: "aact", user: "u1", password: "s3cret", ssl: false }, "SELECT 1"), /signature mismatch/);
    await assert.rejects(pg.query({ host: "127.0.0.1", port, database: "aact", user: "u1", password: "s3cret", ssl: false }, "SELECT * FROM boom"), /42P01/);
    await assert.rejects(pg.query({ host: "127.0.0.1", port, database: "aact", user: "u1", ssl: false }, "SELECT 1"), /required/);
  } finally {
    server.close();
    bad.server.close();
  }
});

// Throwaway certificates in test/fixtures/pg-tls (test CA; leaf certificates that expired on 2025-01-01).
const FX = path.join(__dirname, "fixtures", "pg-tls");
const fx = (f) => fs.readFileSync(path.join(FX, f));

test("pg TLS: an expired certificate is refused by default and accepted only under allowExpiredCertificate", async () => {
  const srv = await fakeServer("s3cret", { tlsCert: { key: fx("leaf.key"), cert: fx("expired.crt") } });
  const cfg = { host: "localhost", port: srv.port, database: "aact", user: "u1", password: "s3cret", ca: fx("ca.crt") };
  try {
    await assert.rejects(pg.query(cfg, "SELECT 1"), /expired/i);
    assert.equal(srv.seen.length, 0, "nothing sent before the certificate check");
    const out = await pg.query({ ...cfg, allowExpiredCertificate: true }, "SELECT 1");
    assert.equal(out.certExpired, true);
    assert.equal(out[0].length, 2);
  } finally {
    srv.server.close();
  }
});

test("pg TLS: the exception never covers a wrong name or an untrusted (self-signed) certificate", async () => {
  const wrong = await fakeServer("s3cret", { tlsCert: { key: fx("leaf.key"), cert: fx("wrongname.crt") } });
  const self = await fakeServer("s3cret", { tlsCert: { key: fx("leaf.key"), cert: fx("selfsigned.crt") } });
  const base = { host: "localhost", database: "aact", user: "u1", password: "s3cret", ca: fx("ca.crt"), allowExpiredCertificate: true };
  try {
    await assert.rejects(pg.query({ ...base, port: wrong.port }, "SELECT 1"), /not for localhost/);
    await assert.rejects(pg.query({ ...base, port: self.port }, "SELECT 1"), /certificate rejected/);
    assert.equal(wrong.seen.length + self.seen.length, 0, "no login sent to either");
  } finally {
    wrong.server.close();
    self.server.close();
  }
});
