// Validates envelope JSON files against pocket-agentic-envelope-v1.schema.json.
// No dependencies: implements only the JSON Schema keywords that schema uses
// (type, const, enum, pattern, minLength, minimum, maximum, maxItems, required,
// properties, additionalProperties, items, oneOf, $ref to #/$defs).
// Usage: node docs/envelope/validate.mjs [file.json ...]   (default: examples/*.json)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "pocket-agentic-envelope-v1.schema.json"), "utf8"));

const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const typeOk = (want, v) => {
  const t = typeOf(v);
  return [].concat(want).some((w) => w === t || (w === "number" && t === "integer"));
};

export function validate(node, value, path = "$", errors = []) {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    return validate(schema.$defs[name], value, path, errors);
  }
  if (node.oneOf) {
    const passing = node.oneOf.filter((n) => validate(n, value, path, []).length === 0);
    if (passing.length !== 1) errors.push(`${path}: matches ${passing.length} of oneOf (needs exactly 1)`);
    return errors;
  }
  if (node.type && !typeOk(node.type, value)) {
    errors.push(`${path}: expected ${[].concat(node.type).join("|")}, got ${typeOf(value)}`);
    return errors;
  }
  if ("const" in node && value !== node.const) errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: does not match ${node.pattern}`);
    if (node.minLength && value.length < node.minLength) errors.push(`${path}: shorter than ${node.minLength}`);
  }
  if (typeof value === "number") {
    if ("minimum" in node && value < node.minimum) errors.push(`${path}: below ${node.minimum}`);
    if ("maximum" in node && value > node.maximum) errors.push(`${path}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if ("maxItems" in node && value.length > node.maxItems) errors.push(`${path}: more than ${node.maxItems} items`);
    if (node.items) value.forEach((v, i) => validate(node.items, v, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === "object") {
    for (const k of node.required || []) if (!(k in value)) errors.push(`${path}: missing ${k}`);
    const props = node.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors);
      else if (node.additionalProperties === false) errors.push(`${path}: unexpected field ${k}`);
      else if (typeof node.additionalProperties === "object") validate(node.additionalProperties, v, `${path}.${k}`, errors);
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : readdirSync(join(here, "examples")).filter((f) => f.endsWith(".json")).map((f) => join(here, "examples", f));
  let bad = 0;
  for (const f of files) {
    const errs = validate(schema, JSON.parse(readFileSync(f, "utf8")));
    console.log(`${errs.length ? "FAIL" : "ok  "} ${f.split(/[\\/]/).pop()}${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    if (errs.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}
