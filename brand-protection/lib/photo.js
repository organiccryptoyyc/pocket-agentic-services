"use strict";
// Photo provenance check (method bp-photo/1, owner idea 2026-11-18).
//
// Answers "was this photo signed, by which address, and is it anchored on-chain?" from public data only:
//   1. the C2PA Content Credentials inside the file (read with lib/provenance.js; signatures are read, not validated);
//   2. Nodle ContentSign mints on ZKsync Era (contract 0x95b3…05de, "ContentSign"/"SIGNED"): each mint's token
//      metadata on IPFS carries content_hash = SHA-256 of the signed file;
//   3. the file's own SHA-256 compared with that content_hash.
// Privacy rule (owner): the output says only WHETHER a precise location is public; it never repeats coordinates.
// Every network read is injectable (opts.rpc, opts.fetchJson, opts.fetchImage) so tests run offline.

const crypto = require("node:crypto");
const provenance = require("./provenance");
const c2pa = require("./c2pa-validate");

const METHOD = "bp-photo/1";
const CONTENTSIGN = "0x95b3641d549f719eb5105f9550eca4a7a2f305de";
const CHAIN = "zksync-era";
// Pocket's ZKsync Era node is pruned (2026-11-18: first retained block 72,553,805): for older history it
// returns an empty log list or a null receipt rather than an error, which would read as "not anchored".
// History (logs, receipts, old blocks) therefore goes to the archive RPC only; current-state calls may use
// Pocket first.
const ARCHIVE_RPC = "https://mainnet.era.zksync.io";
const STATE_RPCS = ["https://zksync-era.api.pocket.network", ARCHIVE_RPC];
// eth_blockNumber goes to the archive too (0.1.15): it pins the eth_getLogs range there, on the same node.
const HISTORY_METHODS = new Set(["eth_getLogs", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_blockNumber"]);
// Neutral public gateways only. Nodle's own gateway (nodle-community-nfts.myfilebase.com) is NOT used:
// Nodle's legal notices (nodle.com/legal-notices, "Data Mining") bar automated extraction from their site
// without written authorization, so nothing Nodle-controlled is read until legal@nodle.com authorizes it
// (owner, 2026-11-18). ipfs.io / dweb.link / w3s.link answer with a service-worker page, not content.
const IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_URI = "0xc87b56dd";
const MAX_MINTS = 25; // newest mints compared per call
const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const META_MAX_BYTES = 64 * 1024;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;
const LIMITS = [
  "Signatures are read, not validated, and the C2PA trust list is not checked.",
  "On-chain anchors are looked up for Nodle ContentSign (Click app) mints on ZKsync Era only.",
  `Only the ${MAX_MINTS} newest mints of an address are compared.`,
  "A screenshot, crop or re-saved copy has a different SHA-256 and usually loses its Content Credentials.",
];

const VALIDATED_LIMIT = "Signatures and signed hashes are validated with c2patool against the C2PA trust list (c2pa-org/conformance-public, 2026-11-04 copy, CC BY 4.0); a certificate not on that list is reported as untrusted, never as trusted.";

class InputError extends Error {}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const lc = (s) => (typeof s === "string" ? s.toLowerCase() : s);

// --- pure readers -------------------------------------------------------------------------------

// Nodle's own assertion inside the manifest: CBOR { address, block_header }.
function nodleAssertion(region) {
  if (!region) return null;
  const text = region.toString("latin1");
  const at = text.indexOf("com.nodle.chain");
  if (at < 0) return null;
  const tail = text.slice(at, at + 600);
  const a = /address.{1,3}(0x[0-9a-fA-F]{40})/.exec(tail);
  const h = /block_header.{1,3}(0x[0-9a-fA-F]{64})/.exec(tail);
  return { address: a ? a[1] : null, block_header: h ? h[1] : null };
}

// Does the file carry GPS? EXIF GPS IFD pointer (tag 0x8825) in the APP1 Exif segment, or GPS fields in
// the manifest's stds.exif assertion. Only a yes/no ever leaves this function.
function fileHasGps(b, region) {
  if (region && /exif:GPS(Latitude|Longitude)/.test(region.toString("latin1"))) return true;
  if (!(b.length > 4 && b[0] === 0xff && b[1] === 0xd8)) return false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
      const seg = b.subarray(i + 10, i + 2 + len);
      return seg.includes(Buffer.from([0x88, 0x25])) || seg.includes(Buffer.from([0x25, 0x88]));
    }
    i += 2 + len;
  }
  return false;
}

// The token metadata, reduced to what may be shown. Coordinates are never copied out.
function metadataSummary(meta) {
  const attrs = Array.isArray(meta && meta.attributes) ? meta.attributes : [];
  const get = (t) => { const a = attrs.find((x) => x && x.trait_type === t); return a ? a.value : null; };
  const captured = get("Capture date");
  const precision = get("Location Precision");
  return {
    name: typeof meta.name === "string" ? meta.name.slice(0, 120) : null,
    application: get("Application"),
    content_type: get("Content Type"),
    captured_at: typeof captured === "number" ? new Date(captured).toISOString() : null,
    content_hash: typeof meta.content_hash === "string" ? meta.content_hash.toLowerCase() : null,
    image: typeof meta.image === "string" ? meta.image.slice(0, 200) : null,
    location_public: get("Latitude") != null || get("Longitude") != null,
    location_precision: typeof precision === "string" ? precision.slice(0, 20) : null,
  };
}

function decodeString(hex) {
  if (typeof hex !== "string" || hex.length < 130) return null;
  const b = Buffer.from(hex.slice(2), "hex");
  const off = Number(b.readBigUInt64BE(24));
  const len = Number(b.readBigUInt64BE(off + 24));
  return b.subarray(off + 32, off + 32 + len).toString("utf8");
}

function cidOf(uri) {
  const m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{46,100})(\/[A-Za-z0-9._/-]*)?$/.exec(uri || "");
  return m ? m[1] + (m[2] || "") : null;
}

// Pure: the overall answer from the parts. A file whose Content Credentials fail validation (signature or a
// hashed part does not check out: forged, or altered after signing) is reported as such before anything else (0.1.16).
function verdictOf({ fileGiven, credentials, signerAddress, anchor, claimed, validation = null }) {
  if (fileGiven && credentials && validation && validation.ran && !validation.signature_valid) return "credentials_invalid";
  if (anchor && anchor.hash_match) {
    if (!fileGiven) return "anchored_hash_match";
    if (credentials && signerAddress && lc(signerAddress) === lc(anchor.minter)) return "signed_and_anchored";
    return "anchored_hash_match";
  }
  if (anchor && anchor.hash_match === false && anchor.mode === "tx_hash") return "anchor_hash_mismatch";
  if (fileGiven && !credentials) return claimed ? "no_credentials_not_anchored" : "no_credentials";
  if (credentials) return "signed_not_anchored";
  return "not_found";
}

const STATEMENTS = {
  signed_and_anchored: (r) => `This exact file carries Content Credentials signed by ${r.signer_address}, and the same address recorded the file's SHA-256 on ZKsync Era (token #${r.anchor.token_id}, ${r.anchor.block_time}).`,
  anchored_hash_match: (r) => `A ZKsync Era record by ${r.anchor.minter} (token #${r.anchor.token_id}, ${r.anchor.block_time}) holds this file's SHA-256.`,
  anchor_hash_mismatch: () => "The given transaction anchors a different file: this copy has been changed (edited, re-saved or screenshotted) or the transaction belongs to another photo.",
  signed_not_anchored: (r) => `The file carries Content Credentials${r.signer_address ? ` signed by ${r.signer_address}` : ""}, but no matching on-chain record was found among the mints checked.`,
  no_credentials: () => "The file carries no Content Credentials (often a screenshot or a re-saved copy), so its origin can't be read from the file.",
  no_credentials_not_anchored: () => "The file carries no Content Credentials and no on-chain record matched its SHA-256 among the mints checked.",
  not_found: () => "No on-chain record matched among the mints checked.",
  credentials_invalid: (r) => `The file carries Content Credentials, but they fail validation (${(r.validation.failures || []).slice(0, 4).join(", ") || r.validation.state}): the signature or a signed part of the file does not check out, so the stated origin can't be relied on.`,
};

// --- network reads (injectable) -------------------------------------------------------------------

const rpcUrlsFor = (method) => (HISTORY_METHODS.has(method) ? [ARCHIVE_RPC] : STATE_RPCS);

function defaultRpc() {
  return async (method, params) => {
    let last;
    for (const url of rpcUrlsFor(method)) {
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || "rpc error");
        return j.result;
      } catch (e) { last = e; }
    }
    throw new Error(`ZKsync read failed: ${last && last.message}`);
  };
}

function defaultFetchJson() {
  const cache = new Map();
  return async (cid) => {
    if (cache.has(cid)) return cache.get(cid);
    let last;
    for (const g of IPFS_GATEWAYS) {
      try {
        const r = await fetch(g + cid, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.status !== 200 || buf.length > META_MAX_BYTES) throw new Error(`HTTP ${r.status}`);
        const j = JSON.parse(buf.toString("utf8"));
        if (cache.size > 500) cache.clear();
        cache.set(cid, j);
        return j;
      } catch (e) { last = e; }
    }
    throw new Error(`metadata ${cid} unavailable: ${last && last.message}`);
  };
}

function defaultFetchImage() {
  const checks = require("./checks");
  return async (url) => {
    const res = await checks.fetchVetted(url, { maxBytes: IMAGE_MAX_BYTES, largeFile: true });
    if (res.status !== 200) throw new InputError(`image_url returned HTTP ${res.status}`);
    if (res.truncated) throw new InputError(`image is larger than ${IMAGE_MAX_BYTES} bytes`);
    return res.body;
  };
}

async function tokenRecord(rpc, fetchJson, tokenId) {
  const uri = decodeString(await rpc("eth_call", [{ to: CONTENTSIGN, data: TOKEN_URI + pad32(BigInt(tokenId).toString(16)) }, "latest"]));
  const cid = cidOf(uri);
  if (!cid) return { token_id: tokenId, token_uri: uri, error: "token URI is not an IPFS link" };
  try {
    return { token_id: tokenId, token_uri: uri, metadata: metadataSummary(await fetchJson(cid)) };
  } catch (e) {
    return { token_id: tokenId, token_uri: uri, error: "metadata_unavailable" };
  }
}

async function blockTime(rpc, blockHex) {
  const b = await rpc("eth_getBlockByNumber", [blockHex, false]);
  return b ? new Date(Number(BigInt(b.timestamp)) * 1000).toISOString().replace(".000Z", "Z") : null;
}

function anchorFrom(rec, mintLog, time, mode, fileHash) {
  const md = rec.metadata || {};
  return {
    mode, chain: CHAIN, contract: CONTENTSIGN, token_id: rec.token_id,
    minter: "0x" + mintLog.topics[2].slice(26), tx_hash: mintLog.transactionHash,
    block: Number(BigInt(mintLog.blockNumber)), block_time: time, token_uri: rec.token_uri,
    content_hash: md.content_hash || null,
    hash_match: md.content_hash && fileHash ? md.content_hash === fileHash : null,
    application: md.application || null, captured_at: md.captured_at || null,
    metadata_error: rec.error || null,
    _privacy: { location_public: !!md.location_public, location_precision: md.location_precision || null },
  };
}

// --- the check ------------------------------------------------------------------------------------

async function verify(input, opts = {}) {
  const rpc = opts.rpc || defaultRpc();
  const fetchJson = opts.fetchJson || defaultFetchJson();
  const fetchImage = opts.fetchImage || defaultFetchImage();
  const now = opts.now || new Date();
  const q = input || {};
  for (const k of ["address", "tx_hash", "sha256", "image_url"]) {
    if (q[k] != null && typeof q[k] !== "string") throw new InputError(`${k} must be a string`);
  }
  if (q.address && !ADDR_RE.test(q.address)) throw new InputError("address must be a 0x-prefixed 40-hex-character address");
  if (q.tx_hash && !TX_RE.test(q.tx_hash)) throw new InputError("tx_hash must be a 0x-prefixed 64-hex-character hash");
  if (q.sha256 && !SHA_RE.test(q.sha256)) throw new InputError("sha256 must be 64 hex characters");
  if (q.image_url && !/^https?:\/\//i.test(q.image_url)) throw new InputError("image_url must be an http(s) URL");
  if (!q.image_url && !q.sha256) throw new InputError("give image_url (the file is fetched and read) or sha256 (with address or tx_hash)");
  if (!q.image_url && !q.address && !q.tx_hash) throw new InputError("with sha256 alone, also give address or tx_hash");

  const out = { method: METHOD, checked_at: now.toISOString(), input: {} };
  let fileHash = q.sha256 ? q.sha256.toLowerCase() : null;
  let credentials = null;
  let region = null;
  let bytes = null;
  if (q.image_url) {
    bytes = await fetchImage(q.image_url);
    fileHash = sha256(bytes);
    out.input.image_url = q.image_url.slice(0, 500);
    if (q.sha256 && q.sha256.toLowerCase() !== fileHash) out.input.sha256_given_differs = true;
    const rec = provenance.inspectImage(bytes, false);
    region = provenance.manifestRegion(bytes, rec.format, false).region;
    credentials = rec;
  }
  out.file = { sha256: fileHash, bytes: bytes ? bytes.length : null, format: credentials ? credentials.format : null };

  const nodle = nodleAssertion(region);
  const cn = credentials && credentials.signer ? credentials.signer.cn : null;
  const signerAddress = cn && ADDR_RE.test(cn) ? cn : (nodle && nodle.address) || null;
  out.content_credentials = credentials ? {
    present: credentials.content_credentials,
    signer: credentials.signer || null, signer_issuer: credentials.signer_issuer || null,
    test_certificate: credentials.test_certificate || false,
    ai_generated: credentials.ai_generated || false,
    digital_source_type: credentials.digital_source_type || null,
    actions: credentials.actions || [],
    nodle_chain_assertion: nodle,
    signature_validated: false, trust_list_checked: false, signer_on_trust_list: null,
  } : null;
  out.signer_address = signerAddress;

  // 0.1.16: validate the signature and hashes with c2patool against the C2PA trust list (lib/c2pa-validate.js).
  let validation = null;
  if (bytes && credentials && credentials.content_credentials) {
    validation = await (opts.validateC2pa || c2pa.validate)(bytes);
    if (validation.ran) {
      out.content_credentials.signature_validated = validation.signature_valid;
      out.content_credentials.trust_list_checked = true;
      out.content_credentials.signer_on_trust_list = validation.signer_on_trust_list;
    }
    out.content_credentials.validation = validation;
  }

  // Find the anchor: the given tx first, otherwise the address's ContentSign mints.
  let anchor = null;
  let compared = 0;
  // What this answer searched (0.1.15), so a no-match can be replayed: chain, contract, how, and up to which block.
  const searched = {
    chain: "ZKsync Era (chain 324)",
    contract: CONTENTSIGN,
    by: q.tx_hash ? "tx_hash" : null,
    address: null,
    through_block: null,
    history_rpc: ARCHIVE_RPC,
    metadata_gateways: IPFS_GATEWAYS.map((g) => new URL(g).host),
  };
  out.searched = searched;
  if (q.tx_hash) {
    const rc = await rpc("eth_getTransactionReceipt", [q.tx_hash]);
    const mint = rc && (rc.logs || []).find((l) => lc(l.address) === CONTENTSIGN && l.topics && l.topics[0] === TRANSFER && /^0x0{64}$/.test(l.topics[1]));
    if (!rc) out.anchor_note = "transaction not found on ZKsync Era";
    else if (rc.status !== "0x1") out.anchor_note = "transaction failed on chain";
    else if (!mint) out.anchor_note = "transaction is not a ContentSign mint";
    else {
      const rec = await tokenRecord(rpc, fetchJson, BigInt(mint.topics[3]));
      anchor = anchorFrom({ ...rec, token_id: Number(BigInt(mint.topics[3])) }, mint, await blockTime(rpc, mint.blockNumber), "tx_hash", fileHash);
      compared = 1;
    }
  } else {
    // The file's own signer is searched first: a claimed address is checked against the result, never
    // allowed to steer the search away from the real anchor.
    const who = signerAddress || q.address;
    if (who) {
      // Pin the search to a block number (from the same archive node) so the answer can say how far it looked.
      const tip = await rpc("eth_blockNumber", []);
      const toBlock = typeof tip === "string" && /^0x[0-9a-f]+$/i.test(tip) ? tip : "latest";
      Object.assign(searched, { by: signerAddress ? "file_signer_address" : "given_address", address: who, through_block: toBlock === "latest" ? null : Number(BigInt(toBlock)) });
      const logs = (await rpc("eth_getLogs", [{ address: CONTENTSIGN, fromBlock: "0x0", toBlock, topics: [TRANSFER, "0x" + "0".repeat(64), "0x" + pad32(who)] }])) || [];
      const newest = logs.slice(-MAX_MINTS).reverse();
      out.mints_found = logs.length;
      for (const log of newest) {
        compared++;
        const rec = await tokenRecord(rpc, fetchJson, BigInt(log.topics[3]));
        const a = anchorFrom({ ...rec, token_id: Number(BigInt(log.topics[3])) }, log, null, "address", fileHash);
        if (a.hash_match) { a.block_time = await blockTime(rpc, log.blockNumber); anchor = a; break; }
      }
    } else {
      out.anchor_note = "no address to search: the file names no signer address and none was given";
    }
  }
  out.mints_compared = compared;

  const claimed = q.address || null;
  const verdict = verdictOf({ fileGiven: !!bytes, credentials: !!(credentials && credentials.content_credentials), signerAddress, anchor, claimed, validation });
  out.verdict = verdict;
  if (anchor) {
    out.privacy_exposure = {
      precise_location_public: anchor._privacy.location_public && /precise/i.test(anchor._privacy.location_precision || ""),
      location_public: anchor._privacy.location_public,
      file_has_gps: bytes ? fileHasGps(bytes, region) : null,
      note: "The on-chain record's metadata is public and permanent on IPFS. Coordinates are never repeated here.",
    };
    delete anchor._privacy;
  } else if (bytes) {
    out.privacy_exposure = { file_has_gps: fileHasGps(bytes, region), note: "Coordinates are never repeated here." };
  }
  out.anchor = anchor;
  if (claimed) {
    const by = anchor ? anchor.minter : signerAddress;
    out.claimed_address_match = by ? lc(by) === lc(claimed) : null;
  }
  out.statement = STATEMENTS[verdict]({ ...out, anchor, validation });
  if (validation && validation.ran && validation.signature_valid) {
    out.statement += validation.signer_on_trust_list
      ? " The Content Credentials signature was validated and the signer chains to a root on the C2PA trust list."
      : ` The Content Credentials signature was validated (the file is unaltered since signing), but the signing certificate${credentials.signer_issuer && credentials.signer_issuer.o ? ` (issued by ${credentials.signer_issuer.o})` : ""} is not on the C2PA trust list, so it is a self-issued credential, not a trusted one.`;
  } else if (validation && !validation.ran) {
    out.statement += " The signature was not validated this time.";
  }
  if (out.claimed_address_match === false) out.statement += ` It was not signed or anchored by the claimed address ${claimed}.`;
  out.limits = validation && validation.ran ? [VALIDATED_LIMIT, ...LIMITS.slice(1)] : LIMITS;
  return out;
}

module.exports = { verify, verdictOf, nodleAssertion, fileHasGps, metadataSummary, decodeString, cidOf, rpcUrlsFor, InputError, METHOD, CONTENTSIGN, MAX_MINTS };
