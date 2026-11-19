// node --test test/photo.test.js  (no network: files are built here; ZKsync and IPFS reads are stubbed)
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const ph = require("../lib/photo");

// --- tiny DER builders (same shape as provenance.test.js) ----------------------------------------
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...xs) => tlv(0x30, Buffer.concat(xs));
const set = (...xs) => tlv(0x31, Buffer.concat(xs));
const oid = (bytes) => tlv(0x06, Buffer.from(bytes));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const name = (cn, o) => seq(set(seq(oid([0x55, 0x04, 0x0a]), utf8(o))), set(seq(oid([0x55, 0x04, 0x03]), utf8(cn))));
function cert({ subject, issuer, ca = false }) {
  const bc = seq(oid([0x55, 0x1d, 0x13]), tlv(0x01, Buffer.from([0xff])), tlv(0x04, ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq()));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1, 2, 3])),
    seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])), name(issuer[0], issuer[1]),
    seq(tlv(0x17, Buffer.from("250101000000Z")), tlv(0x17, Buffer.from("300101000000Z"))), name(subject[0], subject[1]),
    seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])), tlv(0xa3, seq(bc)), tlv(0x04, Buffer.alloc(200, 0x41)),
  );
  return seq(tbs, seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])), tlv(0x03, Buffer.from([0, 1, 2])));
}

const ME = "0xA11CE0000000000000000000000000000000BEEF";
const OTHER = "0x0000000000000000000000000000000000000001";
const BLOCK_HEADER = "0x" + "ab".repeat(32);
const LAT = "12.3456789"; // synthetic coordinates: must never appear in any output
const LON = "-98.7654321";

function nodleManifest({ signer = ME, gps = true } = {}) {
  return Buffer.concat([
    Buffer.from("....jumb....jumdc2pa...c2pa.claim dc:titleqAuthentic Content "),
    Buffer.from(gps ? `stds.exif {"exif:GPSLatitude":"${LAT}","exif:GPSLongitude":"${LON}"} ` : "stds.exif {} "),
    Buffer.from(`com.nodle.chain ..\xa2gaddressx*${signer}lblock_headerxB${BLOCK_HEADER} `, "latin1"),
    cert({ subject: [signer, "Click Camera"], issuer: ["Click Camera", "ContentSign by Nodle"] }),
    cert({ subject: ["Click Camera", "ContentSign by Nodle"], issuer: ["ContentSign Root", "ContentSign by Nodle"], ca: true }),
  ]);
}
function jpeg(app11, extra = 0) {
  const seg = app11 ? Buffer.concat([Buffer.from([0xff, 0xeb]), Buffer.from([(app11.length + 2) >> 8, (app11.length + 2) & 255]), app11]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(64, 7 + extra), Buffer.from([0xff, 0xd9])]);
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// --- chain + IPFS stubs ---------------------------------------------------------------------------
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encStr = (s) => { const b = Buffer.from(s); return "0x" + word("20") + word(b.length.toString(16)) + b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0"); };
const TX = "0x" + "f1".repeat(32);

// mints: [{ tokenId, owner, hash }]; the token URI of token N is ipfs://Qm<N padded>.
function world(mints, { calls = [] } = {}) {
  const cidFor = (id) => "Qm" + String(id).padStart(44, "x");
  const logFor = (m, i) => ({
    address: ph.CONTENTSIGN, topics: [TRANSFER, "0x" + "0".repeat(64), "0x" + word(m.owner), "0x" + word(m.tokenId.toString(16))],
    transactionHash: i === 0 ? TX : "0x" + String(i).padStart(64, "0"), blockNumber: "0x" + (1000 + i).toString(16),
  });
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_getLogs") {
      const who = params[0].topics[2].slice(26);
      return mints.map(logFor).filter((l) => l.topics[2].slice(26) === who);
    }
    if (method === "eth_call") {
      const id = parseInt(params[0].data.slice(10), 16);
      return encStr("ipfs://" + cidFor(id));
    }
    if (method === "eth_getTransactionReceipt") {
      if (params[0] !== TX) return null;
      return { status: "0x1", logs: [logFor(mints[0], 0)] };
    }
    if (method === "eth_getBlockByNumber") return { timestamp: "0x" + (1767225000).toString(16) };
    if (method === "eth_blockNumber") return "0x" + (5000).toString(16);
    throw new Error("unexpected " + method);
  };
  const fetchJson = async (cid) => {
    const m = mints.find((x) => cidFor(x.tokenId) === cid);
    return {
      name: "Click taken on January 1, 2026", content_hash: m.hash, image: "ipfs://QmImage",
      attributes: [
        { trait_type: "Application", value: "Click" }, { trait_type: "Content Type", value: "image/jpeg" },
        { display_type: "date", trait_type: "Capture date", value: 1767225600000 },
        { trait_type: "Latitude", value: LAT }, { trait_type: "Longitude", value: LON },
        { trait_type: "Location Precision", value: "precise" },
      ],
    };
  };
  return { rpc, fetchJson };
}

const noCoords = (r) => {
  const s = JSON.stringify(r);
  assert.ok(!s.includes(LAT) && !s.includes(LON), "coordinates leaked into the output");
};

test("a signed Click photo is found by its signer's mints: signed_and_anchored, no coordinates out", async () => {
  const file = jpeg(nodleManifest());
  const w = world([{ tokenId: 101, owner: ME, hash: "00".repeat(32) }, { tokenId: 102, owner: ME, hash: sha(file) }]);
  const r = await ph.verify({ image_url: "https://example.test/p.jpg" }, { ...w, fetchImage: async () => file });
  assert.strictEqual(r.verdict, "signed_and_anchored");
  assert.strictEqual(r.signer_address, ME);
  assert.strictEqual(r.anchor.token_id, 102);
  assert.strictEqual(r.anchor.hash_match, true);
  assert.strictEqual(r.mints_found, 2);
  assert.strictEqual(r.mints_compared, 1); // newest first, stops at the match
  assert.deepStrictEqual(r.content_credentials.signer_issuer, { cn: "Click Camera", o: "ContentSign by Nodle" });
  assert.deepStrictEqual(r.content_credentials.nodle_chain_assertion, { address: ME, block_header: BLOCK_HEADER });
  assert.strictEqual(r.content_credentials.signature_validated, false);
  assert.strictEqual(r.privacy_exposure.precise_location_public, true);
  assert.strictEqual(r.privacy_exposure.file_has_gps, true);
  assert.match(r.statement, /This exact file carries Content Credentials signed by 0xA11CE/);
  noCoords(r);
});

test("an edited copy checked against its transaction: anchor_hash_mismatch", async () => {
  const original = jpeg(nodleManifest());
  const edited = jpeg(nodleManifest(), 1);
  const w = world([{ tokenId: 7, owner: ME, hash: sha(original) }]);
  const r = await ph.verify({ image_url: "https://example.test/e.jpg", tx_hash: TX }, { ...w, fetchImage: async () => edited });
  assert.strictEqual(r.verdict, "anchor_hash_mismatch");
  assert.strictEqual(r.anchor.mode, "tx_hash");
  assert.strictEqual(r.anchor.hash_match, false);
  noCoords(r);
});

test("sha256 plus address, no file: anchored_hash_match and the claim matches", async () => {
  const h = "27".repeat(32);
  const w = world([{ tokenId: 5, owner: ME, hash: h }]);
  const r = await ph.verify({ sha256: h.toUpperCase(), address: ME }, w);
  assert.strictEqual(r.verdict, "anchored_hash_match");
  assert.strictEqual(r.claimed_address_match, true);
  assert.strictEqual(r.privacy_exposure.file_has_gps, null);
  noCoords(r);
});

test("a wrong claimed address can't steer the search: the real anchor is found and the claim is false", async () => {
  const file = jpeg(nodleManifest());
  const w = world([{ tokenId: 9, owner: ME, hash: sha(file) }]);
  const r = await ph.verify({ image_url: "https://example.test/p.jpg", address: OTHER }, { ...w, fetchImage: async () => file });
  assert.strictEqual(r.verdict, "signed_and_anchored");
  assert.strictEqual(r.claimed_address_match, false);
  assert.match(r.statement, /not signed or anchored by the claimed address 0x0{39}1/);
});

test("a screenshot (no credentials) and no address: no_credentials, and no chain reads", async () => {
  const calls = [];
  const w = world([], { calls });
  const r = await ph.verify({ image_url: "https://example.test/s.jpg" }, { ...w, fetchImage: async () => jpeg(null) });
  assert.strictEqual(r.verdict, "no_credentials");
  assert.strictEqual(r.content_credentials.present, false);
  assert.strictEqual(r.anchor, null);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(r.privacy_exposure.file_has_gps, false);
});

test("a transaction that isn't a ContentSign mint gives no anchor and says why", async () => {
  const file = jpeg(nodleManifest());
  const w = world([{ tokenId: 1, owner: ME, hash: sha(file) }]);
  const r = await ph.verify({ image_url: "https://example.test/p.jpg", tx_hash: "0x" + "09".repeat(32) }, { ...w, fetchImage: async () => file });
  assert.strictEqual(r.anchor, null);
  assert.strictEqual(r.anchor_note, "transaction not found on ZKsync Era");
  assert.strictEqual(r.verdict, "signed_not_anchored");
});

test(`at most ${ph.MAX_MINTS} newest mints are compared`, async () => {
  const mints = Array.from({ length: 30 }, (_, i) => ({ tokenId: i + 1, owner: ME, hash: "11".repeat(32) }));
  const w = world(mints);
  const r = await ph.verify({ sha256: "22".repeat(32), address: ME }, w);
  assert.strictEqual(r.mints_found, 30);
  assert.strictEqual(r.mints_compared, ph.MAX_MINTS);
  assert.strictEqual(r.verdict, "not_found");
  // 0.1.15: a no-match says exactly what was searched, up to which block.
  assert.deepStrictEqual(r.searched, {
    chain: "ZKsync Era (chain 324)", contract: ph.CONTENTSIGN, by: "given_address", address: ME, through_block: 5000,
    history_rpc: "https://mainnet.era.zksync.io", metadata_gateways: ["ipfs.filebase.io", "gateway.pinata.cloud"],
  });
});

test("the mint search is pinned to the archive's current block", async () => {
  const seen = [];
  const w = world([{ tokenId: 7, owner: ME, hash: "33".repeat(32) }]);
  const rpc = async (m, p) => { if (m === "eth_getLogs") seen.push(p[0].toBlock); return w.rpc(m, p); };
  const r = await ph.verify({ sha256: "33".repeat(32), address: ME }, { ...w, rpc });
  assert.deepStrictEqual(seen, ["0x1388"]);
  assert.strictEqual(r.searched.through_block, 5000);
  const file = jpeg(nodleManifest());
  const s = await ph.verify({ image_url: "https://example.test/p.jpg" }, { ...world([{ tokenId: 9, owner: ME, hash: sha(file) }]), fetchImage: async () => file });
  assert.strictEqual(s.searched.by, "file_signer_address");
  const t = await ph.verify({ image_url: "https://example.test/p.jpg", tx_hash: "0x" + "09".repeat(32) }, { ...world([]), fetchImage: async () => file });
  assert.strictEqual(t.searched.by, "tx_hash");
  assert.strictEqual(t.searched.through_block, null);
});

test("input checks", async () => {
  const bad = [
    [{}, /give image_url/], [{ sha256: "ab".repeat(32) }, /also give address or tx_hash/],
    [{ sha256: "xyz", address: ME }, /sha256 must be 64 hex/], [{ image_url: "ftp://x" }, /http\(s\) URL/],
    [{ image_url: "https://x", address: "0x12" }, /address must be/], [{ image_url: "https://x", tx_hash: "0x1" }, /tx_hash must be/],
    [{ image_url: 5 }, /must be a string/],
  ];
  for (const [inp, re] of bad) await assert.rejects(ph.verify(inp, world([])), (e) => e instanceof ph.InputError && re.test(e.message));
});

test("GPS detection: EXIF GPS pointer or manifest GPS fields; clean files say false", () => {
  const exifGps = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x14]), Buffer.from("Exif\0\0MM\0*", "latin1"), Buffer.from([0x88, 0x25, 0, 4, 0, 0, 0, 1]), Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
  assert.strictEqual(ph.fileHasGps(exifGps, null), true);
  assert.strictEqual(ph.fileHasGps(jpeg(null), null), false);
  assert.strictEqual(ph.fileHasGps(jpeg(null), Buffer.from('"exif:GPSLatitude":"1"')), true);
});

test("history reads go to the archive RPC only (Pocket's ZKsync node is pruned and answers empty)", () => {
  for (const m of ["eth_getLogs", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber"]) assert.deepStrictEqual(ph.rpcUrlsFor(m), ["https://mainnet.era.zksync.io"]);
  assert.strictEqual(ph.rpcUrlsFor("eth_call")[0], "https://zksync-era.api.pocket.network");
});

test("metadata summary keeps the safe fields and drops coordinates", () => {
  const s = ph.metadataSummary({ name: "n", content_hash: "AB", attributes: [{ trait_type: "Latitude", value: LAT }, { trait_type: "Location Precision", value: "precise" }] });
  assert.strictEqual(s.content_hash, "ab");
  assert.strictEqual(s.location_public, true);
  assert.ok(!JSON.stringify(s).includes(LAT));
  assert.strictEqual(ph.cidOf("ipfs://QmSyntheticTestCid1111111111111111111111111111"), "QmSyntheticTestCid1111111111111111111111111111");
  assert.strictEqual(ph.cidOf("https://evil.test/x"), null);
});
