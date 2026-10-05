// Pi -> hub push when the hub's catalog lags the Pi's: rows for series the hub doesn't know yet
// are resent on later pushes until the hub accepts them, even though the cursor moved on.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");
const { push, apply } = require("../lib/sync");
const { makeFetch } = require("./stub-upstream");

test("series unknown to the hub are resent once the hub knows them", async () => {
  const catalog = catalogLib.load();
  const now = new Date("2026-10-04T06:00:00Z");
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-pi-"));
  const pi = dbLib.open({ dataDir: piDir });
  await collectOnce(pi, catalog, { now, dataDir: piDir, env: {}, sources: ["openfda"], fetchImpl: makeFetch(catalog, { now }) });
  assert.ok(pi.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = 'openfda:LLY:approvals_weekly'").get().n > 0);

  const NEW = "openfda:LLY:approvals_weekly";
  const oldCatalog = { ...catalog, series: catalog.series.filter((s) => s.series_id !== NEW) };
  const hub = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-hub-")) });
  let hubCatalog = oldCatalog;
  dbLib.syncCatalog(hub, hubCatalog, now.toISOString());
  const fetchImpl = async (url, init) => {
    const r = apply(hub, hubCatalog, JSON.parse(init.body), now);
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  const count = () => hub.prepare("SELECT COUNT(*) n FROM observations WHERE series_id = ?").get(NEW).n;

  await push(pi, { url: "http://hub", token: "t", fetchImpl });
  assert.equal(count(), 0, "old hub skips the unknown series");
  assert.deepEqual(dbLib.kvGet(pi, "push_unknown_series"), [NEW]);

  await push(pi, { url: "http://hub", token: "t", fetchImpl });
  assert.equal(count(), 0, "still unknown, still queued");
  assert.deepEqual(dbLib.kvGet(pi, "push_unknown_series"), [NEW]);

  hubCatalog = catalog; // hub upgraded
  dbLib.syncCatalog(hub, hubCatalog, now.toISOString());
  const sent = await push(pi, { url: "http://hub", token: "t", fetchImpl });
  assert.ok(count() > 0, "rows arrive once the hub knows the series");
  assert.ok(sent.observations > 0);
  assert.deepEqual(dbLib.kvGet(pi, "push_unknown_series"), []);
});

test("events for entities unknown to the hub are resent once the hub knows them; --resend-events sends all", async () => {
  const catalog = catalogLib.load();
  const now = new Date("2026-10-04T06:00:00Z");
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmic-pi-"));
  const pi = dbLib.open({ dataDir: piDir });
  await collectOnce(pi, catalog, { now, dataDir: piDir, env: {}, sources: ["releases", "fedreg"], fetchImpl: makeFetch(catalog, { now }) });
  const oldCatalog = { ...catalog, entities: catalog.entities.filter((e) => e.entity_id !== "us-calendar"), series: catalog.series.filter((s) => s.entity_id !== "us-calendar") };
  const hub = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-hub-")) });
  let hubCatalog = oldCatalog;
  dbLib.syncCatalog(hub, hubCatalog, now.toISOString());
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, text: async () => JSON.stringify(apply(hub, hubCatalog, JSON.parse(init.body), now)) });
  const cal = () => hub.prepare("SELECT COUNT(*) n FROM events WHERE entity_id = 'us-calendar'").get().n;
  await push(pi, { url: "http://hub", token: "t", fetchImpl });
  assert.equal(cal(), 0);
  assert.deepEqual(dbLib.kvGet(pi, "push_unknown_entities"), ["us-calendar"]);
  hubCatalog = catalog;
  dbLib.syncCatalog(hub, hubCatalog, now.toISOString());
  await push(pi, { url: "http://hub", token: "t", fetchImpl });
  const all = pi.prepare("SELECT COUNT(*) n FROM events WHERE entity_id = 'us-calendar'").get().n;
  assert.equal(cal(), all, "every calendar event arrives once the hub knows the entity");
  assert.deepEqual(dbLib.kvGet(pi, "push_unknown_entities"), []);
  hub.exec("DELETE FROM events");
  const sent = await push(pi, { url: "http://hub", token: "t", fetchImpl, resendEvents: true });
  assert.equal(sent.events, pi.prepare("SELECT COUNT(*) n FROM events").get().n);
  assert.equal(hub.prepare("SELECT COUNT(*) n FROM events").get().n, sent.events);
});
