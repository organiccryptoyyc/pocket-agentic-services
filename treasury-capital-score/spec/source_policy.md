# TCS-6 source and citation policy

Owner decisions of 2026-10-03. Applies to every curated input (`tcs6-pi-collector/curated/*.json`).
This is an operational citation standard, not a legal determination for every jurisdiction.

## 1. Public DAO governance forums (default policy)

Public DAO governance forums (Discourse forums, Snapshot, governance portals) may be used as sources
(`rights_status: permitted_for_derived_output`) under these conditions:

- **Publish only figures, factual findings, and links.** Never reproduce or quote forum text.
- **Cite** the forum, proposal title, author (if material), URL, and access date (`retrieved_at`).
- **Figures are reported or calculated data**, not independently verified facts, unless confirmed on chain
  (vote result, execution transaction, treasury balance) or in a second source. Say which in the note.
- **Never copy** substantial text, screenshots, images, comments, or personal information.
- **No login-gated, private, deleted, or access-restricted material** without separate permission.
- **Follow forum-specific terms**: copyright notices, robots.txt restrictions, attribution requirements.
  If a forum prohibits republication or automated access, flag the source (`pending_review`) and use an
  alternative public source.
- **Keep an internal citation record** for every curated figure: URL, access timestamp, the extracted
  figure, and the cross-check (vote / transaction) where available, in
  `tcs6-pi-collector/curated/_citations/<entity>.json`. This keeps the analysis auditable if the forum changes.

Checked so far: forum.cow.fi and gov.1inch.network robots.txt block only SEO crawlers (semrush, ahrefs,
mauibot, blexbot, seo spider) and `/admin/`, `/auth/`; no licence or republication restriction is stated.

## 2. Multi-year and already-paid budgets (cash uses)

Owner rule of 2026-10-03, applied with the per-protocol spending rules (Compound rule by analogy unless a
protocol has its own):

- Count an approved grant or budget when it was formally approved and the DAO is obligated to fund it.
- For forward runway, count only the portion expected to be funded within the scoring window (12 months).
- If a commitment covers several periods and its schedule is unavailable, **annualize** it rather than
  charging the full multi-period amount at once.
- Tranches already transferred are **realized spending** (record the transaction); later tranches are a
  separate committed future obligation.
- When the schedule is uncertain, publish two figures:
  1. **Base case**: 12-month scheduled or annualized expense (used for scoring).
  2. **Conservative case**: the full approved commitment.

v1 reports carry one figure (`expected_12m_cash_uses_usd`, the base case) and state the conservative case in
the cited note. `tcs-6-paid-response/2.0` adds both as separate fields.
