// Unit test for the supplier settings added for PNF issue #6: upstream URL overrides, the
// maximum stale age, and the network reported by /v1/version.
// Run: node test/unit-config.js
"use strict";
const assert = require("assert");
const http = require("http");

process.env.POCKET_NETWORK = "beta";
process.env.POCKET_LCD_URL = "http://lcd.example:1317/";
process.env.POCKET_INDEXER_URL = "http://indexer.example/graphql";
process.env.POCKET_MAX_STALE_MS = "50";
const pocket = require("../lib/pocket");
const { createServer } = require("../lib/http");

async function main() {
  // 1) overrides win, a trailing slash is dropped, an unset override keeps the public URL.
  assert.strictEqual(pocket.NETWORK, "beta");
  assert.strictEqual(pocket.LCD_URL, "http://lcd.example:1317");
  assert.strictEqual(pocket.INDEXER_URL, "http://indexer.example/graphql");
  assert.strictEqual(pocket.RPC_URL, pocket.RPC.beta);
  assert.strictEqual(pocket.MAX_STALE_MS, 50);

  // 2) a stale value is served within the limit and refused beyond it.
  let calls = 0;
  const fetcher = async () => { if (++calls === 1) return { n: 1 }; throw new Error("upstream down"); };
  await pocket.cached("cfg:stale", 1, fetcher);
  await new Promise((r) => setTimeout(r, 10));
  const within = await pocket.cached("cfg:stale", 1, fetcher);
  assert.strictEqual(within.stale, true, "within the limit the last good value is served, tagged stale");
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(pocket.cached("cfg:stale", 1, fetcher), /upstream down/, "beyond the limit the error propagates");

  // 3) /v1/version carries the network so a card healthcheck can pin it.
  const server = createServer({ service: "pokt-network-intel", version: "test", versionPath: "/v1/version", healthPath: "/v1/health",
    routes: new Map(), info: { network: pocket.NETWORK } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/v1/version`, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(JSON.parse(s)));
    }).on("error", reject);
  });
  server.close();
  assert.deepStrictEqual(body, { service: "pokt-network-intel", version: "test", network: "beta" });

  console.log("unit-config: all assertions passed");
}

main().catch((e) => {
  console.error("unit-config FAILED:", e);
  process.exit(1);
});
