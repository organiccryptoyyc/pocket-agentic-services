// Verified layer 1.5: crypto cross-checks into the confirmations table, against stubs.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbLib = require("../lib/db");
const catalogLib = require("../lib/catalog");
const { collectOnce } = require("../lib/collect");
const { makeFetch } = require("./stub-upstream");

const NOW = new Date("2026-10-06T06:00:00Z");
const catalog = catalogLib.load();
const rows = (db) => db.prepare("SELECT field, entity_id, upstream_service, agreement, delta_pct, upstream_value_hash, our_value FROM confirmations ORDER BY id").all();

async function run({ now = NOW, db = null, env = {}, wrap = (f) => f } = {}) {
  db = db || dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-verify-")) });
  const fetchImpl = wrap(makeFetch(catalog, { now }));
  const summary = await collectOnce(db, catalog, { now, dataDir: os.tmpdir(), env, fetchImpl, sources: ["chainrpc"], force: true });
  return { db, summary };
}

// Rewrite the answer of one host/call so a check can be made to disagree or fail.
const tamper = (match, edit) => (f) => async (url, init, opts) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (match(new URL(url).host, body)) return edit(await f(url, init, opts), body);
  return f(url, init, opts);
};

test("prices agree with Chainlink at the same block; supply agrees across the two RPCs", async () => {
  const { db, summary } = await run();
  assert.ok(summary.verify, "verify ran");
  const r = rows(db);
  const prices = r.filter((x) => x.field.startsWith("series:"));
  assert.deepEqual([...new Set(prices.map((x) => x.field))].sort(), ["series:chainrpc:btc_usd", "series:chainrpc:eth_usd"]);
  assert.ok(prices.every((x) => x.upstream_service === "chainlink" && x.agreement === "agree"), JSON.stringify(prices[0]));
  assert.ok(prices.every((x) => Math.abs(x.delta_pct - 0.1996) < 0.01), "stub Chainlink is 0.2% off");
  assert.ok(prices.length >= 2 && prices.length <= 8, `only the last 3 days, not the 120-day backfill (${prices.length})`);
  assert.ok(prices.every((x) => JSON.parse(x.our_value).block > 0), "our value carries the block that was compared");
  const supply = r.filter((x) => x.field.startsWith("rpc.total_supply:"));
  assert.deepEqual(supply.map((x) => x.field.split(":")[1]).sort(), ["arb-one", "base", "eth", "poly"]);
  assert.ok(supply.every((x) => x.agreement === "agree" && x.upstream_service.endsWith("publicnode.com")));
  assert.ok(r.every((x) => x.agreement === "unavailable" || /^[0-9a-f]{64}$/.test(x.upstream_value_hash)), "only a hash of the other reading");
  const q = Object.fromEntries(db.prepare("SELECT service_id, calls, errors, disagreements FROM upstream_quality").all().map((x) => [x.service_id, x]));
  assert.equal(q.chainlink.calls, prices.length);
});

test("a second pass the same day adds nothing; a new day checks only the new date", async () => {
  const { db } = await run();
  const n = rows(db).length;
  await run({ db });
  assert.equal(rows(db).length, n, "same day: prices already checked, supply already sampled");
  await run({ db, now: new Date(NOW.getTime() + 86400000) });
  const added = rows(db).slice(n);
  assert.equal(added.filter((x) => x.field.startsWith("series:")).length, 2, "one new date for each of ETH and BTC");
  assert.equal(added.filter((x) => x.field.startsWith("rpc.total_supply:")).length, 4, "supply re-sampled on the new day");
});

test("disagreements and failures are recorded, not hidden", async () => {
  const off = (r) => {
    const j = JSON.parse(r.text);
    return { ...r, text: JSON.stringify({ ...j, result: `0x${(BigInt(j.result) + 1n).toString(16)}` }) };
  };
  const { db } = await run({ wrap: (f) => tamper((h, b) => h === "ethereum-rpc.publicnode.com" && b && b.method === "eth_call", off)(
    tamper((h, b) => h === "base-rpc.publicnode.com", () => ({ status: 503, ok: false, text: "" }))(
      tamper((h, b) => b && b.params && b.params[0] && b.params[0].data === "0xfeaf968c", (r) => {
        const j = JSON.parse(r.text);
        const ans = BigInt(`0x${j.result.slice(66, 130)}`) * 105n / 100n; // Chainlink 5% higher
        return { ...r, text: JSON.stringify({ ...j, result: j.result.slice(0, 66) + ans.toString(16).padStart(64, "0") + j.result.slice(130) }) };
      })(f))) });
  const by = Object.fromEntries(rows(db).filter((x) => x.field.startsWith("rpc.")).map((x) => [x.field.split(":")[1], x.agreement]));
  assert.equal(by.eth, "disagree");
  assert.equal(by.base, "unavailable");
  assert.equal(by["arb-one"], "agree");
  assert.ok(rows(db).filter((x) => x.field.startsWith("series:")).every((x) => x.agreement === "disagree" && x.delta_pct > 4));
  const q = Object.fromEntries(db.prepare("SELECT service_id, errors, disagreements FROM upstream_quality").all().map((x) => [x.service_id, x]));
  assert.equal(q["rpc:base-rpc.publicnode.com"].errors, 1);
  assert.equal(q["rpc:ethereum-rpc.publicnode.com"].disagreements, 1);
});

test("verification never changes series or scores, and PMIC_VERIFY=0 turns it off", async () => {
  const snap = (db) => JSON.stringify(db.prepare(`SELECT series_id, as_of, current_value, transformed_value, zscore FROM scores ORDER BY series_id`).all())
    + JSON.stringify(db.prepare("SELECT series_id, observation_time, metric_value FROM observations ORDER BY series_id, observation_time").all());
  const on = await run();
  const off = await run({ env: { PMIC_VERIFY: "0" } });
  assert.equal(off.summary.verify, undefined);
  assert.equal(rows(off.db).length, 0);
  assert.ok(rows(on.db).length > 0);
  assert.equal(snap(on.db), snap(off.db));
});

test("FRED vs BLS cross_check groups are recorded once per observation, with disagreements", async () => {
  const { verify } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-xcheck-")) });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: {}, fetchImpl: makeFetch(catalog, { now: NOW, blsMirrorsFred: true }), sources: ["fred", "bls"], force: true });
  const x = () => rows(db).filter((r) => r.upstream_service === "bls" && r.field !== "series:fred:CPIAUCSL"); // the cross_check groups only
  assert.deepEqual(x().map((r) => r.field).sort(), ["series:fred:JTSJOL", "series:fred:PAYEMS", "series:fred:UNRATE"]);
  assert.ok(x().every((r) => r.agreement === "agree" && r.delta_pct < 0.5), JSON.stringify(x()[0]));
  await verify(db, catalog, { now: NOW, fetchImpl: makeFetch(catalog, { now: NOW }) });
  assert.equal(x().length, 3, "the same observation is not recorded twice");
  // BLS revises the latest payrolls number by 2%: the next check of that observation disagrees
  const last = db.prepare("SELECT MAX(observation_time) t FROM observations WHERE series_id = 'bls:CES0000000001'").get().t;
  db.prepare("UPDATE observations SET metric_value = metric_value * 1.02 WHERE series_id = 'bls:CES0000000001' AND observation_time = ?").run(last);
  db.prepare("DELETE FROM kv WHERE k = 'verified:xcheck:us_payrolls:bls:CES0000000001'").run();
  await verify(db, catalog, { now: NOW, fetchImpl: makeFetch(catalog, { now: NOW }) });
  const pay = x().filter((r) => r.field === "series:fred:PAYEMS");
  assert.equal(pay.length, 2);
  assert.equal(pay[1].agreement, "disagree");
  assert.ok(Math.abs(pay[1].delta_pct - 1.9608) < 0.001, String(pay[1].delta_pct));
  const q = db.prepare("SELECT calls, disagreements FROM upstream_quality WHERE service_id = 'bls'").get();
  const all = rows(db).filter((r) => r.upstream_service === "bls"); // includes the Tier 1 CPI pair
  assert.deepEqual({ ...q }, { calls: all.length, disagreements: all.filter((r) => r.agreement === "disagree").length });
});

test("Tier 1: CPI and GDP pairs, World Bank vs IMF, CISA vs NVD, Pocket indexer vs chain", async () => {
  const { verify } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-tier1-")) });
  const base = makeFetch(catalog, { now: NOW, blsMirrorsFred: true });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: { BEA_API_KEY: "test", PMIC_VERIFY: "0" }, fetchImpl: base,
    sources: ["fred", "bls", "bea", "worldbank", "imf", "cisa", "pokt"], force: true });
  const latest = (id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 2").all(id);
  const set = (id, t, v) => db.prepare("UPDATE observations SET metric_value = ? WHERE series_id = ? AND observation_time = ?").run(v, id, t);
  // CPI: BLS equal to FRED -> agree
  const cpi = latest("fred:CPIAUCSL")[0];
  set("bls:CUSR0000SA0", cpi.t, cpi.v);
  // GDP: BEA's rate 0.1 point off FRED's annualized rate -> agree (0.15 tolerance)
  const [g0, g1] = latest("fred:GDPC1");
  const rate = (Math.pow(g0.v / g1.v, 4) - 1) * 100;
  set("bea:NIPA:T10101:1", g0.t, Math.round((rate + 0.1) * 10) / 10);
  // World Bank vs IMF, latest common year before 2026: GDP 0.5 off -> partial, unemployment 0.1 off -> agree
  const wbG = latest("worldbank:us:NY.GDP.MKTP.KD.ZG")[0];
  set("imf:us:NGDP_RPCH", wbG.t, wbG.v + 0.5);
  const wbU = latest("worldbank:us:SL.UEM.TOTL.ZS")[0];
  set("imf:us:LUR", wbU.t, wbU.v + 0.1);
  const kev = latest("cisa:kev_added_weekly");
  const fetchImpl = async (url, init, opts) => {
    const u = new URL(url);
    if (u.host === "services.nvd.nist.gov" && u.searchParams.has("kevStartDate")) {
      const wk = u.searchParams.get("kevStartDate").slice(0, 10);
      const stored = db.prepare("SELECT metric_value v FROM observations WHERE series_id = 'cisa:kev_added_weekly' AND observation_time = ?").get(wk);
      return { status: 200, ok: true, text: JSON.stringify({ totalResults: stored ? stored.v : 0 }) };
    }
    if (u.host === "data.pocket.network" && init && init.body && init.body.includes("first: 1")) {
      return { status: 200, ok: true, text: JSON.stringify({ data: { blocks: { nodes: [{ id: "962403", stakedSuppliers: 4545, stakedApps: 264, stakedGateways: 8, stakedValidators: 21 }] } } }) };
    }
    if (u.host === "sauron-api.infra.pocket.network") {
      const total = u.pathname.endsWith("/supplier") ? 4579 : u.pathname.endsWith("/application") ? 264 : u.pathname.endsWith("/gateway") ? 8 : 25;
      return { status: 200, ok: true, text: JSON.stringify({ pagination: { total: String(total) } }) };
    }
    return base(url, init, opts);
  };
  await verify(db, catalog, { now: NOW, fetchImpl });
  const by = (field, svc) => rows(db).filter((r) => r.field === field && r.upstream_service === svc).map((r) => r.agreement);
  assert.deepEqual(by("series:fred:CPIAUCSL", "bls"), ["agree"]);
  assert.deepEqual(by("series:fred:GDPC1", "bea"), ["agree"]);
  assert.deepEqual(by("series:worldbank:us:NY.GDP.MKTP.KD.ZG", "imf"), ["partial"]);
  assert.deepEqual(by("series:worldbank:us:SL.UEM.TOTL.ZS", "imf"), ["agree"]);
  assert.equal(by("series:cisa:kev_added_weekly", "nvd").length, 2, "the 2 complete weeks before the newest");
  assert.ok(kev.length === 2);
  assert.ok(by("series:cisa:kev_added_weekly", "nvd").every((a) => a === "agree"));
  assert.deepEqual(by("pokt.live:staked_suppliers", "pokt-lcd"), ["partial"]);
  assert.deepEqual(by("pokt.live:staked_apps", "pokt-lcd"), ["agree"]);
  assert.deepEqual(by("pokt.live:gateways", "pokt-lcd"), ["agree"]);
  assert.deepEqual(by("pokt.live:validators", "pokt-lcd"), ["disagree"]);
  // a second pass the same day adds nothing
  const n = rows(db).length;
  await verify(db, catalog, { now: NOW, fetchImpl });
  assert.equal(rows(db).length, n);
});

test("Tier 2: Treasury yields, NY Fed EFFR, FRED copies of BLS/ECB, Treasury MTS (sign flip), once per observation", async () => {
  const { verify } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-tier2-")) });
  const base = makeFetch(catalog, { now: NOW, blsMirrorsFred: true });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: { PMIC_VERIFY: "0" }, fetchImpl: base, sources: ["fred", "bls", "ecb"], force: true });
  const latest = (id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1").get(id);
  const L = Object.fromEntries(["fred:DGS10", "fred:DGS2", "fred:DFF", "bls:CES0500000003", "bls:WPUFD4", "ecb:FM.B.U2.EUR.4F.KR.DFR.LEV",
    "fred:MTSR133FMS", "fred:MTSO133FMS", "fred:MTSDS133FMS"].map((id) => [id, latest(id)]));
  for (const [id, o] of Object.entries(L)) assert.ok(o, `stub has ${id}`);
  const us = (t) => `${t.slice(5, 7)}/${t.slice(8, 10)}/${t.slice(0, 4)}`;
  const fetchImpl = async (url, init, opts) => {
    const u = new URL(url);
    if (u.host === "home.treasury.gov") { // 10y matches, 2y is 3 bp off
      return { status: 200, ok: true, text: `Date,"2 Yr","10 Yr"\n${us(L["fred:DGS10"].t)},${(L["fred:DGS2"].v + 0.03).toFixed(2)},${L["fred:DGS10"].v.toFixed(2)}\n` };
    }
    if (u.host === "markets.newyorkfed.org") {
      return { status: 200, ok: true, text: JSON.stringify({ refRates: [{ effectiveDate: L["fred:DFF"].t, percentRate: L["fred:DFF"].v }] }) };
    }
    if (u.host === "fred.stlouisfed.org" && u.pathname.endsWith("fredgraph.csv") && ["CES0500000003", "PPIFID", "ECBDFR"].includes(u.searchParams.get("id"))) {
      const id = u.searchParams.get("id");
      const ours = { CES0500000003: L["bls:CES0500000003"], PPIFID: L["bls:WPUFD4"], ECBDFR: L["ecb:FM.B.U2.EUR.4F.KR.DFR.LEV"] }[id];
      return { status: 200, ok: true, text: `observation_date,${id}\n${ours.t},${ours.v}\n` };
    }
    if (u.host === "api.fiscaldata.treasury.gov") {
      const m = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][new Date(`${L["fred:MTSR133FMS"].t}T00:00:00Z`).getUTCMonth()];
      // the same month twice: last fiscal year's (line 12, different numbers) and this year's (line 26)
      return { status: 200, ok: true, text: JSON.stringify({ data: [
        { classification_desc: m, src_line_nbr: "12", current_month_gross_rcpt_amt: "1", current_month_gross_outly_amt: "1", current_month_dfct_sur_amt: "1" },
        { classification_desc: m, src_line_nbr: "26", current_month_gross_rcpt_amt: String(L["fred:MTSR133FMS"].v * 1e6), current_month_gross_outly_amt: String(L["fred:MTSO133FMS"].v * 1e6),
          current_month_dfct_sur_amt: String(-L["fred:MTSDS133FMS"].v * 1e6) }] }) };
    }
    return base(url, init, opts);
  };
  await verify(db, catalog, { now: NOW, fetchImpl });
  const v = (id, svc) => rows(db).filter((r) => r.field === `series:${id}` && r.upstream_service === svc).map((r) => r.agreement);
  assert.deepEqual(v("fred:DGS10", "treasury"), ["agree"]);
  assert.deepEqual(v("fred:DGS2", "treasury"), ["disagree"]);
  assert.deepEqual(v("fred:DFF", "nyfed"), ["agree"]);
  assert.deepEqual(v("bls:CES0500000003", "fred"), ["agree"]);
  assert.deepEqual(v("bls:WPUFD4", "fred"), ["agree"]);
  assert.deepEqual(v("ecb:FM.B.U2.EUR.4F.KR.DFR.LEV", "fred"), ["agree"]);
  assert.deepEqual(["fred:MTSR133FMS", "fred:MTSO133FMS", "fred:MTSDS133FMS"].map((id) => v(id, "fiscaldata")[0]), ["agree", "agree", "agree"], "deficit sign flipped");
  const n = rows(db).length;
  await verify(db, catalog, { now: NOW, fetchImpl });
  assert.equal(rows(db).length, n, "each observation once");
});

test("Tier 3: IRS 990 sample of the largest filers, EMSC vs USGS, ProPublica record checks (internal only)", async () => {
  const { verify, INTERNAL_ONLY } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-tier3-")) });
  const base = makeFetch(catalog, { now: NOW });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: { PMIC_VERIFY: "0" }, fetchImpl: base, sources: ["irs990", "usgs"], force: true });
  const years = dbLib.kvGet(db, "irs990:years");
  const newest = Object.keys(years).sort().pop();
  const sample = years[newest].sample;
  assert.equal(sample.length, 10);
  assert.ok(sample.every((r, i) => i === 0 || r.totrevenue <= sample[i - 1].totrevenue), "largest first");
  const usgs = db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = 'usgs:global_quakes_m6_monthly' ORDER BY observation_time DESC LIMIT 2").all();
  let ppDown = true;
  const fetchImpl = async (url, init, opts) => {
    const u = new URL(url);
    if (u.host === "www.seismicportal.eu") { // newest month within one quake; the month before 30% off
      const m = usgs.find((x) => x.t === u.searchParams.get("start"));
      const n = m === usgs[0] ? m.v + 1 : Math.round(m.v * 1.3) + 2;
      return { status: 200, ok: true, text: JSON.stringify({ metadata: { count: n }, features: [] }) };
    }
    if (u.host === "projects.propublica.org") {
      if (ppDown) return { status: 503, ok: false, text: "" };
      const ein = u.pathname.split("/").pop().replace(".json", "");
      const rec = sample.find((r) => r.ein === ein);
      if (rec === sample[9]) return { status: 404, ok: false, text: "{}" };
      const rev = rec === sample[8] ? rec.totrevenue * 1.1 : rec.totrevenue;
      return { status: 200, ok: true, text: JSON.stringify({ filings_with_data: [{ tax_prd: Number(rec.tax_pd), totrevenue: rev }] }) };
    }
    return base(url, init, opts);
  };
  await verify(db, catalog, { now: NOW, fetchImpl });
  const r = rows(db);
  assert.deepEqual(r.filter((x) => x.upstream_service === "emsc").map((x) => x.agreement), ["agree", "disagree"]);
  assert.equal(r.filter((x) => x.upstream_service === "propublica").length, 0, "ProPublica down: nothing recorded, retried next pass");
  ppDown = false;
  await verify(db, catalog, { now: NOW, fetchImpl });
  const pp = rows(db).filter((x) => x.upstream_service === "propublica");
  assert.equal(pp.length, 10);
  assert.deepEqual(pp.map((x) => x.agreement).sort(), [...Array(8).fill("agree"), "disagree", "unavailable"].sort());
  assert.ok(pp.every((x) => JSON.parse(x.our_value).internal_only === true));
  assert.ok(INTERNAL_ONLY.has("propublica"));
  await verify(db, catalog, { now: NOW, fetchImpl });
  assert.equal(rows(db).filter((x) => x.upstream_service === "propublica").length, 10, "each filing once");
});

test("keyed checks: EIA prices and GovInfo counts; skipped without keys; keys never stored", async () => {
  const { verify } = require("../lib/verify");
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-keyed-")) });
  const base = makeFetch(catalog, { now: NOW });
  await collectOnce(db, catalog, { now: NOW, dataDir: os.tmpdir(), env: { PMIC_VERIFY: "0", CONGRESS_API_KEY: "k" }, fetchImpl: base, sources: ["fred", "fedreg", "congress"], force: true });
  const latest = (id) => db.prepare("SELECT observation_time t, metric_value v FROM observations WHERE series_id = ? ORDER BY observation_time DESC LIMIT 1").get(id);
  const L = Object.fromEntries(["fred:DCOILWTICO", "fred:DHHNGSP", "fedreg:final_rules_monthly", "fedreg:proposed_rules_monthly", "congress:laws_enacted_monthly"].map((id) => [id, latest(id)]));
  for (const [id, o] of Object.entries(L)) assert.ok(o, `stub has ${id}`);
  const KEY = "TESTKEY0123456789abcdef0123456789abcdef";
  const seen = [];
  const fetchImpl = async (url, init, opts) => {
    const u = new URL(url);
    if (u.host === "api.eia.gov" || u.host === "api.govinfo.gov") {
      assert.equal(u.searchParams.get("api_key"), KEY, "key sent as api_key");
      seen.push(u.pathname);
    }
    if (u.host === "api.eia.gov") {
      const id = u.searchParams.get("facets[series][]") === "RWTC" ? "fred:DCOILWTICO" : "fred:DHHNGSP";
      const v = id === "fred:DCOILWTICO" ? L[id].v : L[id].v + 0.05; // Henry Hub 5 cents off
      return { status: 200, ok: true, text: JSON.stringify({ response: { data: [{ period: u.searchParams.get("start"), value: v }] } }) };
    }
    if (u.host === "api.govinfo.gov") {
      if (u.pathname.startsWith("/published/")) {
        const [, , start, end] = u.pathname.split("/");
        assert.ok(start.endsWith("-01") && end.endsWith("-01") && end > start, `month runs to the 1st of the next (end exclusive): ${start}..${end}`);
      }
      if (u.pathname.startsWith("/published/") && u.searchParams.get("collection") === "FR") {
        return { status: 200, ok: true, text: JSON.stringify({ packages: [{ packageId: "FR-A" }, { packageId: "FR-B" }], nextPage: null }) };
      }
      if (u.pathname.endsWith("/granules")) { // split the month's counts over two issues
        const half = (n, first) => (first ? Math.ceil(n / 2) : Math.floor(n / 2));
        const first = u.pathname.includes("FR-A");
        const g = [];
        for (let i = 0; i < half(L["fedreg:final_rules_monthly"].v, first); i++) g.push({ granuleClass: "RULE" });
        for (let i = 0; i < half(Math.round(L["fedreg:proposed_rules_monthly"].v * 1.3), first); i++) g.push({ granuleClass: "PRORULE" });
        g.push({ granuleClass: "NOTICE" });
        return { status: 200, ok: true, text: JSON.stringify({ granules: g, nextPage: null }) };
      }
      if (u.searchParams.get("collection") === "PLAW") {
        return { status: 200, ok: true, text: JSON.stringify({ packages: Array.from({ length: L["congress:laws_enacted_monthly"].v }, (_, i) => ({ packageId: `PLAW-119publ${i}` })), nextPage: null }) };
      }
      if (u.searchParams.get("collection") === "BILLS") return { status: 200, ok: true, text: JSON.stringify({ packages: [], nextPage: null }) };
    }
    return base(url, init, opts);
  };
  await verify(db, catalog, { now: NOW, fetchImpl, env: {} });
  assert.equal(seen.length, 0, "no keys: EIA and GovInfo are not called");
  await verify(db, catalog, { now: NOW, fetchImpl, env: { EIA_API_KEY: KEY, GOVINFO_API_KEY: KEY } });
  const v = (id, svc) => rows(db).filter((r) => r.field === `series:${id}` && r.upstream_service === svc).map((r) => r.agreement);
  assert.deepEqual(v("fred:DCOILWTICO", "eia"), ["agree"]);
  assert.deepEqual(v("fred:DHHNGSP", "eia"), ["disagree"]);
  assert.deepEqual(v("fedreg:final_rules_monthly", "govinfo"), ["agree"]);
  assert.deepEqual(v("fedreg:proposed_rules_monthly", "govinfo"), ["disagree"], "30% off is beyond the 10% partial band");
  assert.deepEqual(v("congress:laws_enacted_monthly", "govinfo"), ["agree"]);
  const everything = JSON.stringify(db.prepare("SELECT * FROM confirmations").all()) + JSON.stringify(db.prepare("SELECT * FROM kv").all())
    + JSON.stringify(db.prepare("SELECT * FROM upstream_quality").all());
  assert.ok(!everything.includes(KEY), "the key is never stored");
});

test("FluView: NSSP flu ED share vs ILINet wILI, week-over-week direction, once per week (D19)", async () => {
  const { verify, epiweekOf } = require("../lib/verify");
  assert.equal(epiweekOf("2026-10-10"), 202640);
  assert.equal(epiweekOf("2026-01-03"), 202553, "a Saturday in the last MMWR week of the prior year");
  assert.equal(epiweekOf("2027-01-09"), 202701);
  const db = dbLib.open({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pmic-fluview-")) });
  const ins = db.prepare("INSERT INTO observations (source_id, series_id, entity_id, metric_name, metric_value, unit, observation_time, fetch_time, source_url, transform_version, retention_class, confidence_score, updated_at) VALUES ('cdc','cdc:ed_flu_weekly','us-respiratory','ed_visits_influenza_pct',?,'percent',?,'2026-10-11T00:00:00Z','https://www.cdc.gov','1','standard',0.9,'2026-10-11T00:00:00Z')");
  ins.run(0.30, "2026-10-03");
  ins.run(0.36, "2026-10-10");
  let wili = { 202639: 1.85, 202640: 2.07 };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /api\.delphi\.cmu\.edu\/epidata\/fluview\/\?regions=nat&epiweeks=202639-202640/);
    return { status: 200, text: JSON.stringify({ result: 1, epidata: Object.entries(wili).map(([w, v]) => ({ epiweek: Number(w), wili: v })) }) };
  };
  const now = new Date("2026-10-17T06:00:00Z");
  await verify(db, catalog, { now, fetchImpl });
  let r = rows(db).filter((x) => x.upstream_service === "fluview");
  assert.equal(r.length, 1);
  assert.equal(r[0].agreement, "agree", "both rose");
  await verify(db, catalog, { now, fetchImpl });
  assert.equal(rows(db).filter((x) => x.upstream_service === "fluview").length, 1, "same week only once");
  ins.run(0.30, "2026-10-17");
  wili = { 202640: 2.07, 202641: 2.4 };
  const fetch2 = async (url) => ({ status: 200, text: JSON.stringify({ result: 1, epidata: Object.entries(wili).map(([w, v]) => ({ epiweek: Number(w), wili: v })) }) });
  await verify(db, catalog, { now, fetchImpl: fetch2 });
  r = rows(db).filter((x) => x.upstream_service === "fluview");
  assert.equal(r[1].agreement, "disagree", "NSSP fell while ILINet rose");
  assert.ok(calls >= 1);
});
