// Test-only network stub for agent-trust. Unlike the other two packages,
// this backend's checks are not all HTTP — dns.promises and tls.connect are
// patched here too (before server.js/lib/checks.js load), so the whole
// request pipeline (routing, validation, scoring, caching, error-shaping)
// can be exercised locally without live network access. Canned values are
// either copied verbatim from live calls made during development (RDAP) or,
// for pieces that cannot be verified live from this sandbox (the
// Consolidated Screening List — see README.md "Verification" — and TLS,
// which the sandbox's own egress proxy intercepts), a structurally
// realistic fixture that matches the documented/standard shape.
"use strict";

const dnsMod = require("dns");
const tlsMod = require("tls");
const EventEmitter = require("events");

const realFetch = global.fetch;

// --- fetch stub --------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

global.fetch = async function stubFetch(url, init) {
  const u = new URL(url);
  if (process.env.SIMULATED_UPSTREAM_FAILURE === "1") throw new Error("stub: simulated network failure");

  if (u.hostname === "rdap.org") {
    const domain = decodeURIComponent(u.pathname.split("/").pop());
    if (domain === "doesnotexist-agent-trust-test.example") return jsonResponse({ errorCode: 404 }, 404);
    return jsonResponse({
      ldhName: domain,
      status: ["client delete prohibited", "client transfer prohibited"],
      nameservers: [{ ldhName: "ns1.example.net" }, { ldhName: "ns2.example.net" }],
      secureDNS: { delegationSigned: true },
      events: [
        { eventAction: "registration", eventDate: "2020-01-15T00:00:00Z" },
        { eventAction: "expiration", eventDate: "2027-01-15T00:00:00Z" },
        { eventAction: "last changed", eventDate: "2026-06-01T00:00:00Z" },
      ],
    });
  }
  if (u.hostname === "data.trade.gov") {
    const key = init?.headers?.["Subscription-Key"] || init?.headers?.["Ocp-Apim-Subscription-Key"];
    if (!key) return jsonResponse({ statusCode: 401, message: "Access denied due to missing subscription key." }, 401);
    const q = u.searchParams.get("name") || "";
    if (!q) return jsonResponse({ statusCode: 400, message: "One of the following parameters is required: name, sources, countries, address, full_address." }, 400);
    if (q.toLowerCase().includes("sanctioned-test-entity")) {
      return jsonResponse({ total: 1, results: [{ name: "Sanctioned Test Entity", type: "Entity", programs: ["SDN"], source: "Specially Designated Nationals (SDN) - Treasury Department" }] });
    }
    return jsonResponse({ total: 0, results: [] });
  }
  if (u.hostname.endsWith(".blockscout.com")) {
    // Addresses starting 0x5: the explorer is down (HTML 500), so eth must fall back to RPC.
    if (u.pathname.toLowerCase().includes("/addresses/0x5")) {
      return { ok: false, status: 500, text: async () => "<html>Internal Server Error</html>" };
    }
    if (u.pathname.endsWith("/counters")) {
      return jsonResponse({ transactions_count: "78353", token_transfers_count: "403365" });
    }
    if (u.pathname.toLowerCase().includes("0xffffffffffffffffffffffffffffffffffffff")) return jsonResponse({ message: "Not found" }, 404);
    return jsonResponse({
      is_contract: true, is_verified: true, is_scam: false, reputation: "ok",
      public_tags: [], ens_domain_name: "vitalik.eth", coin_balance: "6712597953701629485",
    });
  }
  if (u.hostname.endsWith(".api.pocket.network")) {
    // JSON-RPC fixtures keyed by the address's first hex digit after 0x:
    // 1 and 5 active EOA, 2 EIP-7702 delegated EOA, 3 contract, 0 no activity, 4 RPC error.
    const { method, params } = JSON.parse(init.body);
    const kind = params[0].slice(2, 3);
    if (kind === "4") return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub: upstream error" } });
    const fixtures = {
      "1": { eth_getCode: "0x", eth_getTransactionCount: "0x46", eth_getBalance: "0xde0b6b3a7640000" },
      "2": { eth_getCode: "0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d", eth_getTransactionCount: "0x5", eth_getBalance: "0x0" },
      "3": { eth_getCode: "0x6080604052", eth_getTransactionCount: "0x1", eth_getBalance: "0x0" },
      "0": { eth_getCode: "0x", eth_getTransactionCount: "0x0", eth_getBalance: "0x0" },
    };
    fixtures["5"] = fixtures["1"];
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: fixtures[kind][method] });
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`stub-network: no fixture for ${url}`);
};

// --- dns stub ------------------------------------------------------------------

const realLookup = dnsMod.promises.lookup;
dnsMod.promises.lookup = async function stubLookup(hostname, opts) {
  if (process.env.SIMULATED_DNS_PRIVATE_IP === "1") {
    return opts?.all ? [{ address: "10.0.0.5", family: 4 }] : { address: "10.0.0.5", family: 4 };
  }
  if (hostname === "doesnotexist-agent-trust-test.example") {
    const e = new Error("getaddrinfo ENOTFOUND");
    e.code = "ENOTFOUND";
    throw e;
  }
  const result = opts?.all ? [{ address: "93.184.216.34", family: 4 }] : { address: "93.184.216.34", family: 4 };
  return result;
};

dnsMod.promises.resolveMx = async () => [{ exchange: "mx1.example.net", priority: 10 }];
dnsMod.promises.resolveTxt = async (hostname) => {
  if (hostname.startsWith("_dmarc.")) return [["v=DMARC1; p=reject"]];
  return [["v=spf1 include:_spf.example.net ~all"]];
};
dnsMod.promises.resolve4 = async () => ["93.184.216.34"];

// --- tls stub --------------------------------------------------------------------

const realConnect = tlsMod.connect;
tlsMod.connect = function stubConnect(opts, cb) {
  const emitter = new EventEmitter();
  emitter.getPeerCertificate = () => ({
    subject: { CN: opts.servername, O: "Example Corp" },
    issuer: { CN: "Test CA", O: "Test CA Inc" },
    valid_from: "Jan 1 00:00:00 2026 GMT",
    valid_to: "Dec 31 23:59:59 2027 GMT",
    subjectaltname: `DNS:${opts.servername}`,
  });
  emitter.authorized = true;
  emitter.end = () => {};
  emitter.destroy = () => {};
  emitter.setTimeout = () => {};
  if (process.env.SIMULATED_TLS_FAILURE === "1") {
    setImmediate(() => emitter.emit("error", new Error("stub: simulated TLS failure")));
  } else {
    setImmediate(() => cb && cb());
  }
  return emitter;
};

module.exports = { restore: () => { dnsMod.promises.lookup = realLookup; tlsMod.connect = realConnect; global.fetch = realFetch; } };
