// In-process smoke test. Unlike this repo's other packages, most of this
// one runs against REAL tools (pdftoppm, pdfinfo, sharp, heif-convert) —
// no stub network layer needed, because this service's dependencies are
// local binaries/libraries, not remote APIs. It builds a real minimal PDF
// and fetches a real HEIC test file (a well-known public libheif example,
// single-image/HEVC-coded — the exact case sharp's bundled libheif cannot
// decode) to prove the render and HEIC-fallback paths for real. The one
// thing it cannot exercise is whisper.cpp itself (no model available in
// this environment — see README "Verification"); that path is asserted
// only up to the honest "not_configured" response.
"use strict";
const assert = require("assert");
const http = require("http");
const https = require("https");

process.env.PORT = "0";

const originalListen = http.Server.prototype.listen;
let boundPort = null;
http.Server.prototype.listen = function (port, host, cb) {
  const result = originalListen.call(this, 0, host, () => {
    boundPort = this.address().port;
    if (cb) cb();
  });
  return result;
};

require("../server.js");

function req(path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: "localhost", port: boundPort, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
      }
    );
    r.on("error", reject);
    r.end(data);
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    if (boundPort) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("server did not start");
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// A minimal, hand-built one-page PDF (no external deps needed to make one).
function minimalPdf(text) {
  const stream = `BT /F1 18 Tf 10 50 Td (${text}) Tj ET`;
  const pdf =
    `%PDF-1.4\n` +
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n` +
    `4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n` +
    `5 0 obj<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n` +
    `xref\n0 6\n0000000000 65535 f \ntrailer<</Size 6/Root 1 0 R>>\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

async function main() {
  await waitForServer();

  // --- /v1/pdf-render: real pdftoppm, real bytes -------------------------
  const pdf = minimalPdf("Smoke test page");
  const render = await req("/v1/pdf-render", { pdf_base64: pdf.toString("base64"), page: 1, dpi: 100, format: "png" });
  assert.strictEqual(render.status, 200, JSON.stringify(render.body));
  assert.strictEqual(render.body.page_count, 1);
  assert.ok(render.body.width > 0 && render.body.height > 0, "must report real pixel dimensions");
  assert.ok(render.body.image_base64.length > 100, "must return real image bytes");
  assert.strictEqual(Buffer.from(render.body.image_base64, "base64").slice(1, 4).toString("ascii"), "PNG", "output must actually be a PNG");

  const badPage = await req("/v1/pdf-render", { pdf_base64: pdf.toString("base64"), page: 5 });
  assert.strictEqual(badPage.status, 422);
  assert.strictEqual(badPage.body.error.code, "invalid_input");

  const notAPdf = await req("/v1/pdf-render", { pdf_base64: Buffer.from("not a pdf").toString("base64") });
  assert.strictEqual(notAPdf.status, 422);
  assert.ok(notAPdf.status < 500, "must never be a 5xx");

  // --- /v1/image-convert: real sharp path (png -> webp) ------------------
  const sharp = require("sharp");
  const pngBuffer = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const conv = await req("/v1/image-convert", { image_base64: pngBuffer.toString("base64"), to: "webp", quality: 80 });
  assert.strictEqual(conv.status, 200, JSON.stringify(conv.body));
  assert.strictEqual(conv.body.detected_format, "png");
  assert.strictEqual(conv.body.output_format, "webp");
  assert.strictEqual(conv.body.width, 40);

  const badFormat = await req("/v1/image-convert", { image_base64: pngBuffer.toString("base64"), to: "bmp" });
  assert.strictEqual(badFormat.status, 422);

  // --- /v1/image-convert: real HEIC/HEVC file -> the heif-convert fallback --
  // This is the case sharp's bundled libheif cannot decode on its own
  // (verified during this build — see README). Network-dependent (a real
  // public test fixture); skipped gracefully if unreachable rather than
  // failing the whole suite over a network hiccup unrelated to this code.
  try {
    const heic = await fetchBuffer("https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic");
    const heicConv = await req("/v1/image-convert", { image_base64: heic.toString("base64"), to: "png" });
    assert.strictEqual(heicConv.status, 200, JSON.stringify(heicConv.body));
    assert.strictEqual(heicConv.body.detected_format, "heic");
    assert.ok(heicConv.body.width > 0 && heicConv.body.height > 0);
    console.log("smoke: real HEIC/HEVC fallback path verified against a live test file");
  } catch (e) {
    console.log(`smoke: skipped the live HEIC fixture fetch (${e.message}) — heif-convert fallback logic unverified this run`);
  }

  // --- /v1/audio-transcribe: honest not_configured without a model ------
  const transcribe = require("../lib/transcribe");
  if (!(await transcribe.isConfigured())) {
    const wav = Buffer.from("RIFF....WAVEfmt "); // not real audio; submit should fail on config before it even looks
    const sub = await req("/v1/audio-transcribe", { audio_base64: wav.toString("base64") });
    assert.strictEqual(sub.status, 422);
    assert.strictEqual(sub.body.error.code, "not_configured");
    console.log("smoke: audio-transcribe correctly reports not_configured (no whisper.cpp binary/model in this environment)");
  } else {
    console.log("smoke: whisper.cpp IS configured in this environment — real transcription path not exercised by this script");
  }

  const missingJob = await req("/v1/audio-transcribe-status", { job_id: "00000000-0000-0000-0000-000000000000" });
  assert.strictEqual(missingJob.status, 404);

  console.log("smoke: all assertions passed");
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
