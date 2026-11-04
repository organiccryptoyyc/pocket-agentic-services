// Try the re-check engine from a shell. One live DNS, RDAP, TLS and homepage read.
//
//   node ops/recheck-cli.js <domain> [official-domain ...]
"use strict";

const { recheckDomain } = require("../lib/recheck");

const [domain, ...official] = process.argv.slice(2);
if (!domain) {
  console.error("usage: node ops/recheck-cli.js <domain> [official-domain ...]");
  process.exit(2);
}
recheckDomain({ domain, official_domains: official })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
