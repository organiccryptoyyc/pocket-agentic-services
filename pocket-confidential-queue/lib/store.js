// The queue's state: the current signed key announcement(s), sealed requests and sealed
// results. Everything stored is ciphertext, commitments or signed results: the queue holds no
// key that can open a request. One JSON file, written temp-file + rename; requests and
// results are dropped 24 hours after they arrive.
"use strict";

const fs = require("fs");
const path = require("path");

const KEEP_MS = 24 * 3600_000;
const LEASE_MS = 120_000; // a request handed to a job comes back if no result arrives in 2 min
const MAX_PENDING = 1000;

function createStore(dataDir, now = () => Date.now()) {
  const file = path.join(dataDir, "queue-state.json");
  let s = { announcements: [], requests: {} };
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }

  function prune() {
    const t = now();
    s.announcements = s.announcements.filter((a) => Date.parse(a.announcement.expires_at) > t);
    for (const [id, r] of Object.entries(s.requests)) if (t - r.received_at > KEEP_MS) delete s.requests[id];
  }

  return {
    // Newest valid announcement first; a customer seals to the newest.
    currentAnnouncement() {
      prune();
      return s.announcements.slice().sort((a, b) => b.announcement.issued_at.localeCompare(a.announcement.issued_at))[0] || null;
    },
    announcementFor(encKey) {
      prune();
      return s.announcements.find((a) => a.announcement.encryption_public_key === encKey) || null;
    },
    addAnnouncement(a) {
      prune();
      s.announcements = s.announcements.filter((x) => x.announcement.encryption_public_key !== a.announcement.encryption_public_key);
      s.announcements.push(a);
      save();
    },
    submit(req) {
      prune();
      if (s.requests[req.request_id]) return { ok: false, reason: "duplicate request_id" };
      const pending = Object.values(s.requests).filter((r) => r.status === "queued" || r.status === "leased").length;
      if (pending >= MAX_PENDING) return { ok: false, reason: "queue full" };
      s.requests[req.request_id] = { request: req, status: "queued", received_at: now(), leased_at: null, attempts: 0 };
      save();
      return { ok: true };
    },
    // Hand out requests sealed to this key; expired leases are handed out again.
    lease(encKey, max) {
      prune();
      const t = now();
      const out = [];
      for (const r of Object.values(s.requests)) {
        if (out.length >= max) break;
        if (r.request.to !== encKey) continue;
        const free = r.status === "queued" || (r.status === "leased" && t - r.leased_at > LEASE_MS);
        if (free) { r.status = "leased"; r.leased_at = t; r.attempts += 1; out.push(r.request); }
      }
      if (out.length) save();
      return out;
    },
    get(id) { prune(); return s.requests[id] || null; },
    complete(id, patch) {
      const r = s.requests[id];
      if (!r) return false;
      Object.assign(r, patch, { completed_at: now() });
      save();
      return true;
    },
    stats() {
      prune();
      const by = {};
      for (const r of Object.values(s.requests)) by[r.status] = (by[r.status] || 0) + 1;
      return { announcements: s.announcements.length, requests: by };
    },
  };
}

module.exports = { createStore, KEEP_MS, LEASE_MS, MAX_PENDING };
