// Treasury Availability (owner 2026-11-07, Treasury-availability-plan.md): one call, one protocol. Of the capital
// we verified on chain, how much the treasury could use now, and why not the rest.
//
// Every counted position lands in exactly one bucket, checked in this order, so the buckets add up to observed_usd:
//   unresolved (control not verified)  -> own_token -> encumbered -> restricted -> exit check (illiquid / unresolved)
//   -> available_now.
// Owner decisions 2026-11-07: the protocol's own token is its own bucket, in any wrapper (1); loan collateral counts in
// full as encumbered (2); the reported total is a cited total no older than 90 days, else null (3); the headline is
// a share, not a new 0-100 score (4). Built from the same snapshot pair as the dossier; never calls a chain or vendor.
"use strict";

const store = require("./store");
const { ClientError } = require("./http");
const S = require("./tcs6-scoring");
const D = require("./dossier");
const V = require("./verified");
const VERSION = require("../package.json").version;

const METHOD = "tcs6-availability/1.0";
const REPORTED_MAX_AGE_DAYS = 90; // O2 minimum (owner 2026-10-09)
const POSITIONS_PER_BUCKET = 25;
const RESTRICTING_FLAGS = ["lockup", "redemption_limits", "unlock_pending", "legal_restriction"];
const BUCKETS = ["available_now", "own_token", "encumbered", "restricted", "illiquid_now", "unresolved"];
const BUCKET_TEXT = {
  available_now: "Held directly or withdrawable now: not locked, not loan collateral, not the protocol's own token",
  own_token: "The protocol's own token in any wrapper: transferable, but it cannot be sold at size",
  encumbered: "Collateral backing a loan, counted in full (the loan itself is listed under obligations)",
  restricted: "Lock-ups, redemption limits, legal restrictions, or positions the protocol classifies as restricted",
  illiquid_now: "The part of a lending or vault position the pool cannot pay out now (exit check shortfall)",
  unresolved: "Positions we could not check this run, or whose control is not verified",
};

const round2 = D.round2;
const lower = (x) => String(x || "").toLowerCase();

// The protocol's own token: TCS-6 class native_token, the collector's correlation group "native" (lending receipts of
// the native token), or a lending receipt whose symbol is a native symbol with a short market prefix (aAAVE, aEthAAVE).
function ownTokenTest(rows) {
  const natives = [...new Set(rows.filter((x) => x.h.asset_class === "native_token").map((x) => String(x.h.symbol || "").toUpperCase()).filter(Boolean))];
  const test = (x) => {
    if (x.h.asset_class === "native_token" || x.h.correlation_group === "native") return true;
    const sym = String(x.h.symbol || "").toUpperCase();
    return (x.h.haircut_flags || []).includes("lending_receipt") && natives.some((n) => sym !== n && sym.endsWith(n) && sym.length - n.length <= 5);
  };
  // A pool or vault whose name carries a native symbol of 3+ letters (INV/WETH, crvDBRINV): counted as available, but
  // flagged. By name only, so it can over-flag (invUSDDOLA); the note says "suggests".
  test.pairedWithOwn = (h) => !["fiat_stablecoin", "cash_equivalent", "major_crypto"].includes(h.asset_class)
    && natives.some((n) => n.length >= 3 && String(h.symbol || "").toUpperCase() !== n && String(h.symbol || "").toUpperCase().includes(n));
  return test;
}

// Exit checks by position. The check field is chain:token:holder; holdings carry the same asset_id, and the label
// "<SYMBOL> at <role>" plus the holder is the fallback.
function checkIndex(checks) {
  const byId = new Map();
  const byLabel = new Map();
  for (const p of checks.positions) {
    byId.set(lower(`${p.chain}:${p.token}:${p.holder}`), p);
    byLabel.set(lower(`${p.chain}:${p.holder}:${String(p.label || "").split(" at ")[0]}`), p);
  }
  return (h) => byId.get(lower(h.asset_id)) || byLabel.get(lower(`${h.chain}:${h.address}:${h.symbol}`)) || null;
}

function reported(bundle, asOf) {
  const rec = (bundle.governance || {}).reconciliation;
  if (!rec) return { usd: null, reason: "the protocol publishes no treasury total we can compare" };
  if (rec.reported_total_usd == null || (rec.unit && rec.unit !== "USD")) return { usd: null, reason: `the protocol reports its total in ${rec.unit || "another unit"}, not USD`, as_of: rec.reported_as_of || null };
  const ageDays = rec.reported_as_of ? Math.floor((Date.parse(asOf) - Date.parse(rec.reported_as_of)) / 86400000) : null;
  const base = { as_of: rec.reported_as_of || null, age_days: ageDays, scope_status: rec.scope_status || null, source_refs: rec.source_refs || [] };
  if (ageDays === null || !Number.isFinite(ageDays)) return { usd: null, reason: "the reported total has no date", ...base };
  if (ageDays > REPORTED_MAX_AGE_DAYS) return { usd: null, reason: `the latest reported total is ${ageDays} days old, over the ${REPORTED_MAX_AGE_DAYS}-day limit`, stale_usd: round2(rec.reported_total_usd), ...base };
  return { usd: round2(rec.reported_total_usd), ...base };
}

function place(row, isOwn, checkOf, conflicts) {
  const h = row.h;
  const value = row.fair;
  const c = checkOf(h);
  const sim = (c && c.withdrawal_simulation) || {};
  const flags = h.haircut_flags || [];
  const pos = { symbol: h.symbol || null, chain: h.chain || null, wallet: h.address || null, asset_class: h.asset_class, value_usd: value };
  const evidence = c ? { exit_check: c.status, block_number: c.block_number, evidence_hash: c.evidence_hash } : {};
  if (h.control !== "verified") return [["unresolved", value, { ...pos, reason: "control of this wallet is not verified" }]];
  if (isOwn(row)) {
    return [["own_token", value, { ...pos, reason: sim.backs_loans ? "own token, also collateral for a loan" : "the protocol's own token", ...(sim.backs_loans ? { backs_loans: sim.backs_loans } : {}), ...evidence }]];
  }
  if (sim.backs_loans || sim.cause === "backs_a_loan") {
    return [["encumbered", value, { ...pos, reason: "collateral for a loan; withdrawing it all would breach the loan's health factor", backs_loans: sim.backs_loans || [], ...evidence }]];
  }
  const restrictedBy = flags.filter((f) => RESTRICTING_FLAGS.includes(f));
  const conflict = conflicts.get(lower(h.asset_id));
  if (restrictedBy.length || h.asset_class === "locked_unverifiable" || conflict) {
    const why = conflict ? "the protocol classifies it as restricted (the chain shows it withdrawable; under review)" : restrictedBy.length ? restrictedBy.join(", ") : "locked, not verifiable";
    return [["restricted", value, { ...pos, reason: why, ...evidence }]];
  }
  if (c) {
    if (c.exitable_ratio === null) return [["unresolved", value, { ...pos, reason: c.status === "not_applicable" ? `exit check not re-run: ${c.result}` : "exit check could not be read", ...evidence }]];
    const out = value * c.exitable_ratio;
    const parts = [];
    if (out > 0) parts.push(["available_now", out, { ...pos, value_usd: out, reason: c.exitable_ratio >= 0.999 ? "withdrawal checked on chain" : `${round2(c.exitable_ratio * 100)}% could be withdrawn now`, confirmed_by_check: true, ...evidence }]);
    if (value - out > 0) parts.push(["illiquid_now", value - out, { ...pos, value_usd: value - out, reason: `the pool holds cash for only ${round2(c.exitable_ratio * 100)}% of the position`, ...(sim.cause ? { cause: sim.cause } : {}), ...evidence }]);
    return parts;
  }
  const why = h.asset_class === "lp_position"
    ? "pool, vault or lending position not exit-checked (under $100,000, or a kind the collector does not check)"
    : "held directly; not exit-checked";
  const inOwnPool = isOwn.pairedWithOwn(h);
  return [["available_now", value, { ...pos, reason: why, confirmed_by_check: false, ...(inOwnPool ? { own_token_pool: true, note: "its name suggests a pool or vault that includes the protocol's own token" } : {}) }]];
}

function build(report, bundle) {
  const rows = S.computeBase(bundle).rows;
  const isOwn = ownTokenTest(rows);
  const checkOf = checkIndex(D.exitChecks(bundle, report));
  const conflicts = new Map(D.classificationConflicts(report).filter((c) => c.asset_id).map((c) => [lower(c.asset_id), c]));
  const acc = Object.fromEntries(BUCKETS.map((b) => [b, { usd: 0, positions: [] }]));
  let confirmed = 0;
  let ownPools = 0;
  for (const row of rows) {
    for (const [bucket, usd, pos] of place(row, isOwn, checkOf, conflicts)) {
      acc[bucket].usd += usd;
      acc[bucket].positions.push(pos);
      if (pos.confirmed_by_check) confirmed += usd;
      if (pos.own_token_pool) ownPools += usd;
    }
  }
  const observed = rows.reduce((s, r) => s + r.fair, 0);
  const buckets = Object.fromEntries(BUCKETS.map((b) => {
    const ps = acc[b].positions.sort((x, y) => y.value_usd - x.value_usd);
    const shown = ps.slice(0, POSITIONS_PER_BUCKET);
    const rest = ps.slice(POSITIONS_PER_BUCKET);
    return [b, {
      usd: round2(acc[b].usd), share_pct: observed > 0 ? round2((acc[b].usd / observed) * 100) : null, meaning: BUCKET_TEXT[b],
      positions_total: ps.length, positions: shown.map((p) => ({ ...p, value_usd: round2(p.value_usd) })),
      ...(rest.length ? { other_positions: { count: rest.length, usd: round2(rest.reduce((s, p) => s + p.value_usd, 0)) } } : {}),
    }];
  }));
  const unpriced = (bundle.gaps || []).filter((g) => g.field.startsWith("holdings.prices") || g.field === "holdings.dust").map((g) => g.reason);
  return { observed, confirmed, ownPools, buckets, unpriced };
}

function availability(body, nowMs = Date.now()) {
  const id = body && typeof body.entity_id === "string" ? body.entity_id.trim().toLowerCase() : "";
  if (!store.ENTITY_ID_RE.test(id)) {
    throw new ClientError(400, "invalid_input", "field 'entity_id' is required, e.g. \"aave\"; list ids with POST /v1/dossier/entities");
  }
  const snap = store.latestSnapshot(id);
  if (!snap) throw new ClientError(400, "unknown_entity", `'${id}' has no scored TCS-6 snapshot; list ids with POST /v1/dossier/entities`);
  const { report: r, bundle } = snap;
  const { observed, confirmed, ownPools, buckets, unpriced } = build(r, bundle);
  const rep = reported(bundle, r.as_of);
  const avail = buckets.available_now.usd;
  return {
    schema_version: D.SCHEMA,
    method: METHOD,
    entity: r.entity,
    as_of: r.as_of,
    snapshot_report_id: r.report_id,
    summary: {
      observed_usd: round2(observed),
      available_now_usd: avail,
      available_share_pct: observed > 0 ? round2((avail / observed) * 100) : null,
      available_confirmed_by_exit_check_usd: round2(confirmed),
      available_in_own_token_pools_usd: round2(ownPools),
      own_token_usd: buckets.own_token.usd,
      encumbered_usd: buckets.encumbered.usd,
      restricted_usd: buckets.restricted.usd,
      illiquid_now_usd: buckets.illiquid_now.usd,
      unresolved_usd: buckets.unresolved.usd,
      reported_usd: rep.usd,
      statement: `Of $${Math.round(observed).toLocaleString("en-US")} verified on chain, $${Math.round(avail).toLocaleString("en-US")} (${observed > 0 ? round2((avail / observed) * 100) : 0}%) could be used now.`,
    },
    reported: rep,
    buckets,
    not_valued: unpriced,
    rules: {
      order: "each position is placed once: control not verified -> own token -> loan collateral -> restricted -> exit check result -> available now",
      own_token: "class native_token, the collector's 'native' group, or a lending receipt of the native token; shown apart because it cannot be sold at size. A pool that pairs the own token with another asset stays available, flagged own_token_pool and totalled in available_in_own_token_pools_usd",
      encumbered: "loan collateral counts in full (owner decision 2026-11-07), even where part of it could be withdrawn without breaching the loan",
      reported: `the protocol's own cited USD total, only when ${REPORTED_MAX_AGE_DAYS} days old or newer; otherwise null with the reason`,
      values: "before haircuts, at the snapshot's prices; TCS-6 scores are unchanged by this view",
      not_valued: "tokens with no price are never guessed; they are listed under not_valued and left out of every bucket",
    },
    cost: { calls: 1, price_per_call_usd: D.PRICE_PER_CALL_USD, total_usd: D.PRICE_PER_CALL_USD, basis: "agent.pocket.network flat price per call",
      deeper: "the full dossier (POST /v1/dossier/plan) shows every position, check and source, in up to 7 calls" },
    attestation_ref: D.attestationRef(r),
    disclaimer: r.disclaimer,
    verified: V.build("/v1/dossier/availability", VERSION, r, bundle, {
      assessment: "none",
      extraGaps: unpriced.map((reason) => ({ field: "not_valued", reason, impact: "left out of every bucket" })),
    }, nowMs),
  };
}

module.exports = { availability, build, reported, METHOD, BUCKETS, REPORTED_MAX_AGE_DAYS };
