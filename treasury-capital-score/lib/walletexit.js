// Wallet exit tcs6-wallet-exit/1.0 (owner 2026-10-30; methodology/tcs6_wallet_exit_policy_v1.json): if a treasury
// wallet's signing control were compromised, how much could leave within one hour as liquid assets nobody can freeze?
//
// Inputs are the collector's signed checks (a valid attestation only):
//   control.path:<chain>:<wallet>  measure.protected: true (every path needs a vote or >= 48 h), false, or unknown
//                                  (status unavailable); a curated, cited control path (measure.curated) overrides
//   exit.borrow:<chain>:<wallet>   Aave v3 unused borrowing room, per-asset LTV / Compound v3 collateral factor, and the
//                                  WETH cash of those markets (the cap on a collateral escape)
//   exit.available:...             the withdrawable share of lent positions
// Exposed wallets (not protected, or unknown) count:
//   direct    non-freezable, unlocked holdings (lent positions up to their withdrawable share)
//   borrow    plain freezable tokens x best collateral factor, plus lent positions (freezable, or the part that can't
//             be withdrawn) x LTV up to the account's Aave headroom; per chain capped by the markets' WETH cash
// one_hour_exit_share = (direct + borrow) / counted treasury value; the band caps D6. Pure: no network, no clock.
"use strict";

const POLICY = require("../methodology/tcs6_wallet_exit_policy_v1.json");

const round2 = (v) => Math.round(v * 100) / 100;
const lower = (s) => String(s || "").toLowerCase();
const FREEZABLE = new RegExp(`(${POLICY.freezable_symbols.slice().sort((a, b) => b.length - a.length).join("|")})`);

function isFreezable(h) {
  return FREEZABLE.test(String(h.symbol || "").toUpperCase());
}

function isLocked(h, policy) {
  return policy.locked_classes.includes(h.asset_class) || (h.haircut_flags || []).some((f) => policy.locked_flags.includes(f));
}

function capFor(share, policy = POLICY) {
  for (const b of policy.bands) if (b.max_share === null || share <= b.max_share) return b.d6_cap;
  return null;
}

// -> null when the bundle carries no signed control paths (older bundles, golden fixtures); otherwise the assessment.
function assess(bundle, base, verdict, policy = POLICY) {
  if (!verdict || verdict.status !== "valid") return null;
  const checks = (((bundle || {}).attestation || {}).payload || {}).checks || [];
  const byPrefix = (p) => new Map(checks.filter((c) => (c.field || "").startsWith(p)).map((c) => [lower(c.field.slice(p.length)), c]));
  const control = byPrefix("control.path:");
  if (!control.size) return null;
  const borrow = byPrefix("exit.borrow:");
  const exits = byPrefix("exit.available:");
  const treasury = base.grossVerified;

  // wallets: every holder of a verified on-chain position, plus every wallet with a control path
  const wallets = new Map();
  const walletOf = (key) => {
    if (!wallets.has(key)) wallets.set(key, { key, rows: [] });
    return wallets.get(key);
  };
  for (const r of base.verifiedRows) {
    const p = lower(r.h.asset_id).split(":");
    if (p.length === 3 && r.h.bucket !== "offchain") walletOf(`${p[0]}:${p[2]}`).rows.push(r);
  }
  for (const k of control.keys()) walletOf(k);

  const chains = new Map(); // chain -> { borrowable, cap }
  const out = [];
  let direct = 0;
  let protectedUsd = 0;
  let freezableUsd = 0;
  for (const w of wallets.values()) {
    const [chain, address] = w.key.split(":");
    const c = control.get(w.key);
    const m = (c && c.measure) || {};
    const curated = m.curated && typeof m.curated.protected === "boolean" ? m.curated : null;
    const prot = curated ? curated.protected : c && c.status === "passed" && typeof m.protected === "boolean" ? m.protected : null;
    const value = w.rows.reduce((s, r) => s + r.fair, 0);
    const entry = { chain, address, control: c ? m.type || null : null, protected: prot, protected_by: curated ? "curated" : c ? "on_chain" : "not_read",
      ...(m.threshold ? { safe_threshold: `${m.threshold}-of-${m.signers ?? "?"}` } : {}), ...(m.delay_hours != null ? { delay_hours: m.delay_hours } : {}),
      ...(curated && curated.source_ref ? { source_ref: curated.source_ref } : {}),
      // a limited, noted path the curator did not count (e.g. Aave Collector steward budgets)
      ...(curated && Number(curated.bounded_exposure_usd) > 0 ? { bounded_exposure_usd: round2(Number(curated.bounded_exposure_usd)) } : {}),
      value_usd: round2(value), direct_usd: 0, borrow_usd: 0, freezable_usd: 0, locked_usd: 0 };
    if (prot === true) {
      protectedUsd += value;
      out.push(entry);
      continue;
    }
    const b = borrow.get(w.key);
    const bm = (b && b.status === "passed" && b.measure) || null;
    const factor = (token) => {
      const a = (bm && bm.assets && bm.assets[lower(token)]) || {};
      return Math.max(Number(a.aave_ltv) || 0, Number(a.comet_cf) || 0);
    };
    let lentCollateral = 0;
    let plainBorrow = 0;
    for (const r of w.rows) {
      const p = lower(r.h.asset_id).split(":");
      if (isLocked(r.h, policy)) {
        entry.locked_usd += r.fair;
        continue;
      }
      const ex = exits.get(`${p[0]}:${p[1]}:${p[2]}`);
      const ratio = ex ? (ex.status === "failed" ? Number((ex.measure || {}).exitable_ratio) || 0 : 1) : null; // null: not a lent position
      const frz = isFreezable(r.h);
      if (frz) {
        entry.freezable_usd += r.fair;
        if (ratio === null) plainBorrow += r.fair * factor(p[1]);
        else lentCollateral += r.fair * factor(p[1]);
        continue;
      }
      if (ratio === null) entry.direct_usd += r.fair;
      else {
        entry.direct_usd += r.fair * ratio;
        lentCollateral += r.fair * (1 - ratio) * factor(p[1]);
      }
    }
    const headroom = bm ? Number(bm.aave_headroom_usd) || 0 : 0;
    const walletBorrow = plainBorrow + Math.min(lentCollateral, headroom);
    entry.borrow_usd = walletBorrow;
    if (!chains.has(chain)) chains.set(chain, { borrowable: 0, cap: null });
    const ch = chains.get(chain);
    ch.borrowable += walletBorrow;
    if (bm && bm.markets) {
      const cash = (Number((bm.markets.aave || {}).weth_cash_usd) || 0) + (Number((bm.markets.comet || {}).weth_cash_usd) || 0);
      ch.cap = ch.cap === null ? cash : Math.max(ch.cap, cash);
    }
    direct += entry.direct_usd;
    freezableUsd += entry.freezable_usd;
    out.push(entry);
  }
  let borrowTotal = 0;
  const caps = [];
  for (const [chain, ch] of chains) {
    const cap = ch.cap === null ? 0 : ch.cap; // no verified market on the chain: no measured borrow path
    const used = Math.min(ch.borrowable, cap);
    borrowTotal += used;
    if (ch.borrowable > 0) caps.push({ chain, borrowable_usd: round2(ch.borrowable), weth_cash_cap_usd: round2(cap), counted_usd: round2(used) });
  }
  const extractable = direct + borrowTotal;
  const share = treasury > 0 ? extractable / treasury : null;
  const cap = share === null ? null : capFor(share, policy);
  for (const e of out) for (const k of ["direct_usd", "borrow_usd", "freezable_usd", "locked_usd"]) e[k] = round2(e[k]);
  const unknown = out.filter((e) => e.protected === null);
  return {
    policy_id: policy.policy_id,
    one_hour_exit_usd: round2(extractable),
    one_hour_exit_share: share === null ? null : Math.round(share * 1e4) / 1e4,
    direct_usd: round2(direct),
    borrow_usd: round2(borrowTotal),
    freezable_usd: round2(freezableUsd),
    protected_usd: round2(protectedUsd),
    treasury_value_usd: round2(treasury),
    d6_cap: cap,
    unknown_control_wallets: unknown.length,
    borrow_caps: caps,
    wallets: out.sort((a, b) => b.value_usd - a.value_usd),
    statement: share === null ? "No counted treasury value: the one-hour exit share cannot be calculated."
      : `If the signing control of the exposed wallets were compromised, about $${Math.round(extractable).toLocaleString("en-US")} `
        + `(${(share * 100).toFixed(1)}% of counted treasury value) could leave within one hour: $${Math.round(direct).toLocaleString("en-US")} directly and `
        + `$${Math.round(borrowTotal).toLocaleString("en-US")} by borrowing unfreezable WETH against collateral (Aave v3, Compound v3). `
        + `$${Math.round(protectedUsd).toLocaleString("en-US")} sits behind a vote or a delay of at least ${policy.delay_standard_hours} hours. `
        + (unknown.length ? `${unknown.length} wallet(s) have a control path that could not be resolved and are counted as exposed. ` : "")
        + (cap === null ? "Below the first band: no cap on D6." : `D6 is capped at ${cap}.`),
  };
}

module.exports = { assess, isFreezable, capFor, POLICY };
