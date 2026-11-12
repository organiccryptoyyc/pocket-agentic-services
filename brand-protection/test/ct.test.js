// node --test test/ct.test.js   (synthetic data only, no network)
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.BP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-ct-"));

const ct = require("../lib/ct");
const store = require("../lib/store");
const follow = require("../ct-follow");
const { ctHits } = require("../lib/ingest");

function u24(n) { const b = Buffer.alloc(3); b.writeUIntBE(n, 0, 3); return b; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function leaf(type, certText) {
  const ts = Buffer.alloc(8); ts.writeBigUInt64BE(1_793_000_000_000n);
  const cert = Buffer.from(certText, "latin1");
  if (type === 0) return Buffer.concat([ts, u16(0), u24(cert.length), cert, u16(0), u16(64), Buffer.alloc(64)]);
  const pre = Buffer.from("precert-bytes");
  return Buffer.concat([ts, u16(1), Buffer.alloc(32, 7), u24(cert.length), cert, u16(3), Buffer.from([1, 2, 3]), u24(pre.length), pre, u16(32), Buffer.alloc(32)]);
}

test("tile path encoding (tlog-tiles)", () => {
  assert.strictEqual(ct.tilePath(5), "005");
  assert.strictEqual(ct.tilePath(1234067), "x001/x234/067");
});

test("data tile parses x509 and precert leaves; names in URLs are ignored", () => {
  const tile = Buffer.concat([
    leaf(0, "\x30\x82junk uniswap-claim.xyz \x82\x0funiswap.org http://ocsp.uniswap-ca.example/ more"),
    leaf(1, "subject www.aave-rewards.app and nothing else"),
    leaf(0, "unrelated.example.com"),
  ]);
  const entries = ct.parseDataTile(tile);
  assert.deepStrictEqual(entries.map((e) => e.type), [0, 1, 0]);
  const kws = ["aave", "uniswap"];
  const bufs = kws.map((k) => Buffer.from(k));
  assert.deepStrictEqual(ct.matchEntry(entries[0].cert, bufs, kws).sort(), ["uniswap-claim.xyz", "uniswap.org"]);
  assert.deepStrictEqual(ct.matchEntry(entries[1].cert, bufs, kws), ["www.aave-rewards.app"]);
  assert.deepStrictEqual(ct.matchEntry(entries[2].cert, bufs, kws), []);
  assert.throws(() => ct.parseDataTile(tile.subarray(0, tile.length - 5)));
});

test("shard selection follows certificate expiry, usable logs only", () => {
  const list = { operators: [
    { name: "Let's Encrypt", tiled_logs: [
      { description: "LE 2026h2", monitoring_url: "https://le/2026h2", state: { usable: {} }, temporal_interval: { start_inclusive: "2026-07-01T00:00:00Z", end_exclusive: "2027-01-01T00:00:00Z" } },
      { description: "LE 2027h1", monitoring_url: "https://le/2027h1", state: { usable: {} }, temporal_interval: { start_inclusive: "2027-01-01T00:00:00Z", end_exclusive: "2027-07-01T00:00:00Z" } },
    ] },
  ] };
  const got = ct.selectLogs(list, ["Let's Encrypt"], 90, Date.parse("2026-11-02T00:00:00Z"));
  assert.deepStrictEqual(got, [{ operator: "Let's Encrypt", name: "LE 2027h1", monitoring_url: "https://le/2027h1/" }]);
});

test("follower keywords come from the backend's watch list (>= 4 chars)", () => {
  store.touchWatch({ brand_id: "uniswap.org", brand: "Uniswap", official_domains: ["uniswap.org"], keywords: [] }, { source: "seed" });
  store.touchWatch({ brand_id: "cow.fi", brand: "CoW", official_domains: ["cow.fi"], keywords: [] }, { source: "seed" });
  assert.deepStrictEqual(follow.loadKeywords().keywords, ["uniswap"]);
});

test("follower pass: starts at the tip, writes hits and position to the data volume", async () => {
  const tile = Buffer.concat(Array.from({ length: 256 }, (_, i) => leaf(0, i === 9 ? "dns uniswap-airdrop.top" : `site${i}.example.com`)));
  const realGet = ct.get;
  ct.get = async (url) => (url.endsWith("checkpoint") ? Buffer.from("origin\n1024\nhash\n") : tile);
  try {
    const pos = {};
    const stats = {};
    const kw = { keywords: ["uniswap"], bufs: [Buffer.from("uniswap")], official: new Set(["uniswap.org"]) };
    await follow.passLog({ name: "L", monitoring_url: "https://l/" }, kw, pos, stats);
    assert.strictEqual(pos.L, 4, "1024 entries = 4 full tiles, starts at tile 3");
    assert.strictEqual(stats.L.entries, 256);
    assert.ok(fs.existsSync(path.join(follow.CT_DIR, "hits.jsonl")), "hits live under <data>/ct/");
    assert.deepStrictEqual(follow.readHits().map((h) => [h.domain, h.index]), [["uniswap-airdrop.top", 3 * 256 + 9]]);
    await follow.passLog({ name: "L", monitoring_url: "https://l/" }, kw, pos, stats);
    assert.strictEqual(stats.L.entries, 256, "no new tiles, nothing re-read");
  } finally {
    ct.get = realGet;
  }
});

test("follower prune keeps 14 days", () => {
  fs.appendFileSync(path.join(follow.CT_DIR, "hits.jsonl"), `${JSON.stringify({ domain: "old.example", seen_at: "2020-01-01T00:00:00Z" })}\n`);
  follow.pruneHits(14);
  assert.ok(follow.readHits().every((h) => h.domain !== "old.example"));
});

test("GET /ingest/ct-hits: not following, then hits filtered by since, staleness flagged", () => {
  fs.rmSync(path.join(follow.CT_DIR, "stats.json"), { force: true });
  const off = ctHits(null);
  assert.strictEqual(off.following, false);
  assert.strictEqual(off.follower_stale, null);

  const now = Date.parse("2026-11-12T03:00:00Z");
  fs.writeFileSync(path.join(follow.CT_DIR, "hits.jsonl"), [
    { domain: "a-uniswap.xyz", seen_at: "2026-11-12T01:00:00Z" },
    { domain: "b-uniswap.xyz", seen_at: "2026-11-12T02:30:00Z" },
  ].map((h) => `${JSON.stringify(h)}\n`).join(""));
  store.writeJsonAtomic(path.join(follow.CT_DIR, "stats.json"), { updated_at: "2026-11-12T02:59:00Z", keywords: 1, logs: { L: { entries: 5 } } });
  const r = ctHits("2026-11-12T02:00:00Z", now);
  assert.strictEqual(r.following, true);
  assert.strictEqual(r.follower_stale, false);
  assert.deepStrictEqual(r.hits.map((h) => h.domain), ["b-uniswap.xyz"]);
  assert.strictEqual(ctHits(null, now + 3_600_000).follower_stale, true, "no update for an hour is stale");
  assert.throws(() => ctHits("yesterday"), /since must be/);
});

test("only brand-shaped names are kept; the brand's own subdomains and words inside other words are dropped", () => {
  const kw = { keywords: ["morpho", "uniswap"], official: new Set(["uniswap.org", "morpho.org"]) };
  assert.strictEqual(follow.keep("uniswap-airdrop.top", kw), true);
  assert.strictEqual(follow.keep("uniswap.claim-now.xyz", kw), true);
  assert.strictEqual(follow.keep("getuniswap.com", kw), true);
  assert.strictEqual(follow.keep("morpho2.finance", kw), true);
  assert.strictEqual(follow.keep("www.metamorphosist.art", kw), false);
  assert.strictEqual(follow.keep("app.uniswap.org", kw), false);
  assert.strictEqual(follow.keep("lemonuniswapshop.com", kw), false);
});
