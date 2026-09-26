// Process/temp-file plumbing shared by media.js and transcribe.js. No
// dependencies. Every external tool this service shells out to (pdftoppm,
// pdfinfo, heif-convert, ffmpeg, ffprobe, a whisper.cpp binary) is invoked
// with an argv array, never a shell string — no user-controlled bytes ever
// pass through a shell, so there is no command-injection surface regardless
// of what a caller's base64 payload decodes to.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const os = require("os");
const path = require("path");

class ExecError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = "ExecError";
    this.exitCode = code;
    this.stderr = stderr;
  }
}

/**
 * Run `cmd args...`, capturing stdout/stderr, killing it on a timeout.
 * Resolves with {code, stdout, stderr} even on a non-zero exit — callers
 * decide what a non-zero exit means for their tool. Rejects only if the
 * binary itself could not be spawned (e.g. not installed) or timed out.
 */
function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new ExecError(`could not start '${cmd}': ${e.message}`));
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on("data", (d) => { stderr = Buffer.concat([stderr, d]); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ExecError(`'${cmd}' failed to run: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new ExecError(`'${cmd}' exceeded its ${timeoutMs}ms budget and was killed`));
      }
      resolve({ code, stdout, stderr: stderr.toString("utf8") });
    });
  });
}

/** Run `fn(dir)` with a fresh temp directory, always cleaned up after. */
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-utils-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * True if `cmd` resolves and is executable (used for optional-tool checks,
 * e.g. WHISPER_BIN before attempting a real transcription).
 *
 * Two real, distinct cases, handled differently on purpose:
 *  - `cmd` contains a path separator (e.g. "/usr/local/bin/whisper-cli",
 *    the exact form the Dockerfile's ENV WHISPER_BIN sets): stat it
 *    directly and check the executable bit. No shell involved at all.
 *  - `cmd` is a bare name (e.g. "ffmpeg"): resolve it via `command -v` on
 *    PATH, through a locked-down `sh -c` whose argument is sanitized to
 *    a safe bare-word character class first (defends against shell
 *    metacharacters, since this is the one place in this codebase that
 *    does reach a shell).
 *
 * Root cause of a real bug this fixes (found via the first real relay
 * test against the deployed box, 2026-09-26): the sanitizing regex used
 * to run unconditionally and stripped '/' along with shell metacharacters
 * -- harmless for a bare name, but it silently mangled
 * "/usr/local/bin/whisper-cli" into "usrlocalbinwhisper-cli", which
 * `command -v` could never find, so isConfigured() reported the backend
 * as unconfigured even when whisper.cpp was correctly built and present.
 * Not a hypothetical: this shipped and was only caught because the
 * audio-transcribe endpoint was actually relay-tested for real instead
 * of being trusted on the strength of the Docker build log alone.
 */
async function which(cmd) {
  if (cmd.includes("/")) {
    try {
      await fs.access(cmd, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const { code } = await run("sh", ["-c", `command -v ${cmd.replace(/[^a-zA-Z0-9._-]/g, "")}`], { timeoutMs: 3000 });
    return code === 0;
  } catch {
    return false;
  }
}

module.exports = { run, withTempDir, which, ExecError };
