// Canonical JSON and snapshot ids. snapshot_id = "snap_" + SHA-256 (hex) of the canonical
// JSON of an evidence bundle: object keys sorted at every level, no whitespace, arrays in
// order, numbers as JSON.stringify writes them. Same bundle -> same id on every machine.
"use strict";

const crypto = require("crypto");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function snapshotId(bundle) {
  return `snap_${crypto.createHash("sha256").update(canonicalJson(bundle), "utf8").digest("hex")}`;
}

module.exports = { canonicalJson, snapshotId };
