// Zero-dependency validator for methodology/tcs6_paid_response_schema_v1.json.
//
// Supports exactly the JSON Schema keywords that file uses (type, enum,
// const, required, properties, additionalProperties:false, items, $ref into
// #/$defs) and throws on any other keyword, so a future schema edit can never
// be silently half-validated. Adds the server-side rules the schema states in
// prose: exactly one each of D1-D6 with weights totaling 100, and no Tier-3
// gateway error substrings in any free-text field.
"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "methodology", "tcs6_paid_response_schema_v1.json"), "utf8"));
const KNOWN = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "type", "enum", "const", "required", "properties", "additionalProperties", "items"]);
// SAGE first-2KB phrase groups (supplier, chain/data, over-servicing), copied
// from pocket-service-builder lint_backend.py. Supplier phrases are also
// rewritten by sanitize(); the rest fail validation so a curator rewords them.
const FORBIDDEN_PHRASES = [
  "connection refused", "connection reset", "timeout", "bad gateway", "service unavailable",
  "missing trie node", "node is unhealthy", "block not found", "header not found", "state not available",
  "pruned state", "metadata is not found", "historical state", "state has been pruned", "block has been pruned",
  "is pruned", "height is not available", "lowest height is", "haven't been fully indexed", "not been fully indexed",
  "lite fullnode", "api is not supported", "excluded from account secondary indexes",
  "offchain rate limit hit by relayer proxy", "session relay limit reached", "claimable portion fully consumed",
];
const FORBIDDEN_TEXT = { test: (s) => { const l = s.toLowerCase(); return FORBIDDEN_PHRASES.some((p) => l.includes(p)); } };

function typeOk(v, t) {
  switch (t) {
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    default: throw new Error(`schema uses unsupported type '${t}'`);
  }
}

function check(node, v, at, errors, root = SCHEMA) {
  for (const k of Object.keys(node)) if (!KNOWN.has(k)) throw new Error(`schema keyword '${k}' at ${at} is not supported by lib/schema.js`);
  if (node.$ref) {
    const name = node.$ref.replace(/^#\/\$defs\//, "");
    return check(root.$defs[name], v, at, errors, root);
  }
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => typeOk(v, t))) return errors.push(`${at}: expected ${types.join("|")}`);
  }
  if ("const" in node && v !== node.const) errors.push(`${at}: must equal ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(v)) errors.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (typeOk(v, "object")) {
    for (const r of node.required || []) if (!(r in v)) errors.push(`${at}: missing '${r}'`);
    const props = node.properties || {};
    for (const [k, val] of Object.entries(v)) {
      if (props[k]) check(props[k], val, `${at}.${k}`, errors, root);
      else if (node.additionalProperties === false) errors.push(`${at}: unexpected property '${k}'`);
    }
  }
  if (Array.isArray(v) && node.items) v.forEach((x, i) => check(node.items, x, `${at}[${i}]`, errors, root));
}

function scanText(v, at, errors) {
  if (typeof v === "string") {
    if (FORBIDDEN_TEXT.test(v)) errors.push(`${at}: contains a gateway error substring`);
  } else if (Array.isArray(v)) v.forEach((x, i) => scanText(x, `${at}[${i}]`, errors));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scanText(x, `${at}.${k}`, errors);
}

function validateReport(report) {
  const errors = [];
  check(SCHEMA, report, "$", errors);
  if (Array.isArray(report && report.dimensions)) {
    const ids = report.dimensions.map((d) => d.id).sort().join(",");
    if (ids !== "D1,D2,D3,D4,D5,D6") errors.push(`$.dimensions: need exactly one each of D1-D6, got ${ids}`);
    const w = report.dimensions.reduce((s, d) => s + (d.weight_pct || 0), 0);
    if (w !== 100) errors.push(`$.dimensions: weights total ${w}, expected 100`);
  }
  scanText(report, "$", errors);
  return { ok: errors.length === 0, errors };
}

// Same keyword subset, any schema (e.g. spec/evidence_input_v1.schema.json).
function validate(schema, value) {
  const errors = [];
  check(schema, value, "$", errors, schema);
  return { ok: errors.length === 0, errors };
}

module.exports = { validateReport, validate, SCHEMA };
