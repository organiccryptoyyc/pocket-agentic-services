// node --test test/provenance.test.js  (no network: images are built here, fetches are stubbed)
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const pv = require("../lib/provenance");
const { riskScore } = require("../lib/score");

// --- tiny DER builders ---------------------------------------------------------------------
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...xs) => tlv(0x30, Buffer.concat(xs));
const set = (...xs) => tlv(0x31, Buffer.concat(xs));
const oid = (bytes) => tlv(0x06, Buffer.from(bytes));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const name = (cn, o) => seq(set(seq(oid([0x55, 0x04, 0x0a]), utf8(o))), set(seq(oid([0x55, 0x04, 0x03]), utf8(cn))));
const pad = Buffer.alloc(200, 0x41); // keep every certificate over 255 bytes (30 82 LL LL)

function cert({ subject, issuer, ca = false, critical = true, eku = null }) {
  const bcValue = ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq();
  const bcExt = seq(oid([0x55, 0x1d, 0x13]), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, bcValue));
  const exts = [bcExt];
  if (eku) exts.push(seq(oid([0x55, 0x1d, 0x25]), tlv(0x04, seq(oid(eku)))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1, 2, 3])),
    seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])),
    name(issuer[0], issuer[1]),
    seq(tlv(0x17, Buffer.from("250101000000Z")), tlv(0x17, Buffer.from("300101000000Z"))),
    name(subject[0], subject[1]),
    seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])),
    tlv(0xa3, seq(...exts)),
    tlv(0x04, pad),
  );
  return seq(tbs, seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])), tlv(0x03, Buffer.from([0, 1, 2])));
}

const TSA_EKU = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08];
function manifest({ ai = true, signer = ["OpenAI Media Service", "OpenAI OpCo, LLC"], issuer = ["Trufo C2PA Claim Signing CA (2025)", "Trufo Inc."] } = {}) {
  return Buffer.concat([
    Buffer.from("....jumb....jumdc2pa...c2pa.actions.v2 c2pa.created c2pa.converted "),
    Buffer.from(ai ? "digitalSourceType http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia " : "c2pa.opened "),
    cert({ subject: signer, issuer }),
    cert({ subject: issuer, issuer: ["Trufo C2PA Root CA", "Trufo Inc."], ca: true }),
    cert({ subject: ["OpenAI TSA Leaf", "OpenAI OpCo, LLC"], issuer: ["OpenAI TSA Issuing CA", "OpenAI OpCo, LLC"], eku: TSA_EKU }),
  ]);
}

function jpeg(app11) {
  const seg = app11 ? Buffer.concat([Buffer.from([0xff, 0xeb]), Buffer.from([(app11.length + 2) >> 8, (app11.length + 2) & 255]), app11]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
}
function pngChunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  return Buffer.concat([l, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}
function png(cabx, { bigIdat = 0 } = {}) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13)),
    pngChunk("IDAT", bigIdat ? Buffer.alloc(bigIdat) : zlib.deflateSync(Buffer.alloc(10))),
    ...(cabx ? [pngChunk("caBX", cabx)] : []),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("JPEG with OpenAI-signed AI credentials: signer is the leaf, not the CA or the time-stamp certificate", () => {
  const r = pv.inspectImage(jpeg(manifest()));
  assert.strictEqual(r.format, "jpeg");
  assert.strictEqual(r.content_credentials, true);
  assert.strictEqual(r.searched, "whole_file");
  assert.deepStrictEqual(r.signer, { cn: "OpenAI Media Service", o: "OpenAI OpCo, LLC" });
  assert.deepStrictEqual(r.signer_issuer, { cn: "Trufo C2PA Claim Signing CA (2025)", o: "Trufo Inc." });
  assert.strictEqual(r.ai_generated, true);
  assert.strictEqual(r.digital_source_type, "trainedAlgorithmicMedia");
  assert.strictEqual(r.test_certificate, false);
  assert.deepStrictEqual(r.actions, ["converted", "created"]);
});

test("a critical basicConstraints flag on the leaf doesn't make it a CA", () => {
  const leaf = cert({ subject: ["Leaf", "Org"], issuer: ["CA", "Org"], critical: true });
  const ca = cert({ subject: ["CA", "Org"], issuer: ["Root", "Org"], ca: true, critical: true });
  const cs = pv.certificates(Buffer.concat([Buffer.from("xx"), leaf, ca]));
  assert.deepStrictEqual(cs.map((c) => [c.subject.cn, c.is_ca]), [["Leaf", false], ["CA", true]]);
});

test("PNG caBX after the image data is found; not-AI credentials say so", () => {
  const r = pv.inspectImage(png(manifest({ ai: false, signer: ["Anthropic Claude Content Signing", "Anthropic, PBC"], issuer: ["Anthropic Content Credentials Root CA", "Anthropic, PBC"] })));
  assert.strictEqual(r.content_credentials, true);
  assert.strictEqual(r.ai_generated, false);
  assert.strictEqual(r.signer.o, "Anthropic, PBC");
});

test("self-signed ephemeral certificate is flagged as a test certificate", () => {
  const r = pv.inspectImage(jpeg(manifest({ ai: false, signer: ["Adobe Compliance Signer", "Self-signed ephemeral certificate (Content Authenticity SDK) -- LOCAL USE ONLY"], issuer: ["c2pa-ephemeral-ca.local", "Self-signed ephemeral CA (Content Authenticity SDK)"] })));
  assert.strictEqual(r.test_certificate, true);
  const r2 = pv.inspectImage(jpeg(manifest({ ai: true, signer: ["xAI Grok Imagine", "Self-signed ephemeral certificate (Content Authenticity SDK) -- LOCAL USE ONLY"], issuer: ["c2pa-ephemeral-ca.local", "Self-signed ephemeral CA (Content Authenticity SDK)"] })));
  assert.strictEqual(pv.statement([{ format: "jpeg", ...r2 }]),
    "1 of 1 image checked on this page carries C2PA Content Credentials marking it as AI-generated, signed by xAI Grok Imagine (self-signed test certificate, not a trusted signer). Signatures were read, not validated.");
  assert.match(pv.statement([{ format: "jpeg", ...r }]), /with no AI-generated mark, signed by Adobe Compliance Signer \(self-signed test certificate/);
});

test("no credentials; an unsigned XMP AI label is recorded separately", () => {
  const plain = pv.inspectImage(jpeg(null));
  assert.strictEqual(plain.content_credentials, false);
  assert.strictEqual(plain.unsigned_ai_label, undefined);
  const xmp = Buffer.from('<x:xmpmeta><rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></x:xmpmeta>');
  const withLabel = jpeg(null);
  const labelled = Buffer.concat([withLabel.subarray(0, 2), Buffer.from([0xff, 0xe1, (xmp.length + 2) >> 8, (xmp.length + 2) & 255]), xmp, withLabel.subarray(2)]);
  const r = pv.inspectImage(labelled);
  assert.strictEqual(r.content_credentials, false);
  assert.strictEqual(r.unsigned_ai_label, "trainedAlgorithmicMedia");
});

test("a read cut short before the manifest could appear says first_bytes_only, not 'none'", () => {
  const full = png(manifest(), { bigIdat: 5000 });
  const r = pv.inspectImage(full.subarray(0, 2000), true);
  assert.strictEqual(r.content_credentials, false);
  assert.strictEqual(r.searched, "first_bytes_only");
});

test("imageUrls: social card first, data: and SVG skipped, &amp; decoded, capped", () => {
  const html = `<img src="data:image/png;base64,AAA"><img src="/logo.svg"><img src="/a.png?x=1&amp;y=2">
    <meta property="og:image" content="https://cdn.example/og.png"><img src="/b.webp"><img src="/c.jpg"><img src="/d.jpg">`;
  assert.deepStrictEqual(pv.imageUrls(html, "https://site.example/"), [
    "https://cdn.example/og.png", "https://site.example/a.png?x=1&y=2", "https://site.example/b.webp", "https://site.example/c.jpg",
  ]);
});

test("imageUrls: og:image:alt text and other og:image properties are not image URLs", () => {
  const html = `<meta property="og:image:alt" content="Aave Staking & Earn"><meta property="og:image:width" content="1200">
    <meta property="og:image" content="/og.png"><meta name="twitter:image:src" content="/tw.png">`;
  assert.deepStrictEqual(pv.imageUrls(html, "https://site.example/"), ["https://site.example/og.png", "https://site.example/tw.png"]);
});

test("statement wording: the takedown line names the signer and the counts", () => {
  const ai = { format: "png", ...pv.inspectImage(png(manifest())) };
  const none = { format: "jpeg", content_credentials: false };
  assert.strictEqual(pv.statement([ai, none]),
    "1 of 2 images checked on this page carries C2PA Content Credentials marking it as AI-generated, signed by OpenAI OpCo, LLC (OpenAI Media Service). Signatures were read, not validated.");
  assert.strictEqual(pv.statement([none]), "None of the 1 image checked on this page carries Content Credentials or an AI label.");
  assert.strictEqual(pv.statement([{ url: "x", error: "fetch_failed" }]), "No page images could be read.");
});

test("artwork(): stubbed fetches; robots.txt on another host is honoured; failures recorded, never thrown", async () => {
  const bodies = {
    "https://cdn.example/robots.txt": { status: 200, body: Buffer.from("User-agent: *\nDisallow: /") },
    "https://site.example/og.png": { status: 200, body: png(manifest()) },
    "https://site.example/b.jpg": { status: 200, body: jpeg(null) },
  };
  const fetchVetted = async (u, o) => {
    if (u === "https://site.example/err.jpg") { const e = new Error("private"); e.isSsrfGuard = true; throw e; }
    if (u.startsWith("https://site.example/")) assert.ok(o && o.maxBytes >= 1024 * 1024, "images use the larger cap");
    const b = bodies[u] || { status: 404, body: Buffer.alloc(0) };
    return { ...b, final_url: u, truncated: false };
  };
  const html = `<meta property="og:image" content="/og.png"><img src="https://cdn.example/x.png"><img src="/b.jpg"><img src="/err.jpg">`;
  const a = await pv.artwork(html, "https://site.example/", { fetchVetted });
  assert.strictEqual(a.method, "bp-provenance/1");
  assert.strictEqual(a.images_found, 4);
  assert.strictEqual(a.images_read, 2);
  assert.strictEqual(a.signed_ai_images, 1);
  assert.deepStrictEqual(a.ai_signers, ["OpenAI OpCo, LLC (OpenAI Media Service)"]);
  assert.deepStrictEqual(a.images.find((i) => i.url === "https://cdn.example/x.png"), { url: "https://cdn.example/x.png", skipped: "robots_txt" });
  assert.strictEqual(a.images.find((i) => i.url === "https://site.example/err.jpg").error, "refused_private_address");
  assert.strictEqual(a.signature_validated, false);
  assert.strictEqual(a.affects_score, false);
  assert.ok(a.images.every((i) => !("body" in i)), "no image bytes kept");
});

test("artwork(): a slow image is cut off at the time budget, not waited for", async () => {
  const fetchVetted = (u) => (u.endsWith("slow.png") ? new Promise(() => {}) : Promise.resolve({ status: 200, body: jpeg(null), final_url: u, truncated: false }));
  const t0 = Date.now();
  const a = await pv.artwork('<img src="/slow.png"><img src="/ok.jpg">', "https://site.example/", { fetchVetted, budgetMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(a.images.find((i) => i.url.endsWith("slow.png")).error, "time_limit");
  assert.strictEqual(a.images_read, 1);
});

test("the risk score ignores artwork provenance", () => {
  const page = { reachable: true, status: 200, title: "Aave staking", brand_in_title: true, brand_terms_in_title: ["aave"], wallet_prompt: true };
  const base = { dns: { exists: true, resolves: true, a: ["1.2.3.4"] }, rdap: null, cert: null, official: { title: "Aave", icon_sha256: null }, ct: null, fuzzer: "addition" };
  const without = riskScore({ ...base, page });
  const withArt = riskScore({ ...base, page: { ...page, artwork_provenance: { signed_ai_images: 3, ai_signers: ["OpenAI OpCo, LLC (OpenAI Media Service)"] } } });
  assert.deepStrictEqual(withArt, without);
});
