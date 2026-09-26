// PDF-page-to-image and any-format image conversion. Both paths were run
// for real against real files during this build — see README.md
// "Verification" for exactly what was tested and how.
"use strict";

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { run, withTempDir } = require("./exec");

const MAX_OUTPUT_PIXELS = 40_000_000; // 40MP decompression-bomb guard on the *output* image
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp", "tiff", "avif"]);

class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.isClientError = true;
  }
}

// ISO-BMFF 'ftyp' box: 4-byte size, 'ftyp', 4-byte major brand, 4-byte
// minor version, then a list of 4-byte compatible brands. HEIC/HEIF/AVIF
// all live in this container family; only the brand tells them apart.
// Real iPhone photos use HEVC-coded single images ('heic'/'mif1'+'heic'),
// which sharp's bundled libheif build cannot decode (see README) — those
// brands are routed to the system `heif-convert` tool instead. AVIF
// ('avif'/'avis') and anything sharp already understands (jpeg/png/webp/
// gif/tiff/svg) go straight through sharp.
const HEVC_HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function readFtypBrands(buf) {
  if (buf.length < 16 || buf.toString("ascii", 4, 8) !== "ftyp") return null;
  const major = buf.toString("ascii", 8, 12).replace(/\0/g, "").trim();
  const compatible = [];
  for (let off = 16; off + 4 <= buf.length && off < 12 + 4 * 32; off += 4) {
    compatible.push(buf.toString("ascii", off, off + 4).replace(/\0/g, "").trim());
  }
  return { major, compatible: compatible.filter(Boolean) };
}

function looksLikeHevcHeif(buf) {
  const brands = readFtypBrands(buf);
  if (!brands) return false;
  const all = [brands.major, ...brands.compatible];
  if (all.some((b) => AVIF_BRANDS.has(b))) return false; // AVIF: sharp handles it natively
  return all.some((b) => HEVC_HEIF_BRANDS.has(b));
}

// ---- PDF -> image -----------------------------------------------------

async function pdfPageCount(pdfPath) {
  const { code, stdout, stderr } = await run("pdfinfo", [pdfPath], { timeoutMs: 10000 });
  if (code !== 0) {
    throw new MediaError("invalid_pdf", `this file could not be read as a PDF (${stderr.slice(0, 200) || "pdfinfo error"})`);
  }
  const m = stdout.toString("utf8").match(/^Pages:\s*(\d+)/m);
  if (!m) throw new MediaError("invalid_pdf", "could not determine the page count");
  return Number(m[1]);
}

async function renderPdfPage(pdfBuffer, { page = 1, dpi = 150, format = "png" } = {}) {
  if (!Number.isInteger(page) || page < 1) {
    throw new MediaError("invalid_input", "'page' must be a positive integer (pages are 1-indexed)");
  }
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) {
    throw new MediaError("invalid_input", "'dpi' must be between 36 and 600");
  }
  if (format !== "png" && format !== "jpeg") {
    throw new MediaError("invalid_input", "'format' must be 'png' or 'jpeg'");
  }
  if (pdfBuffer.length < 5 || pdfBuffer.toString("ascii", 0, 5) !== "%PDF-") {
    throw new MediaError("invalid_input", "input does not look like a PDF (missing the '%PDF-' header)");
  }

  return withTempDir(async (dir) => {
    const pdfPath = path.join(dir, "in.pdf");
    await fs.writeFile(pdfPath, pdfBuffer);

    const pageCount = await pdfPageCount(pdfPath);
    if (page > pageCount) {
      throw new MediaError("invalid_input", `'page' ${page} is out of range — this PDF has ${pageCount} page(s)`);
    }

    const outPrefix = path.join(dir, "out");
    const formatFlag = format === "jpeg" ? "-jpeg" : "-png";
    // -singlefile writes exactly "<prefix>.<ext>" with no digit suffix,
    // regardless of which page number was rendered — avoids having to
    // reverse-engineer poppler's zero-padding scheme for the normal
    // (non-singlefile) naming convention, which pads to the digit-width
    // of the document's total page count (verified: an 11-page doc names
    // page 9 "prefix-09.png", not "prefix-9.png").
    const { code, stderr } = await run(
      "pdftoppm",
      ["-singlefile", formatFlag, "-r", String(dpi), "-f", String(page), "-l", String(page), pdfPath, outPrefix],
      { timeoutMs: 20000 }
    );
    const ext = format === "jpeg" ? "jpg" : "png";
    const outPath = `${outPrefix}.${ext}`;
    if (code !== 0 || !(await fs.stat(outPath).catch(() => null))) {
      throw new MediaError("render_failed", `pdftoppm could not render page ${page} (${stderr.slice(0, 200) || "unknown error"})`);
    }
    const imageBuffer = await fs.readFile(outPath);
    const meta = await sharp(imageBuffer).metadata();
    return {
      page,
      page_count: pageCount,
      dpi,
      format,
      width: meta.width,
      height: meta.height,
      image_base64: imageBuffer.toString("base64"),
    };
  });
}

// ---- image format conversion -------------------------------------------

async function decodeViaHeifConvert(buffer) {
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, "in.heic");
    await fs.writeFile(inPath, buffer);
    const outPrefix = path.join(dir, "out"); // heif-convert appends "-<n>.png" per image in the container
    const { code, stderr } = await run("heif-convert", [inPath, `${outPrefix}.png`], { timeoutMs: 20000 });
    if (code !== 0) {
      throw new MediaError("unsupported_format", `heif-convert could not decode this file (${stderr.slice(0, 200) || "unknown error"})`);
    }
    // A single-image HEIC produces "out.png" or "out-1.png" depending on
    // libheif version; a burst/sequence file produces "out-1.png",
    // "out-2.png", ... — always take the first (primary) image.
    const candidates = [`${outPrefix}.png`, `${outPrefix}-1.png`];
    for (const c of candidates) {
      const buf = await fs.readFile(c).catch(() => null);
      if (buf) return buf;
    }
    throw new MediaError("unsupported_format", "heif-convert reported success but produced no readable output image");
  });
}

// Runs the actual decode + resize + re-encode. Deliberately does the whole
// thing — including the final pixel-level encode — inside one call: sharp
// can read *container-level* metadata (width/height/format) for a file it
// is later unable to decode at the pixel level (confirmed during this
// build: .metadata() on a real HEVC-coded HEIC succeeds, and the actual
// decode error only surfaces from .toBuffer()). Catching only around
// metadata() would let that failure escape uncaught; catching around the
// whole pipeline is what actually detects it.
async function runSharpPipeline(buffer, { target, quality, maxWidth }) {
  let pipeline = sharp(buffer, { limitInputPixels: MAX_OUTPUT_PIXELS });
  const meta = await pipeline.metadata();
  if (maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  const encodeOpts = quality !== undefined ? { quality: Math.round(quality) } : undefined;
  pipeline = pipeline.toFormat(target, encodeOpts);
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { detectedFormat: meta.format, data, info };
}

async function convertImage(imageBuffer, { to = "png", quality, maxWidth } = {}) {
  const target = String(to || "png").toLowerCase();
  if (!IMAGE_FORMATS.has(target)) {
    throw new MediaError("invalid_input", `'to' must be one of: ${[...IMAGE_FORMATS].join(", ")}`);
  }
  if (quality !== undefined && (!Number.isFinite(quality) || quality < 1 || quality > 100)) {
    throw new MediaError("invalid_input", "'quality' must be a number between 1 and 100");
  }
  if (maxWidth !== undefined && (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8000)) {
    throw new MediaError("invalid_input", "'max_width' must be a positive integer up to 8000");
  }

  let result;
  try {
    result = await runSharpPipeline(imageBuffer, { target, quality, maxWidth });
  } catch (e) {
    // sharp's bundled libheif build only decodes AVIF, not real HEIC/HEVC
    // photos — this is the expected, verified failure mode for those files
    // (see README "Verification"), not a generic error. Fall back to the
    // system heif-convert tool, which has the libde265 HEVC plugin, then
    // re-run the identical pipeline on the PNG it produces.
    if (looksLikeHevcHeif(imageBuffer)) {
      const pngBuffer = await decodeViaHeifConvert(imageBuffer);
      const viaFallback = await runSharpPipeline(pngBuffer, { target, quality, maxWidth });
      result = { ...viaFallback, detectedFormat: "heic" };
    } else {
      throw new MediaError("invalid_input", `could not decode this file as an image (${String(e.message || e).slice(0, 150)})`);
    }
  }

  return {
    detected_format: result.detectedFormat,
    output_format: target,
    width: result.info.width,
    height: result.info.height,
    image_base64: result.data.toString("base64"),
  };
}

module.exports = { MediaError, renderPdfPage, convertImage, looksLikeHevcHeif, readFtypBrands };
