// Minimal .xlsx reader, zero dependencies: unzip with node:zlib, then read one worksheet's cells
// (shared strings, inline strings and numbers). Enough for published statistical workbooks; it
// ignores styles, formulas (uses the cached value) and dates-as-serials.
"use strict";

const zlib = require("zlib");

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx: not a zip file (no end of central directory)");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("xlsx: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      if (buf.readUInt32LE(f.local) !== 0x04034b50) throw new Error(`xlsx: bad local header for ${name}`);
      const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
      const data = buf.subarray(start, start + f.size);
      if (f.method === 0) return data.toString("utf8");
      if (f.method === 8) return zlib.inflateRawSync(data).toString("utf8");
      throw new Error(`xlsx: unsupported compression ${f.method} for ${name}`);
    },
  };
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");

function colIndex(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

// Rows of one sheet (by name, or the first sheet) as arrays of strings/numbers, by row number.
function readSheet(buf, sheetName = null) {
  const zip = unzip(buf);
  const wb = zip.read("xl/workbook.xml");
  if (!wb) throw new Error("xlsx: no xl/workbook.xml");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map((m) => ({ name: unescape(m[1]), rid: m[2] }));
  const want = sheetName ? sheets.find((s) => s.name.trim().toLowerCase() === sheetName.toLowerCase()) : sheets[0];
  if (!want) throw new Error(`xlsx: no sheet named '${sheetName}' (have: ${sheets.map((s) => s.name).join(", ")})`);
  const rels = zip.read("xl/_rels/workbook.xml.rels") || "";
  const rel = [...rels.matchAll(/<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"/g)].find((m) => m[1] === want.rid);
  if (!rel) throw new Error(`xlsx: no relationship ${want.rid}`);
  const target = rel[2].replace(/^\//, "");
  const path = target.startsWith("xl/") ? target : `xl/${target}`;
  const xml = zip.read(path);
  if (!xml) throw new Error(`xlsx: missing ${path}`);
  const ssXml = zip.read("xl/sharedStrings.xml") || "";
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const rows = new Map();
  for (const rm of xml.matchAll(/<row\b[^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    for (const cm of (rm[2] || "").matchAll(/<c\b[^>]*?r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = /\bt="([^"]*)"/.exec(cm[2]);
      const inner = cm[3] || "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let value = null;
      if (type && type[1] === "s") value = v ? shared[Number(v[1])] ?? null : null;
      else if (type && type[1] === "inlineStr") value = texts(inner);
      else if (type && (type[1] === "str" || type[1] === "e")) value = v ? unescape(v[1]) : null;
      else if (v) value = Number(v[1]);
      cells[colIndex(cm[1])] = value;
    }
    rows.set(Number(rm[1]), cells);
  }
  return rows;
}

module.exports = { unzip, readSheet, colIndex };
