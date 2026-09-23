// Unit test for the stale-on-error cache fallback in lib/pocket.js's cached().
// Run: node test/unit-cache.js
"use strict";
const assert = require("assert");
const pocket = require("../lib/pocket");

async function main() {
  // 1) cold start, fetcher throws, no prior cache -> propagates (caller turns
  //    this into a 422, never a 5xx; see lib/http.js).
  let threw = false;
  try {
    await pocket.cached("unit:cold", 1000, async () => { throw new Error("boom"); });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.message, "boom");
  }
  assert.ok(threw, "expected cold-cache failure to propagate");

  // 2) warm cache, fetcher throws on refresh -> stale value served, tagged.
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) return { n: 1 };
    throw new Error("simulated upstream failure");
  };
  const first = await pocket.cached("unit:warm", 10, fetcher); // ttl 10ms, will expire fast
  assert.deepStrictEqual(first.value, { n: 1 });
  assert.strictEqual(first.stale, false);

  await new Promise((r) => setTimeout(r, 20)); // let the 10ms TTL expire

  const second = await pocket.cached("unit:warm", 10, fetcher);
  assert.deepStrictEqual(second.value, { n: 1 }, "should fall back to the last good value");
  assert.strictEqual(second.stale, true, "fallback must be tagged stale");
  assert.ok(second.ageMs >= 20, "age should reflect time since the last good fetch");
  assert.strictEqual(calls, 2, "fetcher should have been retried once on expiry");

  // 3) fresh cache hit within TTL never calls the fetcher again.
  let freshCalls = 0;
  const freshFetcher = async () => { freshCalls++; return { ok: true }; };
  await pocket.cached("unit:fresh", 5000, freshFetcher);
  await pocket.cached("unit:fresh", 5000, freshFetcher);
  assert.strictEqual(freshCalls, 1, "second call within TTL must be a pure cache hit");

  console.log("unit-cache: all assertions passed");
}

main().catch((e) => {
  console.error("unit-cache FAILED:", e);
  process.exit(1);
});
