// Lookalike domain generation. Our own implementation of the usual fuzzers
// (the dnstwist approach: omission, transposition, keyboard replacement,
// homoglyphs, TLD swap, added words), tuned for crypto and fintech brands. Pure and
// deterministic: the same domain always yields the same list in the same order.
"use strict";

const { domainToASCII } = require("url");
const { isValidDomain } = require("./checks");

const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "co.jp", "com.br", "co.nz", "co.in", "com.cn"]);

const TLDS = [
  "com", "net", "org", "io", "app", "xyz", "finance", "fi", "co", "info", "online", "site", "top", "live",
  "pro", "cc", "me", "us", "ai", "exchange", "network", "money", "dev", "link", "click", "vip", "claims",
  "foundation", "capital", "digital", "tech", "world", "global", "services", "support",
];

// Words phishing kits put next to a brand: crypto first, then accounts and payments.
const WORDS = [
  "app", "claim", "airdrop", "wallet", "login", "secure", "connect", "rewards", "defi", "dapp", "v2", "v3",
  "v4", "staking", "stake", "migrate", "migration", "support", "official", "token", "bridge", "swap", "verify",
  "help", "portal", "drop", "bonus", "gov", "dao", "finance", "protocol", "labs",
  "account", "billing", "invoice", "payment", "pay", "bank", "signin", "auth",
];

const KEYBOARD = {
  q: "wa", w: "qeas", e: "wrsd", r: "etdf", t: "ryfg", y: "tugh", u: "yihj", i: "uojk", o: "ipkl", p: "ol",
  a: "qwsz", s: "weadzx", d: "erfcxs", f: "rtgvcd", g: "tyhbvf", h: "yujnbg", j: "uikmnh", k: "iolmj",
  l: "opk", z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};

const ASCII_GLYPHS = {
  o: ["0"], l: ["1", "i"], i: ["1", "l"], e: ["3"], a: ["4"], s: ["5"], g: ["q", "9"], b: ["6"], z: ["2"],
  m: ["rn", "nn"], w: ["vv"], d: ["cl"],
};
const ASCII_MULTI = [["rn", "m"], ["vv", "w"], ["cl", "d"], ["nn", "m"]];

// Latin letter -> visually identical Cyrillic letter (IDN homograph).
const IDN_GLYPHS = { a: "а", e: "е", o: "о", p: "р", c: "с", y: "у", x: "х", i: "і" };

// Fuzzer order is the priority order when a scan can only check the first N.
const FUZZER_ORDER = [
  "tld-swap", "added-word", "homoglyph", "idn-homoglyph", "omission", "transposition", "replacement",
  "repetition", "hyphenation", "insertion", "vowel-swap",
];

function splitDomain(domain) {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const parts = d.split(".");
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  const suffixLen = parts.length >= 3 && TWO_PART_SUFFIXES.has(lastTwo) ? 2 : 1;
  const tld = parts.slice(-suffixLen).join(".");
  const label = parts[parts.length - suffixLen - 1];
  if (!label) return null;
  return { label, tld, registrable: `${label}.${tld}` };
}

function labelVariants(label) {
  const out = [];
  const add = (fuzzer, v) => out.push([fuzzer, v]);
  const n = label.length;
  for (let i = 0; i < n; i++) {
    const c = label[i];
    for (const g of ASCII_GLYPHS[c] || []) add("homoglyph", label.slice(0, i) + g + label.slice(i + 1));
    if (IDN_GLYPHS[c]) add("idn-homoglyph", label.slice(0, i) + IDN_GLYPHS[c] + label.slice(i + 1));
  }
  for (const [from, to] of ASCII_MULTI) {
    let at = label.indexOf(from);
    while (at !== -1) {
      add("homoglyph", label.slice(0, at) + to + label.slice(at + from.length));
      at = label.indexOf(from, at + 1);
    }
  }
  for (let i = 0; i < n; i++) add("omission", label.slice(0, i) + label.slice(i + 1));
  for (let i = 0; i < n - 1; i++) {
    if (label[i] !== label[i + 1]) add("transposition", label.slice(0, i) + label[i + 1] + label[i] + label.slice(i + 2));
  }
  for (let i = 0; i < n; i++) {
    for (const k of KEYBOARD[label[i]] || "") add("replacement", label.slice(0, i) + k + label.slice(i + 1));
  }
  for (let i = 0; i < n; i++) add("repetition", label.slice(0, i + 1) + label[i] + label.slice(i + 1));
  for (let i = 1; i < n; i++) {
    if (label[i - 1] !== "-" && label[i] !== "-") add("hyphenation", `${label.slice(0, i)}-${label.slice(i)}`);
  }
  for (let i = 0; i < n; i++) {
    for (const k of KEYBOARD[label[i]] || "") {
      add("insertion", label.slice(0, i) + k + label.slice(i));
      add("insertion", label.slice(0, i + 1) + k + label.slice(i + 1));
    }
  }
  const vowels = "aeiou";
  for (let i = 0; i < n; i++) {
    if (!vowels.includes(label[i])) continue;
    for (const v of vowels) if (v !== label[i]) add("vowel-swap", label.slice(0, i) + v + label.slice(i + 1));
  }
  return out;
}

/**
 * permutations("uniswap.org") -> [{ domain, fuzzer, unicode? }, ...]
 * Deterministic, de-duplicated, never includes the input or any `exclude`.
 */
function permutations(domain, { exclude = [], words = WORDS, tlds = TLDS } = {}) {
  const sp = splitDomain(domain);
  if (!sp) return [];
  const { label, tld, registrable } = sp;
  const skip = new Set([registrable, ...exclude.map((d) => d.toLowerCase())]);
  const seen = new Set();
  const buckets = Object.fromEntries(FUZZER_ORDER.map((f) => [f, []]));

  const push = (fuzzer, unicodeLabel, t = tld) => {
    const unicode = `${unicodeLabel}.${t}`;
    const ascii = domainToASCII(unicode);
    if (!ascii || skip.has(ascii) || seen.has(ascii) || !isValidDomain(ascii)) return;
    seen.add(ascii);
    const item = { domain: ascii, fuzzer };
    if (ascii !== unicode) item.unicode = unicode;
    buckets[fuzzer].push(item);
  };

  for (const t of tlds) if (t !== tld) push("tld-swap", label, t);
  for (const w of words) {
    if (w === label) continue;
    push("added-word", `${label}-${w}`);
    push("added-word", `${w}-${label}`);
    push("added-word", `${label}${w}`);
    push("added-word", `${w}${label}`);
  }
  for (const [fuzzer, v] of labelVariants(label)) {
    if (v && !v.startsWith("-") && !v.endsWith("-")) push(fuzzer, v);
  }
  return FUZZER_ORDER.flatMap((f) => buckets[f]);
}

// Keywords for certificate-log matching: the brand's own labels (>= 4 chars,
// shorter ones match far too much) plus any caller keywords.
function brandKeywords(officialDomains, extra = []) {
  const out = new Set();
  for (const d of officialDomains) {
    const sp = splitDomain(d);
    if (sp && sp.label.length >= 4) out.add(sp.label);
  }
  for (const k of extra) {
    const v = String(k).toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (v.length >= 4) out.add(v);
  }
  return [...out].sort();
}

module.exports = { permutations, splitDomain, brandKeywords, FUZZER_ORDER, TLDS, WORDS };
