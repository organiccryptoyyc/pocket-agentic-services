// One-off: send every current bundle to the independent witness now instead of waiting for the Pi's
// next push, wait for the signed result (up to 30 minutes) and store it. Then restart the pipeline
// container so the reports pick it up. Run inside the backend container:
//   docker exec treasury-capital-score-beta-backend node pipeline/witness-now.js
"use strict";

const { createWitnessClient } = require("../lib/witness");
const store = require("../lib/store");

async function main() {
  const queue = process.env.TCS6_WITNESS_QUEUE;
  if (!queue) { console.log("TCS6_WITNESS_QUEUE is not set here: the witness is off on this network"); process.exit(1); }
  const network = process.env.TCS6_NETWORK === "main" ? "main" : "beta";
  const log = (event, data) => console.log(JSON.stringify({ event, ...data }));
  const client = createWitnessClient({ queue: queue.replace(/\/$/, ""), network, log });
  const ids = store.loadRegistry().filter((e) => e.scoreable && store.readJson(store.paths.evidence(e.entity_id))).map((e) => e.entity_id);
  client.noteAccepted(ids);
  const id = await client.flush();
  if (!id) process.exit(1);
  const until = Date.now() + 30 * 60_000;
  for (;;) {
    const open = await client.pollOnce();
    if (!open) break;
    if (Date.now() > until) { console.log("still running after 30 minutes; the backend keeps polling it"); break; }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  console.log("done: now run  docker restart treasury-capital-score-beta-pipeline");
  process.exit(0);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
