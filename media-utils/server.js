// Agent Media Utilities — a Pocket Network service.
//
// Three things an autonomous agent regularly needs and had nowhere to get
// on Pocket's Agentic Portal as of 2026-09-26 (checked against the live
// 99-service catalog at agent.pocket.network before building this — see
// docs/registration-runbook.md §15): turn one page of a PDF into a real
// image, convert an image between formats (including real HEIC/HEVC
// photos, which the portal's existing OCR/chart/extraction services don't
// touch), and transcribe a short voice clip to text. Every conversion runs
// through real, standard, well-tested tools (poppler, sharp/libvips,
// libheif, ffmpeg, whisper.cpp) — nothing here is a stub or a guessed
// format. See README.md "Verification" for exactly what was and wasn't
// run for real during this build.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const media = require("./lib/media");
const transcribe = require("./lib/transcribe");

const SERVICE = "media-utils";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

function requireBase64(body, field) {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ClientError(422, "invalid_input", `field '${field}' is required and must be a non-empty base64 string`);
  }
  let buf;
  try {
    buf = Buffer.from(v, "base64");
  } catch {
    throw new ClientError(422, "invalid_input", `field '${field}' is not valid base64`);
  }
  if (buf.length === 0) {
    throw new ClientError(422, "invalid_input", `field '${field}' did not decode to any bytes`);
  }
  return buf;
}

function toClientError(e) {
  if (e instanceof media.MediaError || e instanceof transcribe.MediaError) {
    return new ClientError(422, e.code || "invalid_input", e.message);
  }
  if (e instanceof transcribe.NotConfiguredError) {
    return new ClientError(422, "not_configured", e.message);
  }
  return e; // let lib/http.js's catch-all turn anything else into a sanitized 422
}

function withMeta(payload) {
  return { service: SERVICE, fetched_at: new Date().toISOString(), ...payload };
}

// --- POST /v1/pdf-render ------------------------------------------------

async function handlePdfRender(body) {
  const pdfBuffer = requireBase64(body, "pdf_base64");
  const page = body?.page !== undefined ? Number(body.page) : 1;
  const dpi = body?.dpi !== undefined ? Number(body.dpi) : 150;
  const format = body?.format !== undefined ? String(body.format).toLowerCase() : "png";
  try {
    const result = await media.renderPdfPage(pdfBuffer, { page, dpi, format });
    return withMeta(result);
  } catch (e) {
    throw toClientError(e);
  }
}

// --- POST /v1/image-convert ----------------------------------------------

async function handleImageConvert(body) {
  const imageBuffer = requireBase64(body, "image_base64");
  const to = body?.to !== undefined ? String(body.to).toLowerCase() : "png";
  const quality = body?.quality !== undefined ? Number(body.quality) : undefined;
  const maxWidth = body?.max_width !== undefined ? Number(body.max_width) : undefined;
  try {
    const result = await media.convertImage(imageBuffer, { to, quality, maxWidth });
    return withMeta(result);
  } catch (e) {
    throw toClientError(e);
  }
}

// --- POST /v1/audio-transcribe (submit) + /v1/audio-transcribe-status (poll) --

async function handleAudioTranscribe(body) {
  const audioBuffer = requireBase64(body, "audio_base64");
  const language = body?.language !== undefined ? String(body.language).toLowerCase() : "auto";
  try {
    const jobId = await transcribe.submit({ audioBuffer, language });
    return withMeta({
      job_id: jobId,
      status: "queued",
      poll: { path: "/v1/audio-transcribe-status", method: "POST", body: { job_id: jobId } },
      note: `transcription runs in the background (design rule 7: no streaming through a gateway) — ` +
        `poll the path above until status is 'done' or 'error'. Jobs are capped at ${transcribe.MAX_AUDIO_SECONDS}s of audio.`,
    });
  } catch (e) {
    throw toClientError(e);
  }
}

async function handleAudioTranscribeStatus(body) {
  const jobId = body?.job_id;
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new ClientError(422, "invalid_input", "field 'job_id' is required (the value returned by POST /v1/audio-transcribe)");
  }
  const status = transcribe.getStatus(jobId);
  if (!status) {
    throw new ClientError(404, "not_found", `no job '${jobId}' — it may have finished more than 15 minutes ago and been swept, or never existed`);
  }
  return withMeta(status);
}

// --- wiring ---------------------------------------------------------------

const routes = new Map([
  ["POST /v1/pdf-render", handlePdfRender],
  ["POST /v1/image-convert", handleImageConvert],
  ["POST /v1/audio-transcribe", handleAudioTranscribe],
  ["POST /v1/audio-transcribe-status", handleAudioTranscribeStatus],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`);
});
