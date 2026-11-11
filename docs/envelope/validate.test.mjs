// node --test docs/envelope/validate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "pocket-agentic-envelope-v1.schema.json"), "utf8"));
const examples = readdirSync(join(here, "examples")).filter((f) => f.endsWith(".json"));
const load = (f) => JSON.parse(readFileSync(join(here, "examples", f), "utf8"));
const base = () => load("treasury-capital-score.score.json");

test("every example validates", () => {
  assert.ok(examples.length >= 5);
  for (const f of examples) assert.deepEqual(validate(schema, load(f)), [], f);
});

test("examples cover every subject kind used in rollout phase 1-2", () => {
  const kinds = new Set(examples.map((f) => load(f).subject.kind));
  for (const k of ["protocol", "company", "brand", "domain", "topic"]) assert.ok(kinds.has(k), k);
});

const rejects = {
  "unknown top-level field": (e) => { e.extra = 1; },
  "missing subject": (e) => { delete e.subject; },
  "bad subject id": (e) => { e.subject.id = "Aave"; },
  "unknown subject kind": (e) => { e.subject.kind = "person"; },
  "unnormalized status": (e) => { e.assessment.status = "eligible"; },
  "confidence above 100": (e) => { e.assessment.confidence = { score: 101, label: "high" }; },
  "source_tier 0": (e) => { e.evidence[0].source_tier = 0; },
  "unknown rights_status": (e) => { e.evidence[0].rights_status = "public"; },
  "evidence over 50": (e) => { e.evidence = Array(51).fill(e.evidence[0]); },
  "gap without impact": (e) => { delete e.gaps[0].impact; },
  "bad verification_status": (e) => { e.attestation_ref.verification_status = "ok"; },
  "non-ISO as_of": (e) => { e.as_of = "Nov 9 2026"; },
  "wrong schema const": (e) => { e.schema = "pocket-agentic-envelope/2"; },
};
for (const [name, mutate] of Object.entries(rejects)) {
  test(`rejects: ${name}`, () => {
    const e = base();
    mutate(e);
    assert.notDeepEqual(validate(schema, e), [], name);
  });
}
