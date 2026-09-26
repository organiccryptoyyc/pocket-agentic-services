// Audio transcription via a local whisper.cpp binary — submit + poll, not
// synchronous. Design rule 7 bounds a relay response to the operator's
// relay_timeout (typically 10-30s) and forbids streaming through a
// gateway; a real speech-to-text pass over even a short clip, on CPU, on
// modest supplier hardware, cannot reliably land inside that window. The
// skill's own guidance for this exact situation is "return a handle and
// let the client poll" — that's what /v1/audio-transcribe (submit) and
// /v1/audio-transcribe-status (poll) implement, both fast, synchronous,
// well within budget; the slow work happens between them, off the relay
// path entirely.
//
// NOT independently verified end to end in this build — see README.md
// "Verification". ffmpeg normalization (this file's normalizeToWav) and
// the config/duration/queue logic were exercised for real; the actual
// whisper.cpp invocation and its plain-text output format were written
// against its long-documented CLI/output conventions but could not be run
// here, because the model file lives on a host this build sandbox's own
// network cannot reach (the same class of restriction noted throughout
// this repo for *.pocket.network). Run one real clip through
// POST /v1/audio-transcribe on the deployed box before relying on this
// endpoint, and fix the parsing in `parseWhisperOutput` if the installed
// whisper.cpp version's output line shape has drifted from what's below.
"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { run, withTempDir, which } = require("./exec");

class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.isClientError = true;
  }
}
class NotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.notConfigured = true;
  }
}

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "/opt/whisper/models/ggml-base.en.bin";
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS || 180); // 3 min per job — see README
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 15 * 60 * 1000); // 15 min ceiling for one job
const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT = 1; // one whisper.cpp process at a time; this is a small CPU box, not a GPU cluster

const jobs = new Map(); // job_id -> {status, createdAt, startedAt, finishedAt, result, error}
const queue = [];
let running = 0;

function sweepOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}
const sweepTimer = setInterval(sweepOldJobs, 60_000);
if (sweepTimer.unref) sweepTimer.unref();

async function isConfigured() {
  const [binOk, modelOk] = await Promise.all([
    which(WHISPER_BIN),
    fs.stat(WHISPER_MODEL).then(() => true).catch(() => false),
  ]);
  return binOk && modelOk;
}

async function probeDurationSeconds(filePath) {
  const { code, stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { timeoutMs: 10000 }
  );
  const d = parseFloat(stdout.toString("utf8"));
  if (code !== 0 || !Number.isFinite(d)) {
    throw new MediaError("invalid_input", "could not read this file as audio (ffprobe found no readable stream)");
  }
  return d;
}

async function normalizeToWav(inPath, outPath) {
  const { code, stderr } = await run(
    "ffmpeg",
    ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", outPath],
    { timeoutMs: 60000 }
  );
  if (code !== 0) {
    throw new MediaError("invalid_input", `could not decode this file as audio (${stderr.slice(0, 200) || "ffmpeg error"})`);
  }
}

// whisper.cpp's plain stdout format has been stable since the project's
// earliest releases: one line per segment, "[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text".
// Parsed here instead of the -oj JSON mode because this line shape is the
// one piece of the whisper.cpp contract this build could confirm from the
// project's own long-standing documentation with confidence; the JSON
// schema's exact key names were not (see README).
const SEGMENT_LINE = /^\[(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\]\s?(.*)$/;

function tsToSeconds(ts) {
  const [h, m, s] = ts.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseWhisperOutput(stdout) {
  const segments = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = SEGMENT_LINE.exec(line.trim());
    if (m) segments.push({ start_s: tsToSeconds(m[1]), end_s: tsToSeconds(m[2]), text: m[3].trim() });
  }
  return { segments, text: segments.map((s) => s.text).join(" ").trim() };
}

async function runWhisper(wavPath, { language }) {
  // Deliberately NOT passing "-nt" (no-timestamps): parseWhisperOutput
  // needs the bracketed "[hh:mm:ss.mmm --> hh:mm:ss.mmm]" prefix on each
  // line, which "-nt" would suppress.
  const finalArgs = ["-m", WHISPER_MODEL, "-f", wavPath];
  if (language && language !== "auto") finalArgs.push("-l", language);
  const { code, stdout, stderr } = await run(WHISPER_BIN, finalArgs, { timeoutMs: WHISPER_TIMEOUT_MS });
  const text = stdout.toString("utf8");
  const { segments, text: joined } = parseWhisperOutput(text);
  if (code !== 0 && segments.length === 0) {
    throw new MediaError("transcription_failed", `whisper.cpp exited ${code} with no usable output (${stderr.slice(0, 200) || "no stderr"})`);
  }
  const langMatch = /auto-detected language:\s*([a-z]{2,3})/i.exec(stderr);
  return {
    text: joined,
    segments,
    language: language && language !== "auto" ? language : (langMatch ? langMatch[1] : "auto"),
  };
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  try {
    const result = await withTempDir(async (dir) => {
      const inPath = path.join(dir, "in.audio");
      await fs.writeFile(inPath, job.audioBuffer);
      const durationS = await probeDurationSeconds(inPath);
      if (durationS > MAX_AUDIO_SECONDS) {
        throw new MediaError("invalid_input", `audio is ${durationS.toFixed(1)}s long — this endpoint caps single jobs at ${MAX_AUDIO_SECONDS}s`);
      }
      const wavPath = path.join(dir, "norm.wav");
      await normalizeToWav(inPath, wavPath);
      const transcript = await runWhisper(wavPath, { language: job.language });
      return { duration_s: Math.round(durationS * 10) / 10, ...transcript, model: path.basename(WHISPER_MODEL) };
    });
    job.status = "done";
    job.result = result;
  } catch (e) {
    job.status = "error";
    job.error = { code: e.code || "transcription_failed", message: String(e.message || e).slice(0, 300) };
  } finally {
    job.finishedAt = Date.now();
    job.audioBuffer = null; // free the input bytes as soon as we're done with them
    running -= 1;
    pump();
  }
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    processJob(job); // intentionally not awaited — runs in the background
  }
}

async function submit({ audioBuffer, language }) {
  if (!(await isConfigured())) {
    throw new NotConfiguredError(
      `WHISPER_BIN ('${WHISPER_BIN}') or WHISPER_MODEL ('${WHISPER_MODEL}') is not present on this backend — ` +
      "see README.md for how to build whisper.cpp and fetch a model before staking this endpoint."
    );
  }
  const jobId = crypto.randomUUID();
  const job = { id: jobId, status: "queued", createdAt: Date.now(), audioBuffer, language };
  jobs.set(jobId, job);
  queue.push(job);
  pump();
  return jobId;
}

function getStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const base = { job_id: jobId, status: job.status };
  if (job.status === "done") return { ...base, result: job.result };
  if (job.status === "error") return { ...base, error: job.error };
  return base; // queued | running
}

module.exports = { MediaError, NotConfiguredError, submit, getStatus, isConfigured, MAX_AUDIO_SECONDS, WHISPER_BIN, WHISPER_MODEL };
