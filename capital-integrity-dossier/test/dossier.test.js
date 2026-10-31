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
    obligations_policy: { policy_id: "tcs6-obligations/1.0", obligations_status: "partial", materiality: "material", materiality_reasons: ["streams not covered"], penalty_policy: "10 points once (gap material)", score_effect_points: 0, disclosed_commitments: [] },
    data_gaps: [{ field: "D5", reason: "no flows", remediation: "curate" }],
    hard_gates: [{ id: "entity_identity", status: "pass", effect: "x" }, { id: "obligation_visibility", status: "fail", effect: "Obligations partially visible; provisional score only, 10 points deducted because the gap is material. Under tcs6-obligations/1.0: streams not covered (material)." }],
    capital_perimeter: { known_perimeter_gaps: ["foundation wallets not in scope"] },
    risks: [{ id: "liquidation_risk", description: "loan close to liquidation" }, { id: "governance", description: "low turnout" }],
    dimensions: [{ id: "D1", weight_pct: 50, score: 80, primary_metrics: [] }, { id: "D2", weight_pct: 50, score: 50, primary_metrics: [{ name: "tier_0_to_1_hqla_usd", value: 1000000 }, { name: "liquidity_runway_months", value: 12 }] },
      { id: "D5", weight_pct: 15, score: null, primary_metrics: [] }],
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
  assert.strictEqual(o.visibility.points_deducted_from_score, 10);
  assert.strictEqual(o.visibility.change_vs_previous_rule_points, 0);
  assert.match(o.visibility.change_vs_previous_rule_note, /not the deduction itself/);
  assert.deepStrictEqual({ w: o.score_walk.weighted_dimension_score, d: o.score_walk.points_deducted, f: o.score_walk.final_score, ok: o.score_walk.reconciles }, { w: 65, d: 10, f: 55, ok: true });
  const e = get("exit_liquidity");
  assert.deepStrictEqual(e.restricted_positions.map((x) => x.symbol), ["TOK"]);
  assert.strictEqual(e.tier_0_1_liquid_usd, 1000000);
  assert.deepStrictEqual(e.loan_and_liquidity_risks.map((x) => x.id), ["liquidation_risk"]);
  const r = get("reconciliation");
  assert.strictEqual(r.difference, 70000);
  assert.strictEqual(r.reconciliation_pct, 96);
  assert.strictEqual(r.sources[0].source_ref, "OWN");
  const u = get("unresolved_items");
  assert.deepStrictEqual(u.failed_gates.map((g) => g.id), ["obligation_visibility"]);
  assert.deepStrictEqual(u.perimeter_gaps, ["foundation wallets not in scope"]);
});

test("exit_liquidity shows the collector's signed exit checks: measured share, shortfall, block, and gaps kept as gaps", () => {
  const TOK = A(9);
  const chk = (holder, status, usd, ratio, observed = AS_OF) => ({
    field: `exit.available:ethereum:${TOK}:${holder}`, label: "aEthUSDC at treasury_safe", kind: "realizability_control", source: "sim:aave",
    chain_id: 1, block_number: 100, block_hash: "0xabc", observed_at: observed, status, our_value: { qty: usd, usd },
    measure: ratio === null ? null : { exitable_ratio: ratio }, evidence_hash: status === "unavailable" ? null : "sha256:11",
  });
  const checks = [chk(SAFE1, "passed", 200000, 1), chk(SAFE2, "failed", 400000, 0.25), chk(A(4), "unavailable", 300000, null, "2026-10-22T12:00:00Z"),
    { field: `control.proxy_slots:ethereum:${SAFE1}`, status: "passed" }];
  const p = D.plan({ entity_id: fresh({ attestation: { payload: { checks } } }) });
  const s = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" });
  const e = s.data.exit_checks;
  assert.deepStrictEqual(e.summary, { checked: 3, passed: 1, failed: 1, unavailable: 1, not_rechecked: 0, simulated: 0, simulation_failed: 0, value_checked_usd: 900000, exitable_now_usd: 300000, shortfall_usd: 300000, not_measured_usd: 300000, older_than_24h: 1 });
  assert.deepStrictEqual(e.positions.map((x) => [x.status, x.exitable_now_usd]), [["failed", 100000], ["unavailable", null], ["passed", 200000]]);
  assert.strictEqual(e.positions[0].result, "25% could be withdrawn now");
  assert.strictEqual(e.positions[0].holder_role, "ops_safe");
  assert.strictEqual(e.positions[1].observed_hours_before_snapshot, 72);
  assert.match(e.positions[1].result, /data gap/);
  assert.strictEqual(e.positions[2].block_number, 100);
  assert.deepStrictEqual(s.chart.series.map((x) => x.value), [300000, 300000, 300000]);
  const none = D.section({ dossier_id: D.plan({ entity_id: fresh() }).dossier_id, section: "exit_liquidity" });
  assert.strictEqual(none.data.exit_checks.summary.checked, 0);
  assert.ok(!none.chart);
});

test("v2: each exit position carries its withdrawal simulation; a position not re-checked says why, never shows an old result", () => {
  const TOK = A(9);
  const f = (kind, holder) => `exit.${kind}:ethereum:${TOK}:${holder}`;
  const checks = [
    { field: f("available", SAFE1), label: "v at treasury_safe", source: "sim:erc4626", status: "passed", observed_at: AS_OF, our_value: { usd: 500000 }, measure: { exitable_ratio: 1 } },
    { field: f("simulated", SAFE1), source: "sim:erc4626:eth_call", status: "failed", observed_at: AS_OF, block_number: 7, block_hash: "0x07",
      measure: { recoverable_ratio: null, method: "redeem(uint256,address,address)", tested_amount: "full position", revert_reason: "reverted: vault paused" }, evidence_hash: "sha256:22" },
    { field: f("available", SAFE2), label: "v at ops_safe", source: "sim:erc4626", status: "not_applicable", observed_at: AS_OF, our_value: null,
      measure: { reason: "not re-checked this run: the position is worth less than $100,000 this run ($2,000)" } },
  ];
  const p = D.plan({ entity_id: fresh({ attestation: { payload: { checks } } }) });
  const e = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" }).data.exit_checks;
  const a = e.positions.find((x) => x.holder === SAFE1);
  assert.deepStrictEqual([a.status, a.withdrawal_simulation.status, a.withdrawal_simulation.revert_reason, a.withdrawal_simulation.block_number],
    ["passed", "failed", "reverted: vault paused", 7]);
  assert.match(a.withdrawal_simulation.result, /^a withdrawal of the full position reverts: reverted: vault paused \(smaller amounts not tested/);
  const n = e.positions.find((x) => x.holder === SAFE2);
  assert.deepStrictEqual([n.status, n.exitable_ratio, n.withdrawal_simulation], ["not_applicable", null, null]);
  assert.match(n.result, /not re-checked this run: the position is worth less than \$100,000/);
  assert.deepStrictEqual([e.summary.not_rechecked, e.summary.simulated, e.summary.simulation_failed], [1, 1, 1]);
});

test("v2: a revert reads in plain English, keeps the raw reason, and names the loan a position backs", () => {
  const TOK = A(9);
  const loan = [{ obligation_id: "DAO-GHO-DEBT", what: "Safe GHO borrow", usd: 6470000 }];
  const checks = [
    { field: `exit.available:ethereum:${TOK}:${SAFE1}`, label: "aWETH at treasury_safe", source: "sim:aave", status: "passed", observed_at: AS_OF, our_value: { usd: 23000000 }, measure: { exitable_ratio: 1 } },
    { field: `exit.simulated:ethereum:${TOK}:${SAFE1}`, source: "sim:aave:eth_call", status: "failed", observed_at: AS_OF, block_number: 7, block_hash: "0x07",
      measure: { recoverable_ratio: null, method: "withdraw(address,uint256,address)", tested_amount: "full position",
        revert_reason: "HealthFactorLowerThanLiquidationThreshold(): the position backs a loan, so withdrawing it all would breach the loan's health factor",
        cause: "backs_a_loan", backs_loans: loan,
        explanation: "the position is collateral for a loan (Safe GHO borrow, $6,470,000; already counted as an obligation), so withdrawing all of it would breach the loan's health factor" } },
  ];
  const p = D.plan({ entity_id: fresh({ attestation: { payload: { checks } } }) });
  const s = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" }).data.exit_checks.positions[0].withdrawal_simulation;
  assert.match(s.result, /^a withdrawal of the full position reverts: the position is collateral for a loan \(Safe GHO borrow, \$6,470,000; already counted/);
  assert.deepStrictEqual([s.cause, s.backs_loans], ["backs_a_loan", loan]);
  assert.match(s.revert_reason, /^HealthFactorLowerThanLiquidationThreshold/);
});

test("v2: a classification conflict is shown as four separate layers and listed for review", () => {
  const conflict = { kind: "classification_conflict", subject: "yRECOVERY at 0xbb", asset_id: "ethereum:0xaa:0xbb", materiality: "material",
    failed_check_id: "realizability_control|exit.available:ethereum:0xaa:0xbb|sim:erc4626", check_ids: ["realizability_control|exit.available:ethereum:0xaa:0xbb|sim:erc4626"],
    gross_observed_value_usd: 3800000, verified_treasury_value_usd: 0, liquid_value_usd: 0, onchain_withdrawal_check: "passed",
    curated_classification: ["redemption_limits", "pending_classification"], classification_status: "conflicted", score_treatment: "conservative_exclusion",
    review_required: true, resolution_event: "the decision named in the curated note: pending YIP-90", score_effect: "provisional; ...", statement: "The yRECOVERY position ..." };
  const p = D.plan({ entity_id: fresh({}, { attestation: { verification_status: "valid", verification_detail: "signature verified with key k", payload: {},
    materiality: { policy_id: "tcs6-materiality/1.1", effect: "provisional", review_required: true, assessments: [conflict] } } }) });
  const c = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" }).data.classification_conflicts[0];
  assert.deepStrictEqual(Object.keys(c.layers), ["onchain_observability", "technical_withdrawal", "economic_liquidity", "governance_classification"]);
  assert.strictEqual(c.layers.onchain_observability.observed_value_usd, 3800000);
  assert.strictEqual(c.layers.technical_withdrawal.check, "passed");
  assert.strictEqual(c.layers.economic_liquidity.status, "not_measured");
  assert.match(c.layers.governance_classification.resolution_event, /YIP-90/);
  assert.deepStrictEqual([c.score_treatment, c.verified_treasury_value_usd, c.liquid_value_usd, c.review_required], ["conservative_exclusion", 0, 0, true]);
  const u = D.section({ dossier_id: p.dossier_id, section: "unresolved_items" }).data;
  assert.strictEqual(u.classification_conflicts[0].subject, "yRECOVERY at 0xbb");
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

test("1.3: each divergence shows how it changed the score: available value, the encumbered rest, the loan read, review", () => {
  const TOK = A(9);
  const health = { debt_usd: 4478943, liquidation_threshold: 0.83, encumbered_usd: 5396317, block_number: 7 };
  const checks = [
    { field: `exit.available:ethereum:${TOK}:${SAFE1}`, label: "aWETH at treasury_safe", source: "sim:aave", status: "passed", observed_at: AS_OF, our_value: { usd: 23000000 }, measure: { exitable_ratio: 1 } },
    { field: `exit.simulated:ethereum:${TOK}:${SAFE1}`, source: "sim:aave:eth_call", status: "failed", observed_at: AS_OF, block_number: 7, block_hash: "0x07",
      measure: { recoverable_ratio: null, method: "withdraw(address,uint256,address)", revert_reason: "HealthFactorLowerThanLiquidationThreshold()", cause: "backs_a_loan", loan_health: health } },
  ];
  const div = { kind: "realizability_control", subject: `aWETH at ${SAFE1}`, asset_id: `ethereum:${TOK}:${SAFE1}`, failed_check_id: "c1", check_ids: ["c1"], failure_reason: "backs_a_loan",
    materiality: "material", treatment: "evidence_based_discount", position_value_usd: 23000000, gross_observed_value_usd: 23000000, available_value_usd: 17603683,
    unavailable_value_usd: 5396317, unavailable_as: "encumbered", loan_health: health, evidence_hashes: ["sha256:x"], large_divergence: true, review_required: true,
    score_effect: "provisional; ...", statement: "The aWETH position ..." };
  const p = D.plan({ entity_id: fresh({ attestation: { payload: { checks } } }, { attestation: { verification_status: "valid", verification_detail: "ok", payload: {},
    materiality: { policy_id: "tcs6-materiality/1.2", effect: "provisional", review_required: true, assessments: [div] } } }) });
  const ex = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" }).data;
  const pos = ex.exit_checks.positions[0];
  assert.deepStrictEqual(pos.score_treatment, { treatment: "evidence_based_discount", available_value_usd: 17603683, unavailable_value_usd: 5396317, unavailable_as: "encumbered", large_divergence: true });
  assert.deepStrictEqual(pos.withdrawal_simulation.loan_health, health);
  assert.deepStrictEqual([ex.divergences.length, ex.divergences[0].evidence_hashes], [1, ["sha256:x"]]);
  const u = D.section({ dossier_id: p.dossier_id, section: "unresolved_items" }).data;
  assert.strictEqual(u.score_review_required, true);
  assert.deepStrictEqual(u.divergences.map((d) => [d.cause, d.treatment, d.large_divergence]), [["backs_a_loan", "evidence_based_discount", true]]);
});

test("1.4: authority_graph shows wallet exit; exit_liquidity shows on-chain sale depth and LP exits (evidence only)", () => {
  const TOK = A(9);
  const checks = [{ field: `exit.market:ethereum:${TOK}:${SAFE1}`, label: "UNI at treasury_safe", source: "quote:onchain", status: "passed", observed_at: AS_OF,
    our_value: { usd: 10000000 }, block_number: 7, evidence_hash: "sha256:m",
    measure: { reference_usd_per_token: 10, tranches: [{ share: 0.01, proceeds_usd: 99800, price_impact_pct: 0.2, venue: "uniswap_v3:3000:WETH" }, { share: 1, proceeds_usd: 8333333, price_impact_pct: 16.67, venue: "uniswap_v3:3000:WETH" }] } }];
  const wx = { policy_id: "tcs6-wallet-exit/1.0", one_hour_exit_usd: 24000000, one_hour_exit_share: 0.2, d6_cap: 75, direct_usd: 20000000, borrow_usd: 4000000,
    freezable_usd: 10000000, protected_usd: 0, treasury_value_usd: 120000000, unknown_control_wallets: 0, borrow_caps: [], wallets: [{ address: SAFE1, protected: false }],
    statement: "If the signing control of the exposed wallets were compromised, about $24,000,000 ..." };
  const p = D.plan({ entity_id: fresh({ attestation: { payload: { checks } } }, { wallet_exit: wx }) });
  const ag = D.section({ dossier_id: p.dossier_id, section: "authority_graph" }).data.wallet_exit;
  assert.deepStrictEqual([ag.one_hour_exit_usd, ag.d6_cap, ag.borrow_usd], [24000000, 75, 4000000]);
  assert.match(ag.method, /KelpDAO \(April 2026\), Binance \(October 2026\)/);
  const el = D.section({ dossier_id: p.dossier_id, section: "exit_liquidity" }).data.economic_liquidity;
  assert.strictEqual(el.sales[0].tranches[1].price_impact_pct, 16.67);
  assert.match(el.scope, /on-chain markets only/);
});
