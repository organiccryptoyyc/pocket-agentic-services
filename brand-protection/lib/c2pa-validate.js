"use strict";
// Content Credentials signature validation with c2patool (0.1.16, owner OK 2026-11-19).
//
// lib/provenance.js only READS a C2PA manifest. This runs the reference validator, c2patool (Content Authenticity
// Initiative, MIT/Apache-2.0), on the file against the official C2PA trust list, and keeps only what may be shown:
// the overall state, whether the signature and every hashed part check out, whether the signer chains to a root on
// the trust list, and the failure codes. Assertion contents (EXIF, GPS) never leave this function.
//
// Both files are baked into the image at build time with pinned checksums (Dockerfile):
//   /opt/c2patool/c2patool              c2patool 0.27.22, x86_64-unknown-linux-gnu (needs glibc >= 2.38)
//   /opt/c2patool/C2PA-TRUST-LIST.pem   c2pa-org/conformance-public @ a95f2c4e (2026-11-04), CC BY 4.0
// Where they are missing (local tests, another platform) the check reports ran: false and the answer keeps
// signature_validated: false, as before.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const TOOL = process.env.BP_C2PATOOL || "/opt/c2patool/c2patool";
const TRUST = process.env.BP_C2PA_TRUST || "/opt/c2patool/C2PA-TRUST-LIST.pem";
const TOOL_VERSION = "0.27.22";
const TRUST_LIST = {
  name: "C2PA trust list",
  source: "https://github.com/c2pa-org/conformance-public/tree/a95f2c4e4be7cd015c394fc5deb188683cbbc944/trust-list",
  commit: "a95f2c4e4be7cd015c394fc5deb188683cbbc944",
  updated: "2026-11-04",
  attribution: "C2PA trust list by the Coalition for Content Provenance and Authenticity (C2PA), CC BY 4.0",
};
const TIMEOUT_MS = 20_000;

// Pure: reduce c2patool's report to what may be shown.
function summarize(report) {
  const state = typeof report.validation_state === "string" ? report.validation_state : null;
  const res = (report.validation_results && report.validation_results.activeManifest) || {};
  const codes = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => x && x.code).filter((c) => typeof c === "string"))];
  const failures = codes(res.failure).length ? codes(res.failure) : codes(report.validation_status);
  const successes = codes(res.success);
  const untrusted = failures.includes("signingCredential.untrusted");
  // Valid = signature and every hashed part check out; Trusted = that, plus the signer chains to a trust-list root.
  const signatureValid = state === "Valid" || state === "Trusted";
  return {
    ran: true,
    tool: `c2patool ${TOOL_VERSION}`,
    state,
    signature_valid: signatureValid,
    signer_on_trust_list: state === "Trusted" || (signatureValid && !untrusted && successes.includes("signingCredential.trusted")),
    timestamp_trusted: successes.includes("timeStamp.trusted"),
    failures,
    trust_list: TRUST_LIST,
  };
}

function parseReport(stdout) {
  const s = String(stdout || "");
  const i = s.indexOf("{");
  if (i < 0) throw new Error("c2patool printed no report");
  return JSON.parse(s.slice(i));
}

const runTool = (file) => new Promise((resolve, reject) => {
  execFile(TOOL, [file, "trust", "--trust_anchors", TRUST], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    // c2patool exits non-zero for some invalid files but still prints the report.
    if (stdout && String(stdout).includes("{")) return resolve(stdout);
    reject(err || new Error("c2patool printed nothing"));
  });
});

function available() {
  try {
    fs.accessSync(TOOL, fs.constants.X_OK);
    fs.accessSync(TRUST, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// bytes: the fetched file. run: injectable (tests). Never throws: a failure is reported as ran: false.
async function validate(bytes, { run = null } = {}) {
  if (!run && !available()) return { ran: false, reason: "validator not installed on this host" };
  const file = path.join(os.tmpdir(), `bp-c2pa-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return summarize(parseReport(await (run || runTool)(file)));
  } catch (e) {
    return { ran: false, reason: `validator could not finish: ${String((e && e.message) || e).split("\n")[0].slice(0, 160)}` };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

module.exports = { validate, summarize, parseReport, TRUST_LIST, TOOL_VERSION };
