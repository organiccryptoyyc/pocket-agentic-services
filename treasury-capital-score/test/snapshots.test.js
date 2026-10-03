// Snapshot store (lib/snapshots.js). Synthetic bundles in a throwaway data dir only.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcs6-snap-"));
process.env.TCS6_DATA_DIR = path.join(tmp, "var");

const snapshots = require("../lib/snapshots");
const { snapshotId, canonicalJson } = require("../lib/canonical");
const S = require("../lib/scoring");
const { buildReport } = require("../lib/report");
const { normalizeReport } = require("../lib/golden");

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "evidence-example.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const entity = { entity_id: "example-dao", name: "example-dao", entity_type: "defi_protocol", peer_cohort: "DeFi protocol", registry_status: "partially_verified", eligibility: "confirmed", scoreable: true, treasury_perimeter: "synthetic" };

test("snapshot_id is stable under key order and changes with content", () => {
  const a = clone(EXAMPLE);
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
  assert.strictEqual(snapshotId(a), snapshotId(reordered));
  assert.match(snapshotId(a), /^snap_[0-9a-f]{64}$/);
  const b = clone(EXAMPLE);
  b.holdings[0].quantity += 1;
  assert.notStrictEqual(snapshotId(a), snapshotId(b));
  assert.strictEqual(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("put is idempotent; get verifies integrity; history joins reports", () => {
  const dir = path.join(tmp, "s1");
  const db = snapshots.open(dir);
  const bundle = clone(EXAMPLE);
  const id = db.putSnapshot(bundle);
  assert.strictEqual(db.putSnapshot(clone(EXAMPLE)), id);
  assert.deepStrictEqual(db.counts(), { snapshots: 1, reports: 0 });
  assert.deepStrictEqual(db.getSnapshot(id).bundle, JSON.parse(canonicalJson(bundle)));

  const base = S.computeBase(bundle);
  const report = buildReport(entity, bundle, base, [base.nrt]);
  db.putReport({ snapshot_id: id, spec_version: "tcs-6/1.0", weights_version: "blueprint-v1", report, peer_nrts: [base.nrt] });
  const h = db.history("example-dao");
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].overall_score, report.overall_score.score);
  db.close();
});

test("a stored snapshot reproduces its report (rule 2: reproducible)", () => {
  const dir = path.join(tmp, "s2");
  const db = snapshots.open(dir);
  const bundle = clone(EXAMPLE);
  const base = S.computeBase(bundle);
  const original = buildReport(entity, bundle, base, [base.nrt]);
  const id = db.putSnapshot(bundle);
  db.putReport({ snapshot_id: id, spec_version: "tcs-6/1.0", weights_version: "blueprint-v1", report: original, peer_nrts: [base.nrt] });
  db.close();

  const ro = snapshots.open(dir, { readOnly: true });
  const snap = ro.getSnapshot(id);
  const [stored] = ro.reportsFor(id);
  const again = buildReport(entity, snap.bundle, S.computeBase(snap.bundle), stored.peer_nrts);
  assert.strictEqual(JSON.stringify(normalizeReport(again)), JSON.stringify(normalizeReport(stored.report)));
  ro.close();
});

test("tampered bundle fails the integrity check", () => {
  const dir = path.join(tmp, "s3");
  const db = snapshots.open(dir);
  const id = db.putSnapshot(clone(EXAMPLE));
  db.close();
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(snapshots.dbPath(dir));
  const row = raw.prepare("SELECT bundle_json FROM snapshots WHERE snapshot_id = ?").get(id);
  raw.prepare("UPDATE snapshots SET bundle_json = ? WHERE snapshot_id = ?").run(row.bundle_json.replace('"entity_id":"example-dao"', '"entity_id":"tampered"'), id);
  raw.close();
  const ro = snapshots.open(dir, { readOnly: true });
  assert.throws(() => ro.getSnapshot(id), /integrity/);
  ro.close();
});

test("read-only handle cannot write; missing db opens as null", () => {
  assert.strictEqual(snapshots.open(path.join(tmp, "absent"), { readOnly: true }), null);
  const dir = path.join(tmp, "s4");
  snapshots.open(dir).close();
  const ro = snapshots.open(dir, { readOnly: true });
  assert.throws(() => ro.putSnapshot(clone(EXAMPLE)), /read-only/);
  ro.close();
});

test("migrations are recorded once and re-open cleanly", () => {
  const dir = path.join(tmp, "s5");
  snapshots.open(dir).close();
  const db = snapshots.open(dir);
  db.close();
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(snapshots.dbPath(dir), { readOnly: true });
  const rows = raw.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
  assert.deepStrictEqual(rows, ["001_snapshots.sql"]);
  assert.strictEqual(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  raw.close();
});

test("daily backup is written once per day; size status reports bytes", () => {
  const dir = path.join(tmp, "s6");
  const db = snapshots.open(dir);
  db.putSnapshot(clone(EXAMPLE));
  const day = new Date("2026-10-02T12:00:00Z");
  const first = db.backupIfDue(day);
  assert.ok(first && fs.existsSync(first));
  assert.strictEqual(db.backupIfDue(day), null);
  const s = db.sizeStatus();
  assert.ok(s.bytes > 0);
  assert.strictEqual(s.alert, false);
  db.close();
});

test("pipeline with TCS6_SNAPSHOTS=1 writes the same report and records the snapshot", () => {
  process.env.TCS6_REGISTRY = path.join(tmp, "registry.json");
  fs.writeFileSync(process.env.TCS6_REGISTRY, JSON.stringify({ entities: [entity] }));
  const store = require("../lib/store");
  const { runOnce } = require("../pipeline/run");
  store.ensureDirs();
  const bundle = clone(EXAMPLE);
  bundle.collected_at = new Date().toISOString();
  store.writeJsonAtomic(store.paths.evidence("example-dao"), bundle);

  delete process.env.TCS6_SNAPSHOTS;
  const off = runOnce();
  const reportOff = store.readJson(store.paths.report("example-dao"));
  assert.strictEqual(off.snapshots, undefined);

  process.env.TCS6_SNAPSHOTS = "1";
  const on = runOnce();
  delete process.env.TCS6_SNAPSHOTS;
  const reportOn = store.readJson(store.paths.report("example-dao"));
  assert.deepStrictEqual(on.snapshot_errors, []);
  assert.strictEqual(JSON.stringify(normalizeReport(reportOn)), JSON.stringify(normalizeReport(reportOff)));
  assert.strictEqual(on.scored[0].snapshot_id, snapshotId(bundle));
  assert.strictEqual(on.snapshots.snapshots, 1);

  const ro = snapshots.open(store.DATA_DIR, { readOnly: true });
  assert.strictEqual(ro.history("example-dao").length, 1);
  ro.close();
});
