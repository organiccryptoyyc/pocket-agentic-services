"use strict";
// Synthetic snapshots only. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dossier-test-"));
process.env.DOSSIER_TCS6_DATA_DIR = path.join(ROOT, "tcs6");
process.env.DOSSIER_DATA_DIR = path.join(ROOT, "own");
const store = require("../lib/store");
const D = require("../lib/dossier");
const S = require("../lib/tcs6-scoring");

const AS_OF = "2026-10-25T12:00:00Z";
const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const SAFE1 = A(1), SAFE2 = A(2), GOV = A(3);
const [O1, O2, O3, O4] = [A(5), A(6), A(7), A(8)];

function bundle(over = {}) {
  return {
    entity_id: "demo", collected_at: AS_OF,
    holdings: [
      { asset_id: "eth:usdc", symbol: "USDC", chain: "ethereum", address: SAFE1, asset_class: "fiat_stablecoin", control: "verified", quantity: 1000000,
        holdings_observed_at: AS_OF, prices: [{ source_ref: "CG", usd: 1, observed_at: AS_OF }], haircut_flags: [] },
      { asset_id: "eth:tok", symbol: "TOK", chain: "ethereum", address: SAFE2, asset_class: "native_token", control: "verified", quantity: 500000,
        holdings_observed_at: AS_OF, prices: [{ source_ref: "CG", usd: 2, observed_at: AS_OF }], haircut_flags: ["lockup"], note: "Locked until 2027-01-01." },
      { asset_id: "eth:weth", symbol: "WETH", chain: "ethereum", address: SAFE2, asset_class: "major_crypto", control: "unverified", quantity: 10,
        holdings_observed_at: AS_OF, prices: [{ source_ref: "CG", usd: 3000, observed_at: AS_OF }], haircut_flags: [] },
    ],
    obligations: { items: [{ id: "LOAN", what: "a loan", type: "debt", usd: 250000, source_refs: ["RPC:ethereum"] }] },
    governance: {
      multisig: { threshold: 2, signers: 3 }, timelock: true, has_treasury_policy: true, reconciliation_pct: 96,
      reconciliation: { reported_total_usd: 2100000, reported_as_of: "2026-10-20", observed_usd_same_scope: 2030000, scope_status: "comparable", source_refs: ["OWN"], netted_obligation_items: [], method: "min/max" },
      wallet_controls: [
        { chain: "ethereum", address: SAFE1, role: "treasury_safe", perimeter: "include", control: "safe", threshold: 2, signers: [O1, O2, O3] },
        { chain: "ethereum", address: SAFE2, role: "ops_safe", perimeter: "include", control: "safe", threshold: 2, signers: [O1, O2, O4] },
        { chain: "ethereum", address: GOV, role: "governor", perimeter: "control_only", control: "contract" },
      ],
    },
    gaps: [{ field: "holdings.prices.ethereum:0xabc", reason: "XYZ had no price from any source", impact: "left out", remediation: "next run" }],
    sources: [{ source_ref: "CG", title: "CoinGecko prices", publisher: "CoinGecko", url: "https://www.coingecko.com", raw: "never copied" },
      { source_ref: "OWN", title: "Demo transparency page", publisher: "Demo", url: "https://demo.example" }],
    verification_summary: { fields: [{ field: `control.proxy_slots:ethereum:${SAFE1}`, label: "treasury_safe proxy slots", status: "agree" }] },
    ...over,
  };
}

function report(b, over = {}) {
  return {
    report_id: "tcs6_demo-1", as_of: b.collected_at, entity: { entity_id: "demo", name: "Demo DAO" },
    headline: { gross_adjusted_treasury_usd: 1234567.891, obligations_usd: 250000 },
    overall_score: { score: 55, status: "provisional" },
    attestation: { verification_status: "valid", verification_detail: "signature verified with key tcs6-attest-test", payload: { attestation_id: "att-1", evidence_manifest_hash: "sha256:00", review_required: false, review_items: [] } },
    obligations_policy: { obligations_status: "partial", materiality: "material", materiality_reasons: ["streams not covered"], penalty_policy: "tcs6-obligations/1.0", score_effect_points: -10, disclosed_commitments: [] },
    data_gaps: [{ field: "D5", reason: "no flows", remediation: "curate" }],
    hard_gates: [{ id: "entity_identity", status: "pass", effect: "x" }, { id: "obligations", status: "partial", effect: "y" }],
    capital_perimeter: { known_perimeter_gaps: ["foundation wallets not in scope"] },
    risks: [{ id: "liquidation_risk", description: "loan close to liquidation" }, { id: "governance", description: "low turnout" }],
    dimensions: [{ id: "D2", primary_metrics: [{ name: "tier_0_to_1_hqla_usd", value: 1000000 }, { name: "liquidity_runway_months", value: 12 }] }],
    disclaimer: "Research, not investment advice.",
    ...over,
  };
}

let seq = 0;
function seed(id, b, r) {
  for (const d of ["reports", "evidence"]) fs.mkdirSync(path.join(store.TCS6_DIR, d), { recursive: true });
  fs.writeFileSync(path.join(store.TCS6_DIR, "reports", `${id}.json`), JSON.stringify(r));
  fs.writeFileSync(path.join(store.TCS6_DIR, "evidence", `${id}.json`), JSON.stringify(b));
}
function fresh(over = {}, rover = {}) {
  const id = `demo-${++seq}`;
  const b = bundle(over);
  seed(id, b, report(b, rover));
  return id;
}
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return [e.status, e.code];
  }
  return null;
};

test("plan discloses the call count, the price and the buyer notice before any section", () => {
  const p = D.plan({ entity_id: fresh() });
  assert.match(p.dossier_id, store.DOSSIER_ID_RE);
  assert.strictEqual(p.calls_required, 7);
  assert.strictEqual(p.calls_used, 1);
  assert.strictEqual(p.calls_remaining, 6);
  assert.deepStrictEqual(p.estimate, { price_per_call_usd: 0.005, total_usd: 0.035, remaining_usd: 0.03, basis: "agent.pocket.network flat price per call" });
  assert.match(p.notice, /security/);
  assert.match(p.notice, /7 calls/);
  assert.match(p.notice, /\$0\.035/);
  assert.match(p.notice, /pay only for the calls you make/);
  assert.match(p.notice, /Thank you for understanding/);
  assert.strictEqual(p.sections.length, 6);
  assert.ok(p.sections.every((s) => s.available));
  assert.strictEqual(p.headline.gross_adjusted_treasury_usd, 1234567.89);
  assert.deepStrictEqual(p.attestation_ref, { attestation_id: "att-1", key_id: "tcs6-attest-test", evidence_manifest_hash: "sha256:00", verification_status: "valid" });
});

test("each section call counts, the remainder falls to zero, and a repeat is counted but flagged", () => {
  const p = D.plan({ entity_id: fresh() });
  D.SECTION_NAMES.forEach((name, i) => {
    const s = D.section({ dossier_id: p.dossier_id, section: name });
    assert.strictEqual(s.section, name);
    assert.strictEqual(s.calls_used, i + 2);
    assert.strictEqual(s.calls_remaining, 5 - i);
    assert.strictEqual(s.estimate.remaining_usd, Math.round((5 - i) * 0.005 * 1000) / 1000);
    assert.strictEqual(s.snapshot_report_id, "tcs6_demo-1");
    assert.ok(!s.note);
  });
  const again = D.section({ dossier_id: p.dossier_id, section: "holdings_map" });
  assert.strictEqual(again.calls_used, 8);
  assert.strictEqual(again.calls_remaining, 0);
  assert.match(again.note, /already returned/);
});

test("holdings_map uses TCS-6's own haircuts, counts unverified control at 0, and cites sources without raw payloads", () => {
  const p = D.plan({ entity_id: fresh() });
  const h = D.section({ dossier_id: p.dossier_id, section: "holdings_map" });
  const base = S.computeBase(bundle());
  assert.strictEqual(h.data.totals.positions, 3);
  assert.strictEqual(h.data.totals.value_after_haircut_usd, Math.round(base.grossAdjusted * 100) / 100);
  const weth = h.data.wallets.flatMap((w) => w.positions).find((x) => x.symbol === "WETH");
  assert.strictEqual(weth.control, "unverified");
  assert.strictEqual(weth.value_after_haircut_usd, 0);
  assert.strictEqual(h.data.wallets.find((w) => w.address === SAFE1).role, "treasury_safe");
  assert.deepStrictEqual(h.data.left_out, ["XYZ had no price from any source"]);
  assert.deepStrictEqual(h.data.sources, [{ source_ref: "CG", title: "CoinGecko prices", publisher: "CoinGecko", url: "https://www.coingecko.com" }]);
  assert.ok(!JSON.stringify(h).includes("never copied"));
  assert.strictEqual(h.chart.type, "bar");
  assert.ok(h.chart.series.every((x) => typeof x.label === "string" && typeof x.value === "number"));
});

test("authority_graph lists each wallet's control and the signers shared across Safes", () => {
  const p = D.plan({ entity_id: fresh() });
  const a = D.section({ dossier_id: p.dossier_id, section: "authority_graph" }).data;
  assert.strictEqual(a.wallets.length, 3);
  assert.strictEqual(a.wallets[0].threshold, "2-of-3");
  assert.strictEqual(a.wallets[2].control, "contract");
  assert.deepStrictEqual(a.shared_signers.map((s) => s.signer).sort(), [O1, O2].sort());
  assert.strictEqual(a.summary, "2 signer(s) sit on 2 of 2 Safes.");
  assert.deepStrictEqual(a.proxy_checks, [{ label: "treasury_safe proxy slots", status: "agree" }]);
});

test("obligations, exit liquidity, reconciliation and unresolved items carry the snapshot's own facts", () => {
  const p = D.plan({ entity_id: fresh() });
  const get = (n) => D.section({ dossier_id: p.dossier_id, section: n }).data;
  const o = get("obligations_register");
  assert.strictEqual(o.items[0].id, "LOAN");
  assert.strictEqual(o.visibility.score_effect_points, -10);
  const e = get("exit_liquidity");
  assert.deepStrictEqual(e.restricted_positions.map((x) => x.symbol), ["TOK"]);
  assert.strictEqual(e.tier_0_1_liquid_usd, 1000000);
  assert.deepStrictEqual(e.loan_and_liquidity_risks.map((x) => x.id), ["liquidation_risk"]);
  const r = get("reconciliation");
  assert.strictEqual(r.difference, 70000);
  assert.strictEqual(r.reconciliation_pct, 96);
  assert.strictEqual(r.sources[0].source_ref, "OWN");
  const u = get("unresolved_items");
  assert.deepStrictEqual(u.failed_gates.map((g) => g.id), ["obligations"]);
  assert.deepStrictEqual(u.perimeter_gaps, ["foundation wallets not in scope"]);
});

test("sections the snapshot cannot support are marked unavailable up front and left out of calls_required", () => {
  const g = bundle().governance;
  delete g.wallet_controls;
  delete g.reconciliation;
  const p = D.plan({ entity_id: fresh({ governance: g }) });
  assert.strictEqual(p.calls_required, 5);
  assert.match(p.notice, /5 calls/);
  assert.deepStrictEqual(p.sections.filter((s) => !s.available).map((s) => s.section), ["authority_graph", "reconciliation"]);
  const s = D.section({ dossier_id: p.dossier_id, section: "authority_graph" });
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.data, null);
  assert.ok(s.reason);
});

test("a bundle pushed after the last rescore never mixes with that report: the last matching pair is used", () => {
  const id = fresh();
  store.refreshPairs();
  const newer = bundle({ collected_at: "2026-10-25T20:00:00Z" });
  newer.holdings[0].quantity = 9;
  fs.writeFileSync(path.join(store.TCS6_DIR, "evidence", `${id}.json`), JSON.stringify(newer));
  const p = D.plan({ entity_id: id });
  assert.strictEqual(p.as_of, AS_OF);
  const usdc = D.section({ dossier_id: p.dossier_id, section: "holdings_map" }).data.wallets.flatMap((w) => w.positions).find((x) => x.symbol === "USDC");
  assert.strictEqual(usdc.value_usd, 1000000);
  const unseen = `demo-${++seq}`;
  seed(unseen, newer, report(bundle()));
  assert.deepStrictEqual(code(() => D.plan({ entity_id: unseen })), [400, "unknown_entity"]);
});

test("the pinned snapshot does not change when TCS-6 rescores during the dossier", () => {
  const id = fresh();
  const p = D.plan({ entity_id: id });
  const b2 = bundle({ collected_at: "2026-10-26T00:00:00Z" });
  seed(id, b2, report(b2, { report_id: "tcs6_demo-2" }));
  assert.strictEqual(D.section({ dossier_id: p.dossier_id, section: "reconciliation" }).snapshot_report_id, "tcs6_demo-1");
});

test("bad input and expired dossiers are 400s with a hint, never a 5xx", () => {
  assert.deepStrictEqual(code(() => D.plan({})), [400, "invalid_input"]);
  assert.deepStrictEqual(code(() => D.plan({ entity_id: "../etc" })), [400, "invalid_input"]);
  assert.deepStrictEqual(code(() => D.plan({ entity_id: "nobody" })), [400, "unknown_entity"]);
  const p = D.plan({ entity_id: fresh() });
  assert.deepStrictEqual(code(() => D.section({ dossier_id: p.dossier_id, section: "everything" })), [400, "invalid_input"]);
  assert.deepStrictEqual(code(() => D.section({ dossier_id: "dos_../../x", section: "holdings_map" })), [400, "invalid_input"]);
  assert.deepStrictEqual(code(() => D.section({ dossier_id: "dos_" + "0".repeat(24), section: "holdings_map" })), [400, "unknown_dossier"]);
  const later = Date.parse(p.valid_until) + 1000;
  assert.deepStrictEqual(code(() => D.section({ dossier_id: p.dossier_id, section: "holdings_map" }, later)), [400, "unknown_dossier"]);
});

test("entities lists the covered protocols with the full-dossier notice", () => {
  fresh();
  const e = D.entities();
  assert.ok(e.entities.length >= 1);
  assert.ok(e.entities.every((x) => x.entity_id));
  assert.match(e.note, /7 calls/);
});

const SIBLING = path.join(__dirname, "../../treasury-capital-score/lib/scoring.js");
test("the vendored scoring core is byte-identical to TCS-6's", { skip: !fs.existsSync(SIBLING) }, () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "../lib/tcs6-scoring.js"), "utf8"), fs.readFileSync(SIBLING, "utf8"));
});
