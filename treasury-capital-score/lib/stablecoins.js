// Stablecoin exposure tcs6-stablecoin-exposure/1.0 (owner 2026-10-31; methodology/tcs6_stablecoin_exposure_v1.json),
// evidence only: which stablecoins the treasury holds, directly or wrapped, how much rests on each issuer, whether a
// plain stablecoin is off its peg, and which pmic-crypto-signals series tracks each one's supply.
//
// Wrappers (Aave aTokens, savings and vault shares, Compound v3 receipts) count under the stablecoin they hold, by the
// policy's symbol rules; a symbol the rules don't resolve is listed as unmapped. Pure: no network, no clock.
"use strict";

const POLICY = require("../methodology/tcs6_stablecoin_exposure_v1.json");
const { isFreezable } = require("./walletexit");

const round2 = (v) => Math.round(v * 100) / 100;
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1e4) / 1e4 : null);
const AAVE = new RegExp(POLICY.wrappers.aave_receipt.pattern);

// -> { underlying, wrapped } or null when the symbol isn't a known stablecoin or wrapper
function resolve(symbol, policy = POLICY) {
  let s = String(symbol || "").toUpperCase();
  let wrapped = false;
  for (let i = 0; i < 3; i++) {
    const plain = policy.aliases[s] || s;
    if (policy.underlyings[plain]) return { underlying: plain, wrapped };
    const w = policy.wrappers.symbols[s];
    const m = w ? null : AAVE.exec(s);
    if (!w && !m) return null;
    s = w || m[1];
    wrapped = true;
  }
  return null;
}

// -> null when the treasury holds no verified stablecoins; otherwise the assessment.
function assess(base, policy = POLICY) {
  const rows = base.verifiedRows.filter((r) => r.h.asset_class === "fiat_stablecoin" && r.fair > 0);
  if (!rows.length) return null;
  const treasury = base.grossVerified;
  const total = rows.reduce((s, r) => s + r.fair, 0);
  const by = new Map();
  const unmapped = [];
  const offPeg = [];
  for (const r of rows) {
    const res = resolve(r.h.symbol, policy);
    if (!res) {
      unmapped.push({ symbol: r.h.symbol || null, chain: r.h.chain || null, value_usd: round2(r.fair) });
      continue;
    }
    if (!by.has(res.underlying)) by.set(res.underlying, { usd: 0, plain: 0, wrapped: 0, holdings: 0, symbols: new Set(), chains: new Set() });
    const u = by.get(res.underlying);
    u.usd += r.fair;
    u[res.wrapped ? "wrapped" : "plain"] += r.fair;
    u.holdings += 1;
    u.symbols.add(r.h.symbol);
    if (r.h.chain) u.chains.add(r.h.chain);
    const px = Number(((r.h.prices || [])[0] || {}).usd);
    if (!res.wrapped && Number.isFinite(px) && Math.abs(px - 1) > policy.peg_tolerance)
      offPeg.push({ symbol: r.h.symbol, chain: r.h.chain || null, price_usd: px, deviation_pct: Math.round((px - 1) * 1e4) / 100, value_usd: round2(r.fair) });
  }
  const list = [...by.entries()].map(([sym, u]) => {
    const meta = policy.underlyings[sym];
    return { stablecoin: sym, issuer: meta.issuer, design: meta.design, freezable: isFreezable({ symbol: sym }),
      value_usd: round2(u.usd), share_of_stablecoins: share(u.usd, total), share_of_treasury: share(u.usd, treasury),
      plain_usd: round2(u.plain), wrapped_usd: round2(u.wrapped), holdings: u.holdings,
      symbols: [...u.symbols].sort(), chains: [...u.chains].sort(), pmic_crypto_series: meta.pmic_crypto_series };
  }).sort((a, b) => b.value_usd - a.value_usd);
  const covered = list.filter((u) => u.pmic_crypto_series.length).reduce((s, u) => s + u.value_usd, 0);
  const freezable = list.filter((u) => u.freezable).reduce((s, u) => s + u.value_usd, 0);
  const top = list[0];
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  return {
    policy_id: policy.policy_id,
    stablecoin_usd: round2(total),
    share_of_treasury: share(total, treasury),
    treasury_value_usd: round2(treasury),
    largest_issuer: top ? { stablecoin: top.stablecoin, issuer: top.issuer, share_of_stablecoins: top.share_of_stablecoins } : null,
    freezable_usd: round2(freezable),
    pmic_crypto_covered_usd: round2(covered),
    pmic_crypto_coverage: share(covered, total),
    stablecoins: list,
    off_peg: offPeg,
    unmapped,
    statement: `Stablecoins are $${Math.round(total).toLocaleString("en-US")} (${pct(total / (treasury || total))} of counted treasury value)`
      + (top ? `; the largest is ${top.stablecoin} (${top.issuer}) at ${pct(top.share_of_stablecoins)} of them` : "")
      + `. $${Math.round(freezable).toLocaleString("en-US")} is in stablecoins whose issuer can freeze an address. `
      + (offPeg.length ? `${offPeg.length} plain holding(s) priced more than ${policy.peg_tolerance * 100}% from $1. ` : `No plain holding is priced more than ${policy.peg_tolerance * 100}% from $1. `)
      + `pmic-crypto-signals tracks the supply of ${pct(covered / total)} of them. Evidence only: no effect on the score.`,
  };
}

module.exports = { assess, resolve, POLICY };
