// The listing generator (packs/ops/build-listings.js) must reproduce the committed marketplace files
// byte for byte, so re-running it never silently drops a hand edit that is live on chain or on the
// portal (the drift found 2026-11-12). Edit the generator's tables, not the generated files.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const OPS = path.join(__dirname, "..", "packs", "ops");

test("build-listings.js output equals the committed files", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-listings-"));
  const log = execFileSync(process.execPath, [path.join(OPS, "build-listings.js")], { env: { ...process.env, PMIC_LISTINGS_OUT: out }, encoding: "utf8" });
  const services = log.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(services.length >= 5);
  for (const s of services) {
    assert.strictEqual(s.card_changed, false, `${s.service_id}: the card would change; update the generator or re-register the card`);
    for (const f of ["card.json", "portal-descriptor.json", "openapi.json", "sage-service.yaml"]) {
      const want = fs.readFileSync(path.join(OPS, s.service_id, f), "utf8").replace(/\r\n/g, "\n");
      const got = fs.readFileSync(path.join(out, s.service_id, f), "utf8");
      assert.strictEqual(got, want, `${s.service_id}/${f} differs from the generator's output`);
    }
    assert.ok(Buffer.byteLength(fs.readFileSync(path.join(OPS, s.service_id, "card.json"))) <= 4096, `${s.service_id}: card over 4,096 bytes`);
  }
  const want = fs.readFileSync(path.join(OPS, "pocket-health-checks-entry.yaml"), "utf8").replace(/\r\n/g, "\n");
  assert.strictEqual(fs.readFileSync(path.join(out, "pocket-health-checks-entry.yaml"), "utf8"), want);
  fs.rmSync(out, { recursive: true, force: true });
});
