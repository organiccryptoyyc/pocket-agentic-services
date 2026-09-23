// Wallet and DeFi Intelligence — a Pocket Network service.
//
// Eight endpoints for an autonomous agent evaluating a wallet or a DeFi
// protocol before it acts: wallet balance/risk/smart-money/prospect
// profiling (via public Blockscout explorer instances, EVM chains), a
// pre-transaction protocol+wallet precheck, yield-opportunity ranking,
// protocol health, and stablecoin depeg checking (via DefiLlama's free
// public API). Every number is fetched live; nothing is a bundled static
// list. See README.md "Verification" for what was interactively confirmed
// against the real endpoints during this build.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const defi = require("./lib/defi");
const { cached } = require("./lib/net");

const SERVICE = "wallet-defi-intel";
const VERSION = "1.0.0";
const VERSION_PATH = "/v1/version";
const HEALTH_PATH = "/v1/health";

function requireString(body, field, example) {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ClientError(422, "invalid_input", `field '${field}' is required and must be a non-empty string${example ? ` (e.g. ${JSON.stringify(example)})` : ""}`);
  }
  return v.trim();
}

function clampInt(value, { min, max, def }) {
  if (value === undefined || value === null || value === "") return def;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ClientError(422, "invalid_input", `expected an integer, got ${JSON.stringify(value)}`);
  if (n < min || n > max) throw new ClientError(422, "invalid_input", `must be between ${min} and ${max}, got ${n}`);
  return n;
}

function withMeta(payload, cacheInfo) {
  return { service: SERVICE, fetched_at: new Date().toISOString(), cache: { stale: !!cacheInfo.stale, age_ms: cacheInfo.ageMs }, ...payload };
}

function toClientError(e) {
  if (e.isClientError) return new ClientError(422, "invalid_input", e.message);
  return e;
}

// --- shared wallet-profile builder (used by wallet-balance, wallet-risk, ---
// --- smart-money, and prospect-enrichment so they share one set of calls) --

async function buildWalletProfile(chain, address) {
  let addr, counters, tokens;
  try {
    [addr, counters, tokens] = await Promise.all([
      defi.blockscoutAddress(chain, address),
      defi.blockscoutCounters(chain, address),
      defi.blockscoutTokenBalances(chain, address),
    ]);
  } catch (e) {
    throw toClientError(e);
  }
  if (!addr.found) throw new ClientError(404, "not_found", `no on-chain activity found for '${address}' on '${chain}'`);

  const txCount = counters.transactions_count != null ? Number(counters.transactions_count) : 0;
  const nativeBalanceWei = addr.coin_balance || "0";
  const nativeBalanceEth = Number(nativeBalanceWei) / 1e18;

  const priced = tokens
    .map((t) => {
      const rate = Number(t.token?.exchange_rate);
      const decimals = Number(t.token?.decimals || 18);
      const qty = Number(t.value || "0") / 10 ** decimals;
      const usd = Number.isFinite(rate) && rate > 0 ? qty * rate : null;
      return { symbol: t.token?.symbol, name: t.token?.name, type: t.token?.type, reputation: t.token?.reputation, quantity: qty, usd_value: usd };
    })
    .filter((t) => t.usd_value != null && t.usd_value > 0.01)
    .sort((a, b) => b.usd_value - a.usd_value);

  const suspectTokens = tokens.filter((t) => t.token?.reputation && t.token.reputation !== "ok");
  const suspectRatio = tokens.length > 0 ? suspectTokens.length / tokens.length : 0;

  return {
    chain, address,
    is_contract: !!addr.is_contract,
    is_verified: !!addr.is_verified,
    is_scam: !!addr.is_scam,
    reputation: addr.reputation ?? null,
    ens_name: addr.ens_domain_name || null,
    native_balance: nativeBalanceEth,
    transactions_count: txCount,
    token_transfers_count: counters.token_transfers_count != null ? Number(counters.token_transfers_count) : null,
    distinct_tokens_held: tokens.length,
    top_priced_tokens: priced.slice(0, 10),
    estimated_priced_usd_value: Math.round(priced.reduce((s, t) => s + t.usd_value, 0) * 100) / 100,
    suspect_token_ratio: Math.round(suspectRatio * 1000) / 1000,
    suspect_token_count: suspectTokens.length,
  };
}

// --- /v1/wallet-balance ------------------------------------------------------

async function handleWalletBalance(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const cacheKey = `wallet-balance:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 60_000, async () => {
    const p = await buildWalletProfile(chain, address);
    return {
      chain: p.chain, address: p.address, native_balance: p.native_balance,
      estimated_priced_usd_value: p.estimated_priced_usd_value,
      distinct_tokens_held: p.distinct_tokens_held, top_priced_tokens: p.top_priced_tokens,
      note: "estimated_priced_usd_value covers only held tokens the explorer has a live exchange_rate for; it is a lower bound, not a full portfolio valuation.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/wallet-risk ---------------------------------------------------------

function scoreWalletRisk(p) {
  const reasons = [];
  let risk = 0;
  if (p.is_scam) { risk = 100; reasons.push("flagged as scam by the block explorer (risk forced to 100)"); return { risk, reasons }; }
  if (p.reputation && p.reputation !== "ok") { risk += 25; reasons.push(`explorer reputation flag is '${p.reputation}' (+25 risk)`); }
  risk += Math.min(30, p.suspect_token_ratio * 30 * 3.33); // ratio 0..1 -> up to 30pt, scaled so ~30% suspect ratio maxes it
  if (p.suspect_token_ratio > 0) reasons.push(`${(p.suspect_token_ratio * 100).toFixed(1)}% of held tokens are flagged by the explorer (+${Math.min(30, p.suspect_token_ratio * 100).toFixed(1)} risk)`);
  if (p.transactions_count < 5) { risk += 20; reasons.push(`only ${p.transactions_count} transactions observed, very low history (+20 risk)`); }
  else if (p.transactions_count < 20) { risk += 10; reasons.push(`${p.transactions_count} transactions observed, limited history (+10 risk)`); }
  if (!p.ens_name && p.transactions_count < 5) { risk += 5; reasons.push("no ENS identity and low activity (+5 risk)"); }
  if (reasons.length === 0) reasons.push("no risk signals observed in this backend's checks");
  return { risk: Math.max(0, Math.min(100, Math.round(risk * 10) / 10)), reasons };
}

async function handleWalletRisk(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const cacheKey = `wallet-risk:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 60_000, async () => {
    const p = await buildWalletProfile(chain, address);
    const { risk, reasons } = scoreWalletRisk(p);
    return {
      chain: p.chain, address: p.address, risk_score: risk, risk_score_scale: "0-100, HIGHER means MORE risk (opposite convention from this repo's other trust scores)",
      is_contract: p.is_contract, is_verified: p.is_verified, is_scam: p.is_scam,
      suspect_token_ratio: p.suspect_token_ratio, transactions_count: p.transactions_count, reasons,
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/smart-money ----------------------------------------------------------

function scoreSmartMoney(p) {
  const reasons = [];
  if (p.is_scam) return { score: 0, reasons: ["flagged as scam by the block explorer"] };
  let score = 0;
  const activityPts = Math.min(35, Math.log10(1 + p.transactions_count) * 9);
  score += activityPts;
  if (activityPts > 5) reasons.push(`${p.transactions_count} transactions, established on-chain activity (+${activityPts.toFixed(1)})`);
  const cleanTokens = p.distinct_tokens_held - p.suspect_token_count;
  const diversityPts = Math.min(30, Math.log10(1 + Math.max(0, cleanTokens)) * 12);
  score += diversityPts;
  if (diversityPts > 0) reasons.push(`${cleanTokens} non-flagged token holdings, diversified position (+${diversityPts.toFixed(1)})`);
  if (p.ens_name) { score += 10; reasons.push(`has ENS identity '${p.ens_name}' (+10)`); }
  if (p.estimated_priced_usd_value > 100_000) { score += 25; reasons.push(`$${Math.round(p.estimated_priced_usd_value).toLocaleString()} in priced holdings (+25)`); }
  else if (p.estimated_priced_usd_value > 10_000) { score += 12; reasons.push(`$${Math.round(p.estimated_priced_usd_value).toLocaleString()} in priced holdings (+12)`); }
  score -= Math.min(20, p.suspect_token_ratio * 100 * 0.3);
  return { score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)), reasons };
}

async function handleSmartMoney(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const cacheKey = `smart-money:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 60_000, async () => {
    const p = await buildWalletProfile(chain, address);
    const { score, reasons } = scoreSmartMoney(p);
    return {
      chain: p.chain, address: p.address, smart_money_score: score, smart_money_score_scale: "0-100, higher looks more like an established, diversified, clean wallet",
      reasons,
      methodology: "A heuristic from public on-chain activity (tx count, clean token diversity, ENS identity, priced " +
        "holdings) — not insider-trading or alpha detection, and not a guarantee of investment skill.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/prospect-enrichment: one call, full profile -------------------------

async function handleProspectEnrichment(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const cacheKey = `prospect-enrichment:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 60_000, async () => {
    const p = await buildWalletProfile(chain, address);
    const risk = scoreWalletRisk(p);
    const smart = scoreSmartMoney(p);
    return {
      chain: p.chain, address: p.address,
      balance: { native_balance: p.native_balance, estimated_priced_usd_value: p.estimated_priced_usd_value, distinct_tokens_held: p.distinct_tokens_held, top_priced_tokens: p.top_priced_tokens },
      risk: { score: risk.risk, reasons: risk.reasons },
      smart_money: { score: smart.score, reasons: smart.reasons },
      identity: { ens_name: p.ens_name, is_contract: p.is_contract, is_verified: p.is_verified },
      note: "One call combining wallet-balance + wallet-risk + smart-money for an agent doing lead/counterparty qualification, without three separate round trips.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/protocol-health -------------------------------------------------------

async function handleProtocolHealth(body) {
  const slug = requireString(body, "protocol", "aave").toLowerCase();
  const cacheKey = `protocol-health:${slug}`;
  const { value, stale, ageMs } = await cached(cacheKey, 900_000, async () => {
    let p;
    try {
      p = await defi.llamaProtocol(slug);
    } catch (e) {
      throw toClientError(e);
    }
    if (!p.found) throw new ClientError(404, "not_found", `no DefiLlama protocol with slug '${slug}'`);
    const tvlSeries = p.tvl || [];
    const latest = tvlSeries[tvlSeries.length - 1];
    const days = (n) => tvlSeries[tvlSeries.length - 1 - n];
    const d7 = days(7);
    const d30 = days(30);
    const pctChange = (then) => (then && latest ? ((latest.totalLiquidityUSD - then.totalLiquidityUSD) / then.totalLiquidityUSD) * 100 : null);
    const chains = Object.keys(p.currentChainTvls || {}).filter((c) => !c.includes("-"));
    const unrecoveredHacks = (p.hacks || []).filter((h) => !h.returnedFunds || h.returnedFunds < h.amount);
    return {
      protocol: p.name || slug,
      slug,
      current_tvl_usd: latest ? latest.totalLiquidityUSD : null,
      tvl_change_7d_pct: pctChange(d7) != null ? Math.round(pctChange(d7) * 100) / 100 : null,
      tvl_change_30d_pct: pctChange(d30) != null ? Math.round(pctChange(d30) * 100) / 100 : null,
      chains,
      chain_count: chains.length,
      mcap_usd: p.mcap ?? null,
      hacks_total: (p.hacks || []).length,
      hacks_with_unreturned_funds: unrecoveredHacks.length,
      hacks: (p.hacks || []).map((h) => ({ date: h.date, name: h.name, amount: h.amount, returned_funds: h.returnedFunds, fully_recovered: h.returnedFunds >= h.amount })),
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/depeg-check -----------------------------------------------------------

async function handleDepegCheck(body) {
  const symbol = requireString(body, "symbol", "USDT").toUpperCase();
  const cacheKey = `depeg-check:${symbol}`;
  const { value, stale, ageMs } = await cached(cacheKey, 300_000, async () => {
    const all = await defi.llamaStablecoins();
    const asset = all.find((a) => (a.symbol || "").toUpperCase() === symbol);
    if (!asset) throw new ClientError(404, "not_found", `no tracked stablecoin with symbol '${symbol}'`);
    const price = asset.price;
    const pegTarget = asset.pegType === "peggedUSD" ? 1.0 : asset.pegType === "peggedEUR" ? null : null;
    const deviationPct = pegTarget != null && price != null ? ((price - pegTarget) / pegTarget) * 100 : null;
    const circ = asset.circulating?.peggedUSD ?? Object.values(asset.circulating || {})[0] ?? null;
    const circPrevWeek = asset.circulatingPrevWeek?.peggedUSD ?? Object.values(asset.circulatingPrevWeek || {})[0] ?? null;
    const supplyChangeWeekPct = circ != null && circPrevWeek ? ((circ - circPrevWeek) / circPrevWeek) * 100 : null;
    return {
      symbol, name: asset.name, peg_type: asset.pegType, peg_mechanism: asset.pegMechanism,
      price_usd: price ?? null,
      deviation_from_peg_pct: deviationPct != null ? Math.round(deviationPct * 10000) / 10000 : null,
      is_depegged: deviationPct != null ? Math.abs(deviationPct) > 1 : null,
      circulating_supply: circ,
      supply_change_7d_pct: supplyChangeWeekPct != null ? Math.round(supplyChangeWeekPct * 100) / 100 : null,
      note: pegTarget == null ? "peg deviation is only computed for USD-pegged assets (pegType peggedUSD); this asset's pegType is '" + asset.pegType + "'" : "is_depegged uses a 1% deviation threshold, a common industry convention, not a protocol-defined constant.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/yields: best opportunities from DefiLlama's pool list ----------------

async function handleYields(body) {
  const chain = body?.chain ? requireString(body, "chain").toLowerCase() : null;
  const stablecoinOnly = !!body?.stablecoin_only;
  const minTvlUsd = clampInt(body?.min_tvl_usd, { min: 0, max: 10_000_000_000, def: 1_000_000 });
  const limit = clampInt(body?.limit, { min: 1, max: 50, def: 10 });
  const cacheKey = `yields:${chain || "*"}:${stablecoinOnly}:${minTvlUsd}:${limit}`;
  const { value, stale, ageMs } = await cached(cacheKey, 300_000, async () => {
    const pools = await defi.llamaPools();
    let filtered = pools.filter((p) => p.tvlUsd >= minTvlUsd && p.apy != null && Number.isFinite(p.apy) && !p.outlier);
    if (chain) filtered = filtered.filter((p) => (p.chain || "").toLowerCase() === chain);
    if (stablecoinOnly) filtered = filtered.filter((p) => p.stablecoin);
    filtered.sort((a, b) => b.apy - a.apy);
    const top = filtered.slice(0, limit).map((p) => ({
      chain: p.chain, project: p.project, symbol: p.symbol, apy: p.apy, apy_base: p.apyBase, apy_reward: p.apyReward,
      tvl_usd: p.tvlUsd, stablecoin: !!p.stablecoin, il_risk: p.ilRisk, exposure: p.exposure, pool_id: p.pool,
    }));
    return {
      filters: { chain, stablecoin_only: stablecoinOnly, min_tvl_usd: minTvlUsd },
      pools_considered: filtered.length, pools_total_tracked: pools.length,
      opportunities: top,
      note: "Ranked by headline APY from DefiLlama's public pool tracker; outlier pools are excluded but high APY " +
        "still correlates with high risk (new/small/unaudited pools) — apy_reward-heavy pools are especially volatile.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/precheck: composite wallet-risk + protocol-health gate --------------

async function handlePrecheck(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const protocol = requireString(body, "protocol", "aave").toLowerCase();
  const cacheKey = `precheck:${chain}:${address.toLowerCase()}:${protocol}`;
  const { value, stale, ageMs } = await cached(cacheKey, 60_000, async () => {
    const [walletProfile, protocolHealth] = await Promise.all([
      buildWalletProfile(chain, address),
      defi.llamaProtocol(protocol).catch((e) => { throw toClientError(e); }),
    ]);
    if (!protocolHealth.found) throw new ClientError(404, "not_found", `no DefiLlama protocol with slug '${protocol}'`);
    const { risk, reasons: riskReasons } = scoreWalletRisk(walletProfile);
    const tvlSeries = protocolHealth.tvl || [];
    const latest = tvlSeries[tvlSeries.length - 1];
    const d7 = tvlSeries[tvlSeries.length - 8];
    const tvlDrop7dPct = d7 && latest ? ((latest.totalLiquidityUSD - d7.totalLiquidityUSD) / d7.totalLiquidityUSD) * 100 : null;
    const unrecoveredHacks = (protocolHealth.hacks || []).filter((h) => !h.returnedFunds || h.returnedFunds < h.amount);

    const flags = [];
    if (risk >= 50) flags.push({ signal: "wallet_risk", severity: "high", detail: `wallet risk_score ${risk}/100` });
    if (unrecoveredHacks.length > 0) flags.push({ signal: "protocol_unrecovered_hack", severity: "high", detail: `${unrecoveredHacks.length} hack(s) with unreturned funds on record` });
    if (tvlDrop7dPct != null && tvlDrop7dPct <= -20) flags.push({ signal: "protocol_tvl_drop", severity: "moderate", detail: `protocol TVL down ${tvlDrop7dPct.toFixed(1)}% over 7d` });

    const recommendation = flags.some((f) => f.severity === "high") ? "avoid" : flags.length > 0 ? "proceed_with_caution" : "proceed";
    return {
      chain, address, protocol,
      wallet_risk_score: risk, wallet_risk_reasons: riskReasons,
      protocol_current_tvl_usd: latest ? latest.totalLiquidityUSD : null,
      protocol_tvl_change_7d_pct: tvlDrop7dPct != null ? Math.round(tvlDrop7dPct * 100) / 100 : null,
      protocol_unrecovered_hacks: unrecoveredHacks.length,
      flags, recommendation,
      note: "A pre-transaction gate combining this wallet's risk profile with the target protocol's live TVL trend " +
        "and hack history; 'avoid' means at least one high-severity flag, not a guarantee of safety either way.",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- /v1/nft-analytics ---------------------------------------------------------

async function handleNftAnalytics(body) {
  const chain = requireString(body, "chain", "eth").toLowerCase();
  const address = requireString(body, "address");
  const cacheKey = `nft-analytics:${chain}:${address.toLowerCase()}`;
  const { value, stale, ageMs } = await cached(cacheKey, 300_000, async () => {
    let collections;
    try {
      collections = await defi.blockscoutNftCollections(chain, address);
    } catch (e) {
      throw toClientError(e);
    }
    const items = collections.map((c) => ({
      collection: c.token?.name || null, symbol: c.token?.symbol || null, contract: c.token?.address_hash || null,
      token_type: c.token?.type || null, holders_count: c.token?.holders_count != null ? Number(c.token.holders_count) : null,
      reputation: c.token?.reputation || null, amount_held: c.amount != null ? Number(c.amount) : (c.token_instances || []).length,
    }));
    const totalItems = items.reduce((s, i) => s + (i.amount_held || 0), 0);
    const flagged = items.filter((i) => i.reputation && i.reputation !== "ok");
    return {
      chain, address,
      collections_held: items.length, total_items_held: totalItems,
      flagged_collections: flagged.length,
      collections: items.sort((a, b) => (b.amount_held || 0) - (a.amount_held || 0)).slice(0, 25),
      note: "Sourced from the chain's public Blockscout instance; large holders may be paginated beyond what this endpoint returns (first page only).",
    };
  });
  return withMeta(value, { stale, ageMs });
}

// --- wiring --------------------------------------------------------------------

const routes = new Map([
  ["POST /v1/wallet-balance", handleWalletBalance],
  ["POST /v1/wallet-risk", handleWalletRisk],
  ["POST /v1/smart-money", handleSmartMoney],
  ["POST /v1/prospect-enrichment", handleProspectEnrichment],
  ["POST /v1/precheck", handlePrecheck],
  ["POST /v1/yields", handleYields],
  ["POST /v1/protocol-health", handleProtocolHealth],
  ["POST /v1/depeg-check", handleDepegCheck],
  ["POST /v1/nft-analytics", handleNftAnalytics],
]);

const server = createServer({ service: SERVICE, version: VERSION, versionPath: VERSION_PATH, healthPath: HEALTH_PATH, routes });
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`);
});
