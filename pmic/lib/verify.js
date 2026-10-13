// Verified layer 1.5: independent cross-checks of collected series, written to the confirmations
// table (migration 006). Nothing here changes a series, a score or what is pushed to the hub.
//
//   price    the Uniswap v3 ETH and BTC prices (chainrpc:eth_usd, chainrpc:btc_usd) against the
//            Chainlink ETH/USD and BTC/USD feeds read at the same block, through the same free Pocket
//            RPC. A DEX pool and an oracle are different methods. Tolerance PRICE_TOLERANCE_PCT. Only
//            the last PRICE_DAYS days are checked, each date once.
//   supply   USDC/USDT totalSupply() on each EVM chain with a second public RPC (publicnode), read at
//            the same recent block from both: two independent nodes must return the same number.
//            One token per chain per day.
//
//   xcheck   the cross_check groups PMIC already compares while scoring (lib/derive.js crossCheck:
//            FRED's copy of payrolls, unemployment and JOLTS against BLS, the original publisher),
//            recorded here too: latest common observation, same tolerance as derive.js (0.5% relative
//            or 0.05 absolute, whichever is larger), each observation once. Stored values only.
//   pairs    Tier 1, stored values only: FRED's CPI against BLS's (same index, 0.05%); FRED's real GDP
//            level turned into the annualized quarterly rate against BEA's published rate (0.15 point
//            agree, 0.5 partial); World Bank against IMF WEO for GDP growth, inflation and unemployment,
//            latest common year before this one (0.3 point agree, 1.0 partial: methods differ).
//   kev      CISA's weekly count of known exploited vulnerabilities against NVD's count of CVEs added
//            to KEV in the same Monday-Sunday window (one NVD request per week, last 2 complete weeks).
//   pokt     Pocket Network now: the indexer's latest block (staked suppliers, apps, gateways,
//            validators) against the chain's own API (LCD); once a day. Equal = agree, within 2% =
//            partial (suppliers mid-unstake are still listed by the chain), more = disagree.
//   tier2    a second publisher's copy, fetched once per new observation of ours (keyless):
//            FRED Treasury yields vs Treasury's daily par yield curve CSV; FRED fed funds vs the New
//            York Fed's EFFR; ECB deposit rate vs FRED ECBDFR; BLS hourly earnings and PPI final demand
//            vs FRED's copies; FRED's Monthly Treasury Statement receipts, outlays and deficit vs
//            Treasury's Fiscal Data API (deficit sign flipped: Treasury reports a deficit as positive).
//   tier3    USGS's monthly count of magnitude 6+ quakes worldwide against EMSC's (an independent
//            network; magnitudes differ slightly between agencies: within 1 quake or 10% agrees, 25%
//            partial). Form 990 records: the IRS extract stays primary; each sampled large filer's
//            revenue is checked against ProPublica's Nonprofit Explorer record for the same EIN and tax
//            period. ProPublica's Data Terms of Use bar charging to view, sub-licensing or reselling
//            their data, so these rows are INTERNAL_ONLY: kept in the evidence bank for our own quality
//            control and never put into a paid response or bundle.
//
// A failed second read is an "unavailable" row; a failure of the whole step is returned to the
// caller and never stops the collect pass.
"use strict";

const crypto = require("crypto");
const { fetchText } = require("./net");
const { kvGet, kvSet, tx } = require("./db");
const { canonicalJson } = require("./canonical");

const DAY = 86400000;
const PRICE_TOLERANCE_PCT = 1.0;
const PRICE_DAYS = 3;
const BLOCK_LAG = 5;
const CHAINLINK = { // Ethereum mainnet aggregator proxies, 8 decimals
  "chainrpc:eth_usd": { feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", pair: "ETH/USD" },
  "chainrpc:btc_usd": { feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", pair: "BTC/USD" },
};
const FALLBACK_RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  "arb-one": "https://arbitrum-one-rpc.publicnode.com",
  poly: "https://polygon-bor-rpc.publicnode.com",
};
const AGREEMENTS = new Set(["agree", "disagree", "partial", "unavailable"]);
const COLUMNS = ["run_id", "field", "entity_id", "our_value", "upstream_service", "upstream_supplier", "upstream_value_hash",
  "agreement", "delta_pct", "tolerance_pct", "observed_at", "app_address", "cu_spent", "session_height"];

const primaryRpc = (chain) => `https://${chain}.api.pocket.network`;
const hostOf = (url) => new URL(url).host;
const hex = (n) => `0x${n.toString(16)}`;
const ymd = (d) => d.toISOString().slice(0, 10);
const valueHash = (v) => crypto.createHash("sha256").update(canonicalJson(v), "utf8").digest("hex");

let nextId = 1;
async function rpc(fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${hostOf(url)} ${method}: HTTP ${r.status}`);
  let body;
  try { body = JSON.parse(r.text); } catch { throw new Error(`${hostOf(url)} ${method}: answer is not JSON`); }
  if (body.error || body.result === undefined || body.result === null) throw new Error(`${hostOf(url)} ${method}: ${(body.error && body.error.message) || "no result"}`);
  return body.result;
}

function addConfirmations(db, rows) {
  const stmt = db.prepare(`INSERT INTO confirmations (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`);
  for (const r of rows) {
    if (!AGREEMENTS.has(r.agreement)) throw new Error(`bad agreement ${r.agreement}`);
    const rec = { ...r };
    if ("upstream_value" in rec) {
      rec.upstream_value_hash = rec.upstream_value === null ? null : valueHash(rec.upstream_value);
      delete rec.upstream_value;
    }
    rec.our_value = rec.our_value === undefined || rec.our_value === null ? null : JSON.stringify(rec.our_value);
    rec.cu_spent = rec.cu_spent || 0;
    stmt.run(...COLUMNS.map((c) => (rec[c] === undefined ? null : rec[c])));
  }
}

function recordUpstream(db, service, { ok = true, disagreed = false, latencyMs = null, seenAt }) {
  db.prepare("INSERT OR IGNORE INTO upstream_quality (service_id, supplier) VALUES (?, '')").run(service);
  db.prepare(`UPDATE upstream_quality SET calls = calls + 1, errors = errors + ?, disagreements = disagreements + ?, last_seen = ?,
      median_latency_ms = CASE WHEN ? IS NULL THEN median_latency_ms WHEN median_latency_ms IS NULL THEN ? ELSE (median_latency_ms + ?) / 2.0 END
      WHERE service_id = ? AND supplier = ''`).run(ok ? 0 : 1, disagreed ? 1 : 0, seenAt, latencyMs, latencyMs, latencyMs, service);
}

// Chainlink latestRoundData() at a block: answer (8 decimals) and updatedAt.
async function chainlinkAt(fetchImpl, feed, block) {
  const out = await rpc(fetchImpl, primaryRpc("eth"), "eth_call", [{ to: feed, data: "0xfeaf968c" }, hex(block)]);
  if (typeof out !== "string" || out.length < 2 + 64 * 4) throw new Error("chainlink: short answer");
  const word = (i) => BigInt(`0x${out.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  let answer = word(1);
  if (answer >= 1n << 255n) answer -= 1n << 256n;
  return { usd: Number(answer) / 1e8, updatedAt: Number(word(3)) };
}

async function checkPrices(db, catalog, ctx) {
  const since = ymd(new Date(ctx.now.getTime() - PRICE_DAYS * DAY));
  for (const s of catalog.series.filter((x) => CHAINLINK[x.series_id])) {
    const store = kvGet(db, `${s.source_id}:v:${s.series_id}`) || {}; // the adapter's per-date values, with block
    const done = kvGet(db, `verified:${s.series_id}`) || {};
    for (const date of Object.keys(store).filter((d) => d >= since && !(d in done)).sort()) {
      const ours = store[date];
      if (!Number.isFinite(ours.value) || !Number.isInteger(ours.block)) continue;
      const { feed, pair } = CHAINLINK[s.series_id];
      const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id,
        our_value: { date, usd: ours.value, block: ours.block }, upstream_service: "chainlink",
        tolerance_pct: PRICE_TOLERANCE_PCT, observed_at: `${date}T00:00:00Z` };
      const t0 = Date.now();
      try {
        const cl = await chainlinkAt(ctx.fetchImpl, feed, ours.block);
        const delta = Math.round((Math.abs(ours.value - cl.usd) / cl.usd) * 100 * 10000) / 10000;
        const agreement = delta <= PRICE_TOLERANCE_PCT ? "agree" : "disagree";
        ctx.rows.push({ ...row, upstream_value: { pair, usd: cl.usd, updated_at: cl.updatedAt }, agreement, delta_pct: delta });
        ctx.calls.push(["chainlink", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
      } catch (e) {
        ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
        ctx.calls.push(["chainlink", { ok: false }]);
        ctx.notes.push(`${s.series_id} ${date}: ${String(e.message).slice(0, 120)}`);
      }
      done[date] = ctx.nowIso;
      kvSet(db, `verified:${s.series_id}`, done);
    }
  }
}

async function checkSupplyNodes(db, catalog, ctx) {
  const today = ymd(ctx.now);
  const doneKey = "verified:supply_nodes";
  const done = kvGet(db, doneKey) || {};
  const seen = new Set();
  for (const s of catalog.series.filter((x) => x.params && x.params.kind === "erc20_supply")) {
    const chain = s.params.chain;
    const fallback = FALLBACK_RPC[chain];
    if (!fallback || seen.has(chain) || done[chain] === today) continue;
    seen.add(chain);
    const service = `rpc:${hostOf(fallback)}`;
    const call = (url, block) => rpc(ctx.fetchImpl, url, "eth_call", [{ to: s.params.contract, data: "0x18160ddd" }, hex(block)]);
    try {
      const block = Number(BigInt(await rpc(ctx.fetchImpl, primaryRpc(chain), "eth_blockNumber", []))) - BLOCK_LAG;
      const ours = BigInt(await call(primaryRpc(chain), block));
      const row = { run_id: ctx.runId, field: `rpc.total_supply:${chain}:${s.params.contract.toLowerCase()}`, entity_id: s.entity_id,
        our_value: { raw: ours.toString(), block, series_id: s.series_id }, upstream_service: service, tolerance_pct: 0,
        observed_at: ctx.nowIso };
      const t0 = Date.now();
      try {
        const theirs = BigInt(await call(fallback, block));
        const agreement = theirs === ours ? "agree" : "disagree";
        ctx.rows.push({ ...row, upstream_value: theirs.toString(), agreement, delta_pct: theirs === ours ? 0 : null });
        ctx.calls.push([service, { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
      } catch (e) {
        ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
        ctx.calls.push([service, { ok: false }]);
        ctx.notes.push(`${service}: ${String(e.message).slice(0, 120)}`);
      }
      done[chain] = today;
      kvSet(db, doneKey, done);
    } catch (e) { // the primary itself failed: nothing to compare, retry next pass
      ctx.notes.push(`${chain} primary: ${String(e.message).slice(0, 120)}`);
    }
  }
}

function checkCrossGroups(db, catalog, ctx) {
  const groups = new Map();
  for (const s of catalog.series) {
    if (!s.cross_check) continue;
    if (!groups.has(s.cross_check)) groups.set(s.cross_check, []);
    groups.get(s.cross_check).push(s);
  }
  const latest = db.prepare(`SELECT a.observation_time t, a.metric_value av, b.metric_value bv FROM observations a
    JOIN observations b ON b.series_id = ? AND b.observation_time = a.observation_time
    WHERE a.series_id = ? ORDER BY a.observation_time DESC LIMIT 1`);
  for (const [group, members] of groups) {
    const ours = members.find((m) => m.source_id === "fred") || members[0]; // the copy we serve
    for (const peer of members.filter((m) => m !== ours)) {
      const r = latest.get(peer.series_id, ours.series_id);
      if (!r) continue;
      const key = `verified:xcheck:${group}:${peer.series_id}`;
      if (kvGet(db, key) === r.t) continue;
      const diff = Math.abs(r.av - r.bv);
      const agreement = diff <= Math.max(0.05, 0.005 * Math.abs(r.bv)) ? "agree" : "disagree";
      ctx.rows.push({ run_id: ctx.runId, field: `series:${ours.series_id}`, entity_id: ours.entity_id,
        our_value: { date: r.t, value: r.av }, upstream_service: peer.source_id, upstream_value: { series_id: peer.series_id, value: r.bv },
        agreement, delta_pct: r.bv ? Math.round((diff / Math.abs(r.bv)) * 100 * 10000) / 10000 : null, tolerance_pct: 0.5,
        observed_at: r.t.length === 10 ? `${r.t}T00:00:00Z` : r.t });
      ctx.calls.push([peer.source_id, { disagreed: agreement === "disagree" }]);
      kvSet(db, key, r.t);
    }
  }
}

const NVD = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const POKT_GQL = "https://data.pocket.network/graphql";
const POKT_LCD = "https://sauron-api.infra.pocket.network";
const POKT_LIVE = [ // series feed -> indexer field, LCD list path
  ["staked_suppliers", "stakedSuppliers", "/pokt-network/poktroll/supplier/supplier"],
  ["staked_apps", "stakedApps", "/pokt-network/poktroll/application/application"],
  ["gateways", "stakedGateways", "/pokt-network/poktroll/gateway/gateway"],
  ["validators", "stakedValidators", "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED"],
];
const round4 = (x) => Math.round(x * 10000) / 10000;
const at = (t) => (t.length === 10 ? `${t}T00:00:00Z` : t);

// One stored-value comparison: verdict from the difference (relative % or absolute points).
function pairRow(ctx, { ours, peer, t, av, bv, mode, agreeTol, partialTol, service }) {
  const diff = Math.abs(av - bv);
  const measure = mode === "pct" ? (bv ? (diff / Math.abs(bv)) * 100 : Infinity) : diff;
  const agreement = measure <= agreeTol ? "agree" : partialTol !== undefined && measure <= partialTol ? "partial" : "disagree";
  ctx.rows.push({ run_id: ctx.runId, field: `series:${ours.series_id}`, entity_id: ours.entity_id,
    our_value: { date: t, value: av }, upstream_service: service, upstream_value: { series_id: peer, value: bv },
    agreement, delta_pct: bv ? round4((diff / Math.abs(bv)) * 100) : null, tolerance_pct: mode === "pct" ? agreeTol : null,
    observed_at: at(t) });
  ctx.calls.push([service, { disagreed: agreement === "disagree" }]);
}

function checkPairs(db, catalog, ctx) {
  const byId = new Map(catalog.series.map((s) => [s.series_id, s]));
  const obs = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 8");
  const once = (key, t, fn) => { if (kvGet(db, key) !== t) { fn(); kvSet(db, key, t); } };
  // latest observation time both series have, before maxT
  const common = (a, b, maxT = "9999") => {
    const bm = new Map(obs.all(b).map((r) => [r.t, r.v]));
    const hit = obs.all(a).find((r) => r.t < maxT && bm.has(r.t) && Number.isFinite(r.v));
    return hit ? { t: hit.t, av: hit.v, bv: bm.get(hit.t) } : null;
  };
  // FRED CPI vs BLS CPI-U (same seasonally adjusted index)
  if (byId.has("fred:CPIAUCSL") && byId.has("bls:CUSR0000SA0")) {
    const c = common("fred:CPIAUCSL", "bls:CUSR0000SA0");
    if (c) once("verified:pair:cpi", c.t, () => pairRow(ctx, { ours: byId.get("fred:CPIAUCSL"), peer: "bls:CUSR0000SA0", ...c, mode: "pct", agreeTol: 0.05, service: "bls" }));
  }
  // FRED real GDP level -> annualized q/q growth vs BEA's published rate
  if (byId.has("fred:GDPC1") && byId.has("bea:NIPA:T10101:1")) {
    const g = obs.all("fred:GDPC1");
    const bea = new Map(obs.all("bea:NIPA:T10101:1").map((r) => [r.t, r.v]));
    if (g.length >= 2 && bea.has(g[0].t)) {
      const rate = Math.round((Math.pow(g[0].v / g[1].v, 4) - 1) * 100 * 1000) / 1000;
      once("verified:pair:gdp", g[0].t, () => pairRow(ctx, { ours: byId.get("fred:GDPC1"), peer: "bea:NIPA:T10101:1", t: g[0].t, av: rate, bv: bea.get(g[0].t),
        mode: "points", agreeTol: 0.15, partialTol: 0.5, service: "bea" }));
    }
  }
  // World Bank vs IMF WEO, latest common year before this one (IMF also carries projections)
  const thisYear = `${ctx.now.getUTCFullYear()}`;
  const WB_IMF = [["NY.GDP.MKTP.KD.ZG", "NGDP_RPCH"], ["FP.CPI.TOTL.ZG", "PCPIPCH"], ["SL.UEM.TOTL.ZS", "LUR"]];
  for (const s of catalog.series.filter((x) => x.source_id === "worldbank")) {
    const m = WB_IMF.find(([wb]) => s.series_id.endsWith(`:${wb}`));
    const peer = m && `imf:${s.entity_id}:${m[1]}`;
    if (!peer || !byId.has(peer)) continue;
    const c = common(s.series_id, peer, thisYear);
    if (c) once(`verified:pair:${s.series_id}`, c.t, () => pairRow(ctx, { ours: s, peer, ...c, mode: "points", agreeTol: 0.3, partialTol: 1.0, service: "imf" }));
  }
}

async function getJson(ctx, url, init) {
  const r = await ctx.fetchImpl(url, init || {});
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${hostOf(url)}: HTTP ${r.status}`);
  return JSON.parse(r.text);
}

async function checkKev(db, catalog, ctx) {
  const s = catalog.series.find((x) => x.series_id === "cisa:kev_added_weekly");
  if (!s) return;
  const weeks = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 3").all(s.series_id);
  const done = kvGet(db, "verified:kev") || {};
  for (const w of weeks.slice(1)) { // skip the newest week: it may still be filling
    if (done[w.t]) continue;
    const end = new Date(Date.parse(`${w.t}T00:00:00Z`) + 7 * DAY - 1).toISOString();
    const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id, our_value: { week: w.t, count: w.v },
      upstream_service: "nvd", tolerance_pct: 0, observed_at: at(w.t) };
    const t0 = Date.now();
    try {
      const j = await getJson(ctx, `${NVD}?kevStartDate=${w.t}T00:00:00.000Z&kevEndDate=${end}&resultsPerPage=1`);
      if (!Number.isFinite(j.totalResults)) throw new Error("nvd: no totalResults");
      const agreement = j.totalResults === w.v ? "agree" : "disagree";
      ctx.rows.push({ ...row, upstream_value: { week: w.t, count: j.totalResults }, agreement,
        delta_pct: w.v ? round4((Math.abs(j.totalResults - w.v) / w.v) * 100) : null });
      ctx.calls.push(["nvd", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
    } catch (e) {
      ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
      ctx.calls.push(["nvd", { ok: false }]);
      ctx.notes.push(`nvd ${w.t}: ${String(e.message).slice(0, 120)}`);
    }
    done[w.t] = ctx.nowIso;
    kvSet(db, "verified:kev", done);
  }
}

async function checkPoktLive(db, catalog, ctx) {
  const today = ymd(ctx.now);
  if (kvGet(db, "verified:pokt_live") === today) return;
  const series = new Map(catalog.series.filter((x) => x.source_id === "pokt").map((x) => [x.params && x.params.feed, x]));
  if (!series.size) return;
  let idx;
  try {
    const q = `{ blocks(orderBy: ID_DESC, first: 1) { nodes { id ${POKT_LIVE.map(([, f]) => f).join(" ")} } } }`;
    const j = await getJson(ctx, POKT_GQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) });
    idx = j.data.blocks.nodes[0];
  } catch (e) {
    ctx.notes.push(`pokt indexer: ${String(e.message).slice(0, 120)}`);
    return; // our side failed: nothing to compare, retry next pass
  }
  for (const [feed, field, path] of POKT_LIVE) {
    const s = series.get(feed);
    if (!s) continue;
    const row = { run_id: ctx.runId, field: `pokt.live:${feed}`, entity_id: s.entity_id, our_value: { block: Number(idx.id), count: idx[field] },
      upstream_service: "pokt-lcd", tolerance_pct: 0, observed_at: ctx.nowIso };
    const t0 = Date.now();
    try {
      const j = await getJson(ctx, `${POKT_LCD}${path}${path.includes("?") ? "&" : "?"}pagination.count_total=true&pagination.limit=1`);
      const total = Number(j.pagination && j.pagination.total);
      if (!Number.isFinite(total)) throw new Error("lcd: no pagination.total");
      const pct = total ? (Math.abs(idx[field] - total) / total) * 100 : 0;
      const agreement = idx[field] === total ? "agree" : pct <= 2 ? "partial" : "disagree";
      ctx.rows.push({ ...row, upstream_value: { count: total }, agreement, delta_pct: round4(pct) });
      ctx.calls.push(["pokt-lcd", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
    } catch (e) {
      ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
      ctx.calls.push(["pokt-lcd", { ok: false }]);
      ctx.notes.push(`pokt lcd ${feed}: ${String(e.message).slice(0, 120)}`);
    }
  }
  kvSet(db, "verified:pokt_live", today);
}

const FRED_CSV = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
const TREASURY_CSV = (year) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
const NYFED_EFFR = (from, to) => `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${from}&endDate=${to}`;
const MTS_T1 = (date) => `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_1?filter=record_date:eq:${date}&page[size]=40&fields=classification_desc,src_line_nbr,current_month_gross_rcpt_amt,current_month_gross_outly_amt,current_month_dfct_sur_amt`;
const TREASURY_COL = { "fred:DGS1MO": "1 Mo", "fred:DGS3MO": "3 Mo", "fred:DGS1": "1 Yr", "fred:DGS2": "2 Yr", "fred:DGS5": "5 Yr", "fred:DGS10": "10 Yr", "fred:DGS30": "30 Yr" };
// ours -> [FRED id, mode, agree tolerance]: the copy FRED republishes
const FRED_TWIN = {
  "bls:CES0500000003": ["CES0500000003", "points", 0.005],
  "bls:WPUFD4": ["PPIFID", "pct", 0.05], // not seasonally adjusted, like WPUFD4 (PPIFIS is the adjusted one)
  "ecb:FM.B.U2.EUR.4F.KR.DFR.LEV": ["ECBDFR", "points", 0.005],
};
const MTS_FIELD = { "fred:MTSR133FMS": ["current_month_gross_rcpt_amt", 1], "fred:MTSO133FMS": ["current_month_gross_outly_amt", 1], "fred:MTSDS133FMS": ["current_month_dfct_sur_amt", -1] };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function getText(ctx, url) {
  const r = await ctx.fetchImpl(url, {});
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`${hostOf(url)}: HTTP ${r.status}`);
  return r.text;
}
const csvRows = (text) => text.trim().split(/\r?\n/).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
const fredMap = (text) => new Map(csvRows(text).slice(1).filter((r) => r[1] !== "." && r[1] !== "").map((r) => [r[0], Number(r[1])]));

// Compare our latest stored observation with a fetched value, once per observation.
async function fetchedPair(db, ctx, s, { service, mode, agreeTol, read }) {
  const ours = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1").get(s.series_id);
  if (!ours) return;
  const key = `verified:t2:${s.series_id}`;
  if (kvGet(db, key) === ours.t) return;
  const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id, our_value: { date: ours.t, value: ours.v },
    upstream_service: service, tolerance_pct: mode === "pct" ? agreeTol : null, observed_at: at(ours.t) };
  const t0 = Date.now();
  try {
    const theirs = await read(ours.t);
    if (theirs === undefined) return; // the second source has not published this date yet: try again next pass
    const diff = Math.abs(ours.v - theirs);
    const measure = mode === "pct" ? (theirs ? (diff / Math.abs(theirs)) * 100 : Infinity) : diff;
    const agreement = measure <= agreeTol ? "agree" : "disagree";
    ctx.rows.push({ ...row, upstream_value: { date: ours.t, value: theirs }, agreement, delta_pct: theirs ? round4((diff / Math.abs(theirs)) * 100) : null });
    ctx.calls.push([service, { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
  } catch (e) {
    ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
    ctx.calls.push([service, { ok: false }]);
    ctx.notes.push(`${service} ${s.series_id}: ${String(e.message).slice(0, 120)}`);
  }
  kvSet(db, key, ours.t);
}

async function checkTier2(db, catalog, ctx) {
  const byId = new Map(catalog.series.map((x) => [x.series_id, x]));
  const memo = new Map(); // one download per URL per pass
  const once = (url) => { if (!memo.has(url)) memo.set(url, getText(ctx, url)); return memo.get(url); };
  // Treasury par yield curve (CSV per year, dates MM/DD/YYYY)
  for (const [id, col] of Object.entries(TREASURY_COL)) {
    if (!byId.has(id)) continue;
    await fetchedPair(db, ctx, byId.get(id), { service: "treasury", mode: "points", agreeTol: 0.005, read: async (t) => {
      const rows = csvRows(await once(TREASURY_CSV(t.slice(0, 4))));
      const c = rows[0].indexOf(col);
      if (c < 0) throw new Error(`treasury csv: no column ${col}`);
      const us = `${t.slice(5, 7)}/${t.slice(8, 10)}/${t.slice(0, 4)}`;
      const r = rows.find((x) => x[0] === us);
      return r && r[c] !== "" ? Number(r[c]) : undefined;
    } });
  }
  // FRED fed funds (7-day series) vs New York Fed EFFR (business days)
  if (byId.has("fred:DFF")) {
    await fetchedPair(db, ctx, byId.get("fred:DFF"), { service: "nyfed", mode: "points", agreeTol: 0.005, read: async (t) => {
      const j = JSON.parse(await once(NYFED_EFFR(ymd(new Date(Date.parse(`${t}T00:00:00Z`) - 7 * DAY)), t)));
      const r = (j.refRates || []).find((x) => x.effectiveDate === t);
      return r ? Number(r.percentRate) : undefined; // a weekend or holiday: no EFFR for that date
    } });
  }
  // FRED's republished copies of BLS and ECB series
  for (const [id, [fredId, mode, tol]] of Object.entries(FRED_TWIN)) {
    if (!byId.has(id)) continue;
    await fetchedPair(db, ctx, byId.get(id), { service: "fred", mode, agreeTol: tol, read: async (t) => fredMap(await once(FRED_CSV(fredId))).get(t) });
  }
  // FRED's Monthly Treasury Statement copies vs Treasury's Fiscal Data API (USD -> USD millions)
  for (const [id, [field, sign]] of Object.entries(MTS_FIELD)) {
    if (!byId.has(id)) continue;
    await fetchedPair(db, ctx, byId.get(id), { service: "fiscaldata", mode: "pct", agreeTol: 0.05, read: async (t) => {
      const d = new Date(Date.parse(`${t}T00:00:00Z`));
      const last = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
      const j = JSON.parse(await once(MTS_T1(last)));
      // Table 1 lists each month twice (prior fiscal year, then the current one): the current
      // fiscal year's block comes last, so the month's row with the highest line number is ours.
      const r = (j.data || []).filter((x) => x.classification_desc === MONTHS[d.getUTCMonth()])
        .sort((a, b) => Number(b.src_line_nbr) - Number(a.src_line_nbr))[0];
      if (!r || r[field] === "null") return undefined;
      return Math.round((sign * Number(r[field])) / 1e6);
    } });
  }
}

const EMSC = (from, to) => `https://www.seismicportal.eu/fdsnws/event/1/query?start=${from}&end=${to}&minmag=6&format=json&limit=2000`;
const PROPUBLICA = (ein) => `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`;
// Sources whose terms do not allow their data, or verdicts built on it, in a paid product.
const INTERNAL_ONLY = new Set(["propublica"]);
const MAX_PROPUBLICA_PER_PASS = 10;

async function checkEmsc(db, catalog, ctx) {
  const s = catalog.series.find((x) => x.series_id === "usgs:global_quakes_m6_monthly");
  if (!s) return;
  const months = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 2").all(s.series_id);
  const done = kvGet(db, "verified:emsc") || {};
  for (const m of months) {
    if (done[m.t]) continue;
    const d = new Date(Date.parse(`${m.t}T00:00:00Z`));
    const next = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
    const row = { run_id: ctx.runId, field: `series:${s.series_id}`, entity_id: s.entity_id, our_value: { month: m.t, count: m.v },
      upstream_service: "emsc", tolerance_pct: 10, observed_at: at(m.t) };
    const t0 = Date.now();
    try {
      const j = await getJson(ctx, EMSC(m.t, next));
      const n = j.metadata && Number.isFinite(j.metadata.count) ? j.metadata.count : (j.features || []).length;
      const diff = Math.abs(n - m.v);
      const pct = m.v ? (diff / m.v) * 100 : (n ? 100 : 0);
      const agreement = diff <= 1 || pct <= 10 ? "agree" : pct <= 25 ? "partial" : "disagree";
      ctx.rows.push({ ...row, upstream_value: { month: m.t, count: n }, agreement, delta_pct: round4(pct) });
      ctx.calls.push(["emsc", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
    } catch (e) {
      ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" });
      ctx.calls.push(["emsc", { ok: false }]);
      ctx.notes.push(`emsc ${m.t}: ${String(e.message).slice(0, 120)}`);
    }
    done[m.t] = ctx.nowIso;
    kvSet(db, "verified:emsc", done);
  }
}

async function checkPropublica(db, catalog, ctx) {
  const s = catalog.series.find((x) => x.series_id === "irs990:total_revenue");
  if (!s) return;
  const years = kvGet(db, "irs990:years") || {};
  const newest = Object.keys(years).filter((y) => Array.isArray(years[y].sample)).sort().pop();
  if (!newest) return;
  const done = kvGet(db, "verified:propublica") || {};
  let budget = MAX_PROPUBLICA_PER_PASS;
  for (const rec of years[newest].sample) {
    const key = `${rec.ein}:${rec.tax_pd}`;
    if (done[key] || budget-- <= 0) continue;
    const row = { run_id: ctx.runId, field: `record:irs990:${rec.ein}:${rec.tax_pd}`, entity_id: s.entity_id,
      our_value: { ein: rec.ein, tax_pd: rec.tax_pd, totrevenue: rec.totrevenue, processing_year: newest, internal_only: true },
      upstream_service: "propublica", tolerance_pct: 0.5, observed_at: ctx.nowIso };
    const t0 = Date.now();
    try {
      const r = await ctx.fetchImpl(PROPUBLICA(rec.ein), {});
      let filing;
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        filing = (j.filings_with_data || []).find((f) => String(f.tax_prd) === rec.tax_pd);
      } else if (r.status !== 404) throw new Error(`propublica: HTTP ${r.status}`);
      if (!filing || !Number.isFinite(Number(filing.totrevenue))) {
        ctx.rows.push({ ...row, upstream_value: null, agreement: "unavailable" }); // ProPublica has no such filing
        ctx.calls.push(["propublica", { latencyMs: Date.now() - t0 }]);
      } else {
        const theirs = Number(filing.totrevenue);
        const pct = theirs ? (Math.abs(rec.totrevenue - theirs) / Math.abs(theirs)) * 100 : (rec.totrevenue ? 100 : 0);
        const agreement = pct <= 0.5 ? "agree" : "disagree";
        ctx.rows.push({ ...row, upstream_value: { totrevenue: theirs }, agreement, delta_pct: round4(pct) });
        ctx.calls.push(["propublica", { disagreed: agreement === "disagree", latencyMs: Date.now() - t0 }]);
      }
      done[key] = ctx.nowIso;
    } catch (e) {
      ctx.calls.push(["propublica", { ok: false }]);
      ctx.notes.push(`propublica ${rec.ein}: ${String(e.message).slice(0, 120)}`); // not marked: retried next pass
    }
    kvSet(db, "verified:propublica", done);
  }
}

async function verify(db, catalog, { now = new Date(), fetchImpl = null } = {}) {
  const ctx = { now, nowIso: now.toISOString().replace(/\.\d{3}Z$/, "Z"), runId: `pmic/${now.toISOString()}`,
    fetchImpl: fetchImpl || fetchText, rows: [], calls: [], notes: [] };
  await checkPrices(db, catalog, ctx);
  await checkSupplyNodes(db, catalog, ctx);
  checkCrossGroups(db, catalog, ctx);
  checkPairs(db, catalog, ctx);
  await checkKev(db, catalog, ctx);
  await checkPoktLive(db, catalog, ctx);
  await checkTier2(db, catalog, ctx);
  await checkEmsc(db, catalog, ctx);
  await checkPropublica(db, catalog, ctx);
  if (ctx.rows.length || ctx.calls.length) {
    tx(db, () => {
      addConfirmations(db, ctx.rows);
      for (const [service, o] of ctx.calls) recordUpstream(db, service, { ...o, seenAt: ctx.nowIso });
    });
  }
  const by = {};
  for (const r of ctx.rows) by[r.agreement] = (by[r.agreement] || 0) + 1;
  return { rows: ctx.rows.length, by_agreement: by, notes: ctx.notes.slice(0, 5) };
}

module.exports = { verify, CHAINLINK, FALLBACK_RPC, PRICE_TOLERANCE_PCT, INTERNAL_ONLY };
