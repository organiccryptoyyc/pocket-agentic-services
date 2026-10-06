// Deterministic crypto utilities for the crypto bundle: token unit conversion and address format
// checks (EVM with EIP-55 checksum, Pocket and Cosmos bech32, Bitcoin base58check and bech32/m,
// Tron base58check, Solana base58). No network calls, no keys; inputs are only validated.
"use strict";

const crypto = require("crypto");

// ---- keccak-256 (Ethereum's pre-standard SHA-3), BigInt lanes, short inputs only ---------------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M64 & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

function keccak256(bytes) {
  const rate = 136;
  const msg = Buffer.concat([Buffer.from(bytes), Buffer.alloc(rate - (bytes.length % rate))]);
  msg[bytes.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= msg.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

function eip55(addr) {
  const lower = addr.slice(2).toLowerCase();
  const h = keccak256(Buffer.from(lower, "ascii")).toString("hex");
  return `0x${[...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

// ---- base58 and bech32 ----------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const lead = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
}
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
function b58check(s) {
  const b = b58decode(s);
  if (!b || b.length < 5) return null;
  const body = b.subarray(0, -4);
  return sha256(sha256(body)).subarray(0, 4).equals(b.subarray(-4)) ? body : null;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function bech32(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const str = s.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length || str.length > 90) return null;
  const hrp = str.slice(0, pos);
  const data = [...str.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return null;
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const pm = polymod([...exp, ...data]);
  const variant = pm === 1 ? "bech32" : pm === 0x2bc830a3 ? "bech32m" : null;
  return variant ? { hrp, data: data.slice(0, -6), variant } : null;
}

function addressCheck(body) {
  const a = typeof body.address === "string" ? body.address.trim() : "";
  if (!a || a.length > 120) return { valid: false, error: "field 'address' must be a non-empty string" };
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    const checksummed = eip55(a);
    const mixed = /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2));
    const ok = !mixed || a === checksummed;
    return { address: a, type: "evm", networks: "Ethereum and EVM chains (Base, Arbitrum, Polygon, BSC, Avalanche, Optimism, ...)", valid: ok, checksum: mixed ? (ok ? "valid EIP-55" : "invalid EIP-55: a character's case is wrong (typo?)") : "none (all one case)", checksummed };
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return { address: a, type: "hash_or_key", valid: false, note: "64 hex characters: a transaction hash or private key, not an address. Never share a private key." };
  const b32 = bech32(a);
  if (b32) {
    const kinds = { pokt: "Pocket Network account", poktvaloper: "Pocket Network validator operator", cosmos: "Cosmos Hub account", osmo: "Osmosis account", bc: "Bitcoin (SegWit/Taproot)", tb: "Bitcoin testnet" };
    const v = b32.hrp === "bc" || b32.hrp === "tb" ? (b32.data[0] === 0 ? b32.variant === "bech32" : b32.variant === "bech32m") : b32.variant === "bech32";
    return { address: a, type: "bech32", prefix: b32.hrp, network: kinds[b32.hrp] || `bech32 prefix '${b32.hrp}'`, valid: v, checksum: v ? "valid" : "wrong bech32 variant for this prefix" };
  }
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
    const body = b58check(a);
    return { address: a, type: "tron", network: "Tron", valid: !!(body && body.length === 21 && body[0] === 0x41), checksum: body ? "valid base58check" : "invalid base58check" };
  }
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) {
    const body = b58check(a);
    return { address: a, type: "bitcoin_base58", network: a[0] === "1" ? "Bitcoin (P2PKH)" : "Bitcoin (P2SH)", valid: !!(body && body.length === 21), checksum: body ? "valid base58check" : "invalid base58check" };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    const b = b58decode(a);
    const ok = !!b && b.length === 32;
    return { address: a, type: "solana", network: "Solana (base58 public key; Solana has no checksum)", valid: ok, checksum: "none in the format" };
  }
  return { address: a, type: "unknown", valid: false, note: "not a recognized EVM, bech32 (Pocket, Cosmos, Bitcoin), Tron, Bitcoin base58 or Solana address" };
}

// ---- units ----------------------------------------------------------------------------------
const UNITS = {
  wei: ["ETH", 0], gwei: ["ETH", 9], eth: ["ETH", 18], ether: ["ETH", 18],
  sat: ["BTC", 0], sats: ["BTC", 0], btc: ["BTC", 8],
  lamport: ["SOL", 0], lamports: ["SOL", 0], sol: ["SOL", 9],
  upokt: ["POKT", 0], pokt: ["POKT", 6],
  sun: ["TRX", 0], trx: ["TRX", 6],
};

function toUnits(str, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) return null;
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
function fromUnits(n, decimals) {
  if (decimals === 0) return n.toString();
  const s = n.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function unitConvert(body) {
  const amount = typeof body.amount === "number" ? String(body.amount) : body.amount;
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) || amount.length > 80) return { error: "field 'amount' must be a non-negative decimal number (a string keeps full precision)" };
  let fromDec;
  let toDec;
  let asset;
  if (body.decimals !== undefined) {
    // Any token: from 'raw' (smallest unit) to 'token' or back, with its decimals.
    if (!Number.isInteger(body.decimals) || body.decimals < 0 || body.decimals > 36) return { error: "field 'decimals' must be an integer 0-36" };
    if (!["raw", "token"].includes(body.from) || !["raw", "token"].includes(body.to)) return { error: "with 'decimals', 'from' and 'to' must be 'raw' or 'token'" };
    fromDec = body.from === "token" ? body.decimals : 0;
    toDec = body.to === "token" ? body.decimals : 0;
    asset = "token";
  } else {
    const f = UNITS[String(body.from || "").toLowerCase()];
    const t = UNITS[String(body.to || "").toLowerCase()];
    if (!f || !t) return { error: `fields 'from' and 'to' must be units of one asset: ${Object.keys(UNITS).join(", ")}; or pass 'decimals' with 'raw'/'token'` };
    if (f[0] !== t[0]) return { error: `'${body.from}' is ${f[0]} and '${body.to}' is ${t[0]}: this converts units of one asset, not prices` };
    [asset, fromDec] = f;
    toDec = t[1];
  }
  const raw = toUnits(amount, fromDec);
  if (raw === null) return { error: `'${amount}' has more decimal places than ${body.from} allows` };
  return { asset, amount, from: body.from, to: body.to, result: fromUnits(raw, toDec), exact: true };
}

module.exports = { keccak256, eip55, bech32, b58check, addressCheck, unitConvert };
