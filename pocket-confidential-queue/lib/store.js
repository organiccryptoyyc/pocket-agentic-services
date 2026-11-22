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
const WITNESS_KEEP_MS = 7 * 24 * 3600_000;
const WITNESS_LEASE_MS = 30 * 60_000; // a witness reads the chain for up to ~20 minutes
const WITNESS_MAX_OPEN = 20;
// Watches (Service 2, covenant-monitor): the sealed request stays here and is handed back to the
// job each time the public signals refresh, until its key is gone or 24 hours pass. The queue
// still cannot read it; it only sees which signal bundle the last check used.
const WATCH_SERVICES = new Set(["covenant-monitor"]);
const WATCH_RECHECK_MS = 25 * 60_000;

function createStore(dataDir, now = () => Date.now()) {
  const file = path.join(dataDir, "queue-state.json");
  let s = { announcements: [], requests: {} };
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
  s.witness = s.witness || {};

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
    for (const [id, w] of Object.entries(s.witness)) if (t - w.received_at > WITNESS_KEEP_MS) delete s.witness[id];
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
      const pending = Object.values(s.requests).filter((r) => r.status === "queued" || r.status === "leased" || r.status === "watching").length;
      if (pending >= MAX_PENDING) return { ok: false, reason: "queue full" };
      s.requests[req.request_id] = { request: req, status: "queued", received_at: now(), leased_at: null, attempts: 0, ...(WATCH_SERVICES.has(req.service) ? { watch: { checks: 0, last_checked_at: null, checked_signals_at: null, lease_signals_at: null, latest: null, alert: null, last_error: null } } : {}) };
      save();
      return { ok: true };
    },
    // Hand out requests sealed to this key; expired leases are handed out again.
    // signalsAt: fetched_at of the signal bundle the job will get; a watch is due again when the
    // bundle is newer than the one its last check used (and at least 25 minutes have passed).
    lease(encKey, max, signalsAt = null) {
      prune();
      const t = now();
      const out = [];
      for (const r of Object.values(s.requests)) {
        if (out.length >= max) break;
        if (r.request.to !== encKey) continue;
        const due = r.watch && r.status === "watching" && signalsAt && r.watch.checked_signals_at !== signalsAt && t - r.watch.last_checked_at >= WATCH_RECHECK_MS;
        const free = due || r.status === "queued" || (r.status === "leased" && t - r.leased_at > LEASE_MS);
        if (free) {
          r.status = "leased"; r.leased_at = t; r.attempts += 1;
          if (r.watch) r.watch.lease_signals_at = signalsAt;
          out.push(r.request);
        }
      }
      if (out.length) save();
      return out;
    },
    get(id) { prune(); return s.requests[id] || null; },
    // Any open work for this key (so the signals are fetched only when something may run).
    hasWork(encKey) {
      prune();
      return Object.values(s.requests).some((r) => r.request.to === encKey && ["queued", "leased", "watching"].includes(r.status));
    },
    // A watch check: keep the newest signed result and the first one that crossed a limit. An
    // error before any check ends the watch (bad input stays bad); a later error is noted only.
    recordCheck(id, { sealed, error }) {
      const r = s.requests[id];
      if (!r || !r.watch) return false;
      const t = now();
      if (error && !r.watch.checks) { Object.assign(r, { status: "error", error, completed_at: t }); save(); return true; }
      if (error) r.watch.last_error = { ...error, at: new Date(t).toISOString() };
      else {
        r.watch.checks += 1;
        r.watch.latest = sealed;
        if (!r.watch.alert && sealed.result && sealed.result.status === "limit_crossed") r.watch.alert = sealed;
        r.watch.checked_signals_at = r.watch.lease_signals_at;
      }
      r.watch.last_checked_at = t;
      r.status = "watching"; r.leased_at = null;
      save();
      return true;
    },
    complete(id, patch) {
      const r = s.requests[id];
      if (!r) return false;
      Object.assign(r, patch, { completed_at: now() });
      save();
      return true;
    },
    // Witness task sets: one at a time, oldest first; an expired lease is handed out again.
    addTaskSet(ts) {
      prune();
      const old = s.witness[ts.task_set_id];
      if (old) return { ok: true, already: true, status: old.status };
      const open = Object.values(s.witness).filter((w) => w.status === "queued" || w.status === "leased").length;
      if (open >= WITNESS_MAX_OPEN) return { ok: false, reason: "too many open task sets" };
      s.witness[ts.task_set_id] = { task_set: ts, status: "queued", received_at: now(), leased_at: null, attempts: 0 };
      save();
      return { ok: true, status: "queued" };
    },
    leaseTaskSet() {
      prune();
      const t = now();
      const free = Object.values(s.witness)
        .filter((w) => w.status === "queued" || (w.status === "leased" && t - w.leased_at > WITNESS_LEASE_MS))
        .sort((a, b) => a.received_at - b.received_at)[0];
      if (!free) return null;
      free.status = "leased"; free.leased_at = t; free.attempts += 1;
      save();
      return free.task_set;
    },
    getTaskSet(id) { prune(); return s.witness[id] || null; },
    completeTaskSet(id, patch) {
      const w = s.witness[id];
      if (!w) return false;
      Object.assign(w, patch, { completed_at: now() });
      save();
      return true;
    },
    // A refused witness puts the task set straight back in the queue for another job.
    releaseTaskSet(id) {
      const w = s.witness[id];
      if (!w || w.status !== "leased") return false;
      w.status = "queued"; w.leased_at = null;
      save();
      return true;
    },
    jobKeys() { prune(); return [...new Set(s.announcements.map((a) => a.announcement.job_ed25519_public_key))]; },
    stats() {
      prune();
      const by = {};
      for (const r of Object.values(s.requests)) by[r.status] = (by[r.status] || 0) + 1;
      return { announcements: s.announcements.length, requests: by };
    },
  };
}

module.exports = { createStore, WATCH_SERVICES, WATCH_RECHECK_MS, KEEP_MS, LEASE_MS, MAX_PENDING, WITNESS_KEEP_MS, WITNESS_LEASE_MS, WITNESS_MAX_OPEN };
