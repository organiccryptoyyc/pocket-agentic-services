# Beta TestNet registration + staking runbook

Every command in this file is written for **you to run yourself**, from your own
machine, with your own `pocketd` keyring. I (Claude) do not have a keyring in
this sandbox, cannot see or ask for your private keys, and will not run any
`pocketd tx ...` command — that has been the rule for every fund-moving or
publish action on this whole project and it applies here without exception.
Nothing below spends a token until you run it.

Two of the four steps below touch this constraint directly:

- Registering a service burns `add_service_fee` (currently **1,000 POKT per
  service on Beta** — see "Live parameters" below; this matches the "1000
  token burn" you said you're willing to pay for each package).
- Staking a supplier locks up `supplier.min_stake` (currently **~59,500 POKT
  on Beta**) as a bond, not a burn — it comes back on unstake (minus any
  slashing), after an ~86-session unbonding wait.

Get your explicit go-ahead in chat before you run any step that sends a real
transaction, even on Beta — testnet POKT is free from the faucet, but the
point of the rule is that nothing gets pushed to chain without you deciding,
in the moment, that this is the step to take.

## 0. What's already done

- All 4 backends are code-complete, lint-clean against
  `pocket-service-builder/scripts/lint_backend.py`, and their `card.json`
  files pass `validate_card.py`.
- The catalog conflict check (`check_catalog.py --both`) already ran clean
  for all 4 service IDs against both networks' live catalogs — including the
  `wallet-defi-intel-wallet-balance` `apis[]` entry, added after the initial
  four-package check and independently re-checked. No ID collisions, no
  fatal warnings.
- **Not done yet, and not something I can do for you:** a GitHub repo for
  `pocket-agentic-services`, a keyring, funded accounts, or anything on
  chain. Every card and README currently points at
  `github.com/organiccryptoyyc/pocket-agentic-services` as a *planned*
  location — that repo needs to actually exist (and the `openapi.json`
  `specs[].url` in each card needs to resolve) before a gateway or a judge
  can fetch the spec, so pushing the repo is a prerequisite for Step 5, not
  an afterthought. I can prepare the exact files; you push them (same
  pattern as `alpha1` — GitHub's web UI, or `git push` from your machine,
  your click, not mine).

## 1. The four services at a glance

| Service ID | Name (on-chain, ≤169 chars) | `apis[]` count | Package dir | Functional healthcheck probe |
|---|---|---|---|---|
| `pokt-network-intel` | POKT Network Intelligence | 8 | `pokt-network-intel/` | `POST /v1/tokenomics {}` → `$.mint_ratio` |
| `rpc-quality-intel` | RPC and Gateway Quality Intelligence | 4 | `rpc-quality-intel/` | `POST /v1/rpc-pulse {"service_id":"pocket"}` |
| `agent-trust` | Agent Trust and Compliance | 5 | `agent-trust/` | `POST /v1/domain-trust {"domain":"example.com"}` |
| `wallet-defi-intel` | Wallet and DeFi Intelligence | 9 | `wallet-defi-intel/` | `POST /v1/protocol-health {"protocol":"aave"}` → `$.protocol` = `Aave` |

All four: `access: public`, `results: deterministic`, `rpc_types: [{"type":"REST"}]`.

## 2. Live parameters — snapshot vs. re-check

Per the pocket-engineering skill's Rule 1, **none of the numbers below should
be typed into a real command from memory.** I fetched this snapshot live
(browser, since this sandbox's own network can't reach `sauron-api.beta.infra.pocket.network`
directly) at **2026-09-19T17:58 UTC**, so you can sanity-check the plan below —
but re-run the query yourself immediately before you actually register or
stake, since every one of these is a governance parameter that can change:

```bash
python scripts/live_params.py --network beta --pricing --target-upokt 400
```

Snapshot (Beta, `pocket-lego-testnet`):

| Parameter | Value (2026-09-19) |
|---|---|
| `service.add_service_fee` | 1,000,000,000 upokt = **1,000 POKT** |
| `supplier.min_stake` | 59,500,000,000 upokt = **59,500 POKT** |
| `supplier.staking_fee` | 1 upokt |
| `application.min_stake` | 1,000,000,000 upokt = **1,000 POKT** |
| `application.max_delegated_gateways` | 7 |
| `shared.num_blocks_per_session` | 20 |
| `shared.supplier_unbonding_period_sessions` | 86 |
| `shared.application_unbonding_period_sessions` | 2 |
| `shared.compute_units_to_tokens_multiplier` / `compute_unit_cost_granularity` | 40,000 / 1,000,000 → **0.04 upokt per compute unit** |
| `proof.proof_request_probability` | 0.01 |
| `proof.proof_missing_penalty` | 1 upokt (trivial on Beta right now) |
| observed average block time | ~30.4s (measured over the last 2,000 blocks) |

Derived: one session ≈ 20 blocks × ~30.4s ≈ **~10 minutes** on Beta right
now. That's the wait after `stake-supplier` before a new service entry
activates, and after `stake-application` before the app can relay.

**Re-checked live 2026-09-23** (4 days after the snapshot above, right
before starting registration): `add_service_fee` and `supplier.min_stake`
are unchanged (1,000 POKT / 59,500 POKT), and all 4 service IDs
(`pokt-network-intel`, `rpc-quality-intel`, `agent-trust`,
`wallet-defi-intel`) are still unclaimed on Beta — confirmed via
`GET /pokt-network/poktroll/service/service/<id>` returning 404 for each.
Also confirmed via the live node info endpoint that Beta is running
`poktrolld v0.1.35` (commit `a109dd0`) — the same commit as `main` on
GitHub, so the CLI syntax verified against source below is exactly what's
live, not a newer or older mismatch.

Registered gateways on Beta right now (`GET
/pokt-network/poktroll/gateway/gateway`, note the real response key is
**`gateways`**, not `gateway` singular the way `deploy.md`'s prose reads —
worth double-checking live rather than trusting the doc): 2 gateways
currently staked. Don't hardcode either address into anything permanent;
when you get to Step 8 (gateway onboarding), query this endpoint again and
identify the Agentic Portal's own gateway by name/card at that time.

## 3. Pricing: `compute_units_per_relay`

Comparable services on Beta right now (57 total services; CU/relay
distribution: min 1, p25 10,000, median 50,000, p75 50,000, max 300,000).
`pretty-charts` — a similarly-shaped read-only analytics/REST service — is
priced at **10,000 CU/relay**. At the live multiplier that's 10,000 × 0.04 =
400 upokt ≈ **0.0004 POKT per relay**.

Recommendation: register all 4 services at **`compute_units_per_relay =
10000`** to start — cheap enough to attract test relay volume during the
contest window, matches a real comparable service, and is updatable later
with `edit-service` (effective next session) without re-registering. Confirm
with the live pricing tool before you commit:

```bash
python scripts/live_params.py --network beta --pricing --target-upokt 400
```

## 4. Install pocketd, then keyring and funding (you do this; I never see the keys)

**Windows note, since that's what you're on:** `pocketd` officially runs on
Linux and macOS only — Windows users run it through WSL (confirmed against
docs.pocket.network's own pocketd CLI page). Your WSL is already installed
and up to date (confirmed 2026-09-23, you're already running Docker/Portainer
natively there too), so skip `wsl --install` — just open your existing WSL
shell and install pocketd there. I read the actual install script source on
GitHub before recommending it: it downloads the official release tarball
from `github.com/pokt-network/poktroll`'s own GitHub Releases, verifies it
against the published SHA256 checksum (aborts on mismatch), and extracts
exactly one file — the `pocketd` binary — to `/usr/local/bin`. No daemon, no
service, no key access.

```bash
curl -sSL https://raw.githubusercontent.com/pokt-network/poktroll/main/tools/scripts/pocketd-install.sh | bash
pocketd version
```

You need, per network you register on:

- One **owner** key — the account that registers services and receives
  supplier revenue. Can be the same for all 4 services.
- One **operator** key — the RelayMiner's signing key. Can be the same
  operator for all 4 services (one supplier stack serves many services).
- One **application** test key **per service** — an application stakes for
  exactly one service, so testing all 4 needs 4 app accounts.

Run all six now (key creation is free and instant — no need to fund
everything today, just create them):

```bash
pocketd keys add owner
pocketd keys add operator
pocketd keys add test-app-pokt-network-intel
pocketd keys add test-app-rpc-quality-intel
pocketd keys add test-app-agent-trust
pocketd keys add test-app-wallet-defi-intel
```

Each command prints a block like this **once**, and only that once:

```
- name: owner
  type: local
  address: pokt1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  pubkey: {...}

**Important** write this mnemonic phrase in a safe place.
It is the only way to recover your account if you ever forget your password.

word1 word2 word3 ... word24
```

Save the 24-word mnemonic somewhere safe (a password manager, not a text
file synced anywhere) — that's the only copy, `pocketd` never shows it
again. **Never send me, paste in chat, or put online that mnemonic, or any
private key.** The `address` line (`pokt1...`) is the only part that's safe
to share — that's what I need from you to fill in the rest of this runbook.
`pocketd keys list --output json` re-prints every address (never the
mnemonic) if you need them again later.

**Real addresses, generated 2026-09-23** (all public, safe to record here):

| Key | Address |
|---|---|
| `owner` | `pokt1sqvnlapcx2hta8rr683zeevn4fyuzjmxwjvly8` |
| `operator` | `pokt1gfrde5dm0myk3l32h0j4jr7uzwj0yxjry6n7u9` |
| `test-app-pokt-network-intel` | `pokt1f6zhksyqg4r68r4y6wms729eq2z03etjluyvwj` |
| `test-app-rpc-quality-intel` | `pokt1jwf98sw56a9a47gjjdlwq5ayfam2trrsz54ny8` |
| `test-app-agent-trust` | `pokt1uxlvwl3v5mh25wf8fq5jtgfthj2033erarspl3` |
| `test-app-wallet-defi-intel` | `pokt1pkes80q2q9x4wqnepdr3zapk7kgj6cmkal7fdh` |

**Note, 2026-09-23: the `owner` address was funded on the wrong network.**
You sent 4,100 POKT to `pokt1sqvnlapcx2hta8rr683zeevn4fyuzjmxwjvly8`, but
your wallet app defaulted to **MainNet**, not Beta — confirmed live by
querying `/cosmos/bank/v1beta1/balances/<address>` on both
`sauron-api.infra.pocket.network` (MainNet: 4,100 POKT landed, real money,
tx `BC5C59CB7F...1ED14B1552`) and `sauron-api.beta.infra.pocket.network`
(Beta: still 0). Same bech32 address, completely separate balances per
network. **That 4,100 POKT is being left alone on MainNet, earmarked for
§13 (the eventual MainNet registration) — do not spend it or move it until
we're actually doing the MainNet pass, and that gets its own explicit
approval separate from anything on Beta.** Beta gets funded fresh below,
from the faucet, at no cost.

**Beta web faucet, verified live 2026-09-23**
(https://faucet.beta.pocket.network/): the page defaults to a **MACT**
tab (1 MACT, once per address — not what you want). Click the **"Beta ·
POKT"** tab next to it — that one sends **100,000 POKT per request, limited
to 2 requests per 24h per address**, no wallet connection needed, just
paste the address into the field and submit. One request to `owner`
(`pokt1sqvnlapcx2hta8rr683zeevn4fyuzjmxwjvly8`) covers the full 4,000 POKT
of registration fees many times over in a single click — no need for
multiple requests or the CLI. Do the same for `operator` and each
`test-app-...` address (each needs its own single request; the 2-per-24h
limit is per address, not shared).

Fund each account either from that web faucet (simplest — recommended),
the CLI faucet:

```bash
pocketd faucet fund upokt <owner-address> --network=beta
pocketd faucet fund upokt <operator-address> --network=beta
pocketd faucet fund upokt <test-app-...-address> --network=beta   # x4
```

or, since you already have a funded Beta wallet... except you don't yet —
your existing funded wallet turned out to be MainNet-only, per the note
above. Once `owner` is faucet-funded on Beta, though, it becomes a funded
Beta wallet itself and could in principle fund the other 5 addresses by
ordinary transfer instead of 5 more faucet clicks, if you'd rather do it
that way.

**All 6 accounts funded and verified live, 2026-09-24.** You ran the web
faucet's "Beta · POKT" tab once per address; I independently confirmed
every balance via `GET /cosmos/bank/v1beta1/balances/<address>` on
`sauron-api.beta.infra.pocket.network` rather than trusting the faucet's
own "Sent" confirmation — each of the 6 shows exactly `100000000000upokt`
(100,000 POKT):

| Key | Balance (Beta) |
|---|---|
| `owner` | 100,000 POKT |
| `operator` | 100,000 POKT |
| `test-app-pokt-network-intel` | 100,000 POKT |
| `test-app-rpc-quality-intel` | 100,000 POKT |
| `test-app-agent-trust` | 100,000 POKT |
| `test-app-wallet-defi-intel` | 100,000 POKT |

Also re-checked right before this: `service.add_service_fee` is still
1,000 POKT, and all 4 service IDs (`pokt-network-intel`,
`rpc-quality-intel`, `agent-trust`, `wallet-defi-intel`) are still
unclaimed on Beta (`404`/"service ID not found" on each, via
`GET /pokt-network/poktroll/service/service/<id>`). Nothing's changed
since the 2026-09-23 snapshot in §2 — funding is fully done, and §5
(register the 4 services) is the next step, gated on your go-ahead.

Before staking the supplier, send **any** transaction from the operator
account first (even a 0-amount self-send or the faucet fund above counts) so
its public key lands on chain — an operator whose pubkey isn't yet on chain
gets its signed relay responses rejected by gateways.

Owner needs to cover: 4 × 1,000 POKT registration fee (4,000 POKT) + gas.
Operator needs to cover: ~59,500+ POKT supplier stake + gas (re-check the
live minimum first). Each test-app key needs: ~1,100 POKT (1,000 POKT
minimum + 10% margin, per the deploy skill's own recommendation — an app
staked at exactly the minimum unbonds itself after the first settled relay)
+ gas.

## 5. Register the 4 services

**Service 1/4 registered and verified live, 2026-09-24.**
`pokt-network-intel` ("POKT Network Intelligence") is now on Beta —
confirmed two ways, not just trusted from the CLI's own success output:
- `GET /cosmos/tx/v1beta1/txs/<txhash>` on the tx
  (`ADFAF0A07DBA1306AB3DD56E203FABD0B7C907FABD49D288651A306C71E8ACF1`)
  shows `code: 0`, a `/pocket.service.MsgAddService` message with
  `owner_address` = `owner`'s address and `service.id` =
  `pokt-network-intel`, a `1000000000upokt` (1,000 POKT) transfer to the
  service module account, plus a separate `404160upokt` (~0.404 POKT) gas
  fee — both paid, height `674058`, timestamp `2026-09-24T03:34:17Z`.
- `GET /pokt-network/poktroll/service/service/pokt-network-intel` (which
  404'd before this tx) now returns the full service record — id, name,
  `compute_units_per_relay: 10000`, correct `owner_address`, and the
  card metadata matching what was in `pokt-network-intel/card.json`.

**Service 2/4 registered and verified live, 2026-09-24.**
`rpc-quality-intel` ("RPC and Gateway Quality Intelligence") — tx
`93F1579EF24E5DAE61334FB593A7ADEA5A3B6A85AF503D0FFAEB419312680270`,
`code: 0`, correct `owner_address`, 1,000 POKT fee + ~0.396 POKT gas both
paid, height `674065`, timestamp `2026-09-24T03:37:50Z`. Confirmed the
same two ways as service 1 (raw tx query + the service now resolving
instead of 404ing).

**Service 3/4 registered and verified live, 2026-09-24.**
`agent-trust` ("Agent Trust and Compliance") — tx
`559DB8CF376528239E9654BC0FBC0B78CD9D3B02A8A35A527AFE4C4AA76B3DF2`,
`code: 0`, correct `owner_address`, 1,000 POKT fee + ~0.414 POKT gas both
paid, height `674067`, timestamp `2026-09-24T03:38:50Z`.

**Service 4/4 registered and verified live, 2026-09-24 — all 4 services
now registered on Beta.**
`wallet-defi-intel` ("Wallet and DeFi Intelligence") — tx
`41815FFA6D663E8EFAE84C59A2F45A9BB695789876140127A5207DD8BE89AE1B`,
`code: 0`, correct `owner_address`, 1,000 POKT fee + 0.42 POKT gas both
paid, height `674068`, timestamp `2026-09-24T03:39:21Z`.

**§5 is complete.** All 4 service IDs (`pokt-network-intel`,
`rpc-quality-intel`, `agent-trust`, `wallet-defi-intel`) are live on Beta,
each confirmed by its own successful tx plus the service now resolving on
`GET /pokt-network/poktroll/service/service/<id>` (all 404'd before their
respective registration tx). `owner`'s remaining Beta balance, confirmed
live: **95,998.365837 POKT** (started at 100,000; spent 4,000 POKT in fees
+ ~1.634 POKT total gas across the 4 txs) — comfortably above the
~59,500+ POKT `operator` will need for the supplier stake in §9, though
that stake draws from `operator`'s own balance (separately funded, also
100,000 POKT), not `owner`'s.

Next: §6 (a fuller verification pass — card-diff check, not just
existence) is effectively already covered by the per-tx verification
above; §7-8 (deploy the 4 backends + shared RelayMiner) has no chain spend
and no approval gate — can start any time, in parallel with planning §9.

Run from `pocket-agentic-services/`, one `add-service` per package, each
using that package's own `card.json`:

```bash
export TX="--from owner --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5"

pocketd tx service add-service pokt-network-intel "POKT Network Intelligence" 10000 \
  --card-file ./pokt-network-intel/card.json $TX

pocketd tx service add-service rpc-quality-intel "RPC and Gateway Quality Intelligence" 10000 \
  --card-file ./rpc-quality-intel/card.json $TX

pocketd tx service add-service agent-trust "Agent Trust and Compliance" 10000 \
  --card-file ./agent-trust/card.json $TX

pocketd tx service add-service wallet-defi-intel "Wallet and DeFi Intelligence" 10000 \
  --card-file ./wallet-defi-intel/card.json $TX
```

Use `--gas auto`, never a fixed `--fees` — these cards are multi-KB and a
fixed fee will fail with `out of gas in location: txSize`.

**Command syntax verified against source, not just the toolkit docs,
2026-09-23.** I read `x/service/module/tx_add_service.go` directly on
`pokt-network/poktroll@main` (the same commit Beta is running) because
docs.pocket.network's own "Staking & Transactions" quick-reference page
shows a *different*, flag-based example for `add-service`
(`--name`/`--compute-units-per-relay` as flags, no service ID at all) that
does not match the actual command and would not work — that page looks
stale or wrong, don't follow it. The real command is exactly what's above:
positional `<service-id> <service-name> [compute-units-per-relay]` plus
`--card-file` (or `--card-base64`, mutually exclusive). Two things worth
knowing from reading the source: `add-service` also doubles as the *update*
command (re-running it as the owner updates the existing service — nothing
special needed later if you want to change the price or card), and
`pocketd` now validates the card against the Pocket Service Card schema
client-side before broadcasting, so a malformed card fails immediately with
no gas spent rather than landing on-chain broken (`--skip-card-validation`
bypasses that if you ever need to for a non-standard payload — you won't
need it here, our cards already pass `validate_card.py`).

**Repo status**: pushed and verified clean 2026-09-23 — root has exactly
`README.md`, `docs/`, and the 4 package folders, and all four cards'
`specs[].url` (`raw.githubusercontent.com/organiccryptoyyc/pocket-agentic-services/main/...`)
resolve 200. Nothing left to fix there before running the commands above.

## 6. Verify each registration

```bash
for id in pokt-network-intel rpc-quality-intel agent-trust wallet-defi-intel; do
  echo "=== $id ==="
  pocketd query service show-service "$id" --network=beta
  python scripts/query_state.py --network beta --service "$id"
  python scripts/encode_card.py diff "./$id/card.json" --id "$id" --network beta   # expect "identical"
done
```

## 7. Deploy the backends

Each package already has its own `server.js` (no external deps, `node
server.js` or `npm start`) and passes `lint_backend.py` locally. Containerize
each with `templates/backend-compose.yaml` from the toolkit, one container
per service, all on the shared `pocket-supplier` Docker network. Nothing
here needs a chain interaction, so this step has no approval gate — it's
ordinary deployment work you can do (or have me help script) whenever.

## 8. RelayMiner (HA) — one stack per network, shared across all 4 services

Per the toolkit's `deploy.md`: always the HA RelayMiner (`pocket-relay-miner`
— Redis + miner + relayer), never the legacy single-process
`pocketd relayminer` (its claim signing breaks against the public Sauron
gRPC endpoints). One supplier stack serves every service you list in its
stake config — you don't stand up 4 separate RelayMiners.

```bash
python scripts/render_templates.py --print-answers > answers.json
```

Edit `answers.json` (no private keys in it — keys are referenced by keyring
name only):

```json
{
  "NETWORK": "beta",
  "OPERATOR_KEY_NAME": "operator",
  "OWNER_KEY_NAME": "owner",
  "OWNER_ADDRESS": "<your owner address>",
  "OPERATOR_ADDRESS": "<your operator address>",
  "STAKE_AMOUNT_UPOKT": "60000000000"
}
```
(`60,000,000,000` upokt = 60,000 POKT — ~500 POKT above the live 59,500 POKT
minimum; re-check the minimum first and keep a margin, per the toolkit's own
"stake above the minimum, not at it" rule.)

```bash
python scripts/render_templates.py answers.json --out ./deploy
```

Then build one `supplier_stake_config.yaml` by hand (or extend the rendered
one) listing **all four services** under one supplier, each with its own
public URL:

```yaml
owner_address: <owner-address>
operator_address: <operator-address>
stake_amount: 60000000000upokt
default_rev_share_percent:
  <owner-address>: 100
services:
  - service_id: pokt-network-intel
    endpoints:
      - publicly_exposed_url: https://<your-domain>/pokt-network-intel
        rpc_type: REST
  - service_id: rpc-quality-intel
    endpoints:
      - publicly_exposed_url: https://<your-domain>/rpc-quality-intel
        rpc_type: REST
  - service_id: agent-trust
    endpoints:
      - publicly_exposed_url: https://<your-domain>/agent-trust
        rpc_type: REST
  - service_id: wallet-defi-intel
    endpoints:
      - publicly_exposed_url: https://<your-domain>/wallet-defi-intel
        rpc_type: REST
```

(Exact URL shape depends on how you route the 4 backends behind your
reverse proxy — one relayer, one hostname, path- or port-routed to each
service's container. That's an infrastructure choice, not a chain one; happy
to help design it when you're ready.)

## 9. Stake the supplier — approval gate

```bash
pocketd tx supplier stake-supplier --config ./supplier_stake_config.yaml \
  --from operator --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5
python scripts/query_state.py --network beta --supplier <operator-address>
```

**Confirm in chat before running this** — it locks up real (if testnet)
POKT as a bond. The new service list activates at the next session boundary
(~10 minutes on Beta right now); `query_state.py --supplier` will show the
new entries as SCHEDULED until then, which is expected, not a failure.

## 10. Run the RelayMiner, then each backend

```bash
cd deploy/ha && docker compose -p pocket-supplier up -d
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/health   # 200 = relayer ready
```

Then each service's backend container (`backend-compose.yaml`, one per
package). Put Caddy/nginx in front for TLS — the relayer speaks plain HTTP
and must never be exposed directly; never expose `:8081` (health) or
`:9090`/`:9092` (metrics) publicly.

## 11. Stake test applications and relay — approval gate

One app per service (each app stakes for exactly one service):

```bash
for svc in pokt-network-intel rpc-quality-intel agent-trust wallet-defi-intel; do
  pocketd tx application stake-application \
    --config <(echo "stake_amount: 1100000000upokt
service_ids:
  - $svc") \
    --from "test-app-$svc" --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5
done
```

**Confirm in chat before running this too** — another real (testnet) spend.
Wait one session (~10 min), then relay directly with `pocket-ap` (no gateway
needed for this test):

```bash
POCKET_APP_PRIVATE_KEY=<app-key-hex> pocket-ap call \
  --config ./deploy/pocket-ap.yaml --service pokt-network-intel --rpc-type rest \
  -X POST --path /v1/tokenomics -d '{}' -v
```

(repeat per service, swapping `--service`, `--path`, and the request body
for that service's own healthcheck probe from the table in §1).

Confirm the relay landed and settled:

```bash
python scripts/query_state.py --network beta --session --app <app-addr> --service <id> --supplier <operator-addr>
python scripts/query_state.py --network beta --claims --supplier <operator-addr>
```

The claim/tx ID from this step is one of the fields the contest form asks
for (task #16) — this is the step that actually produces it, so #16 is
blocked on this one.

## 12. Onboard a gateway (optional for the contest, needed for real traffic)

Gateways don't read the card directly — publish `deploy/sage-service.yaml`
and open a PR adding a `pocket-health-checks-entry.yaml` to
`pocket-network-resources`. Re-run the gateway query from §2
(`/pokt-network/poktroll/gateway/gateway`, key `gateways`) at that time to
find the Agentic Portal's actual gateway address rather than trusting
whatever this snapshot showed.

## 13. MainNet — after Beta is proven, and only with fresh approval

Re-run `live_params.py --network main` for the real fee/stake numbers (the
add-service fee is higher on MainNet), repoint `pocket_node` URLs and
`--chain-id pocket`, and repeat §5 onward. MainNet POKT is real money —
treat every `pocketd tx` here as its own separate approval, no matter what
was approved for Beta.

## §7-8 deployment package built, 2026-09-24

Full Docker deployment package written to `deploy/` (4 backend Dockerfiles +
per-service `backend-compose.yaml`, a shared supplier stack `docker-compose.yaml`
— redis + miner + relayer + a standalone Caddy — plus filled-in
`miner-config.yaml`/`relayer-config.yaml`, and a step-by-step `deploy/README.md`).
Locked in via chat: host = Umbrel box; public URL =
`https://agentic.organiccryptoyyc.com:8444` (one URL for all 4 services — a
relay carries nothing a proxy could route on, so the relayer dispatches by
service ID inside the signed relay, not by path); reverse proxy = a second,
standalone Caddy container isolated from alpha1's existing Caddy (doesn't
touch host port 80/443, gets its cert via a Cloudflare DNS-01 challenge
instead of needing an open port 80/443, publishes 8444 instead).

Network endpoints verified live (not assumed) 2026-09-24 via
`sauron-rpc.beta.infra.pocket.network/status`: `network: "pocket-lego-testnet"`,
`catching_up: false`, block height 674109 at time of check — matches the
pocket-service-builder toolkit's own beta defaults across three independent
files (`scripts/render_templates.py`, `references/concepts.md`, infra
`README.md`), so used directly: chain_id `pocket-lego-testnet`, RPC
`https://sauron-rpc.beta.infra.pocket.network`, gRPC
`sauron-grpc.beta.infra.pocket.network:443`. Block time in the miner config
uses the already-measured ~30.4s average (rounded to 31s), not the
template's placeholder 60s.

All 4 backends smoke-tested locally with `node server.js` (no Docker daemon
available in this sandbox to build/run the actual images, so this is the
closest verification possible here) — all 4 respond `{"status":"ok"}` on
`GET /v1/health` with the exact env vars the deploy configs set
(`POCKET_NETWORK=beta` for pokt-network-intel/rpc-quality-intel). Each
`backend-compose.yaml` and the supplier `docker-compose.yaml` validated
structurally with `docker compose config` — caught that the per-service
compose files are named `backend-compose.yaml`, not the default
`docker-compose.yaml` docker looks for automatically, so the run commands in
`deploy/README.md` needed an explicit `-f backend-compose.yaml` the
toolkit's own template comment omits.

`supplier/supplier_stake_config.yaml` also drafted for the later §9 step
(owner/operator addresses filled in from already-recorded values, public URL
filled in, `stake_amount` left as an explicit TODO to re-query
`pocketd query supplier params --network=beta` live before running it —
never hardcoded).

Next: you get the `deploy/` package + a 3-item pre-flight checklist (DNS
record, router port-forward, Cloudflare API token) and run it on the Umbrel
box whenever ready — no approval gate on §7-8 itself. §9 and §11 stay
gated on explicit go-ahead as always.

## §7-8 live on the box, 2026-09-25/26

Box access confirmed: umbrelOS's own Terminal (Settings → Advanced settings
→ Terminal → "umbrelOS" scope), not Portainer (its console is scoped to a
single container — we nearly ran commands inside alpha1's own container by
mistake, caught before anything happened). `umbrel` user needs `sudo` for
every `docker`/`docker compose` command (not in the `docker` group) —
`deploy/README.md` updated to prefix all of them.

Port 8443 (the originally-planned public port) turned out to already be
held by an orphaned `docker-proxy` process (most likely our own first,
partially-failed `caddy` start) that `docker compose down` didn't clear;
rather than keep chasing it on a box that also runs alpha1, switched the
public port to **8444** everywhere (`docker-compose.yaml`, `Caddyfile`
comments, `relayer-config.yaml` comments, `supplier_stake_config.yaml`,
`deploy/README.md`, this file) — public URL is now
`https://agentic.organiccryptoyyc.com:8444`.

Supplier stack (redis + miner + relayer + caddy) is up and verified live —
Caddy completed a real Let's Encrypt DNS-01 challenge against Cloudflare and
logged `certificate obtained successfully` for `agentic.organiccryptoyyc.com`
(`challenge_type: dns-01`, `validations succeeded`), confirmed from the
container's actual logs, not assumed.

**Bug caught and fixed, 2026-09-26**: the `deploy/` package as originally
built and sent only had each service's `Dockerfile` under
`services/<id>/backend/` — never the actual source (`package.json`,
`server.js`, `lib/`), so every one of the 4 backend builds failed on
`COPY lib ./lib` (file not found). Fixed by copying the real source from
each service's own repo folder into `deploy/services/<id>/backend/`,
syntax-checking and boot-testing all 4 locally (`node --check` on every
file, then actually running each `server.js` and hitting `/v1/health`)
before sending a small `backend-source-fix.tar.gz` (just the 4 `backend/`
folders) rather than re-sending the whole package.

All 4 backends rebuilt successfully after the fix and passed internal
health checks from inside the `pocket-supplier` network (`docker exec
pocket-supplier-relayer wget -qO- http://<service>-backend:8080/v1/health`
→ `{"status":"ok"}` for all 4).

## §7-8 closed out — external reachability confirmed, 2026-09-26

Router port-forward (external `8444` → the Umbrel box's LAN IP, port
`8444`) is done — it turned out to live somewhere other than where we'd
been looking (not the Rogers Ignite HomeConnect mobile app's own "Add
Port Forward" device-picker, which never showed the box despite its DHCP
reservation and existing rules; exact location not detailed by the user,
just confirmed working).

Verified end-to-end from outside the deployment (PowerShell on the user's
PC, over the home network — worked despite the usual NAT-hairpin risk on
a same-network test):

```
curl -v https://agentic.organiccryptoyyc.com:8444/
```

Response: `{"error":"invalid relay request: body must be a valid
RelayRequest protobuf"}` — this is the relayer itself, not a TLS or proxy
error, confirming the complete chain works: DNS → router port-forward →
Caddy TLS termination (valid cert) → reverse proxy → relayer receiving
and correctly parsing/rejecting a non-protobuf request. This is the
expected and correct result for a bare `curl` (it isn't a signed relay).

**§7-8 is fully done.** `docs/contest-submission.md` updated with the
live Endpoint URL (`https://agentic.organiccryptoyyc.com:8444`) for all 4
services. Only Test Transaction ID remains per service, blocked on §9
(supplier stake) then §11 (app stake + relay) — both still gated on
explicit go-ahead.

## §9 — supplier staked, 2026-09-26

Live params re-verified before staking (never trusted the placeholder):
`min_stake` 59,500,000,000 upokt (59,500 POKT exactly), `staking_fee` 1 upokt,
`proof_missing_penalty` 1 upokt (negligible on Beta right now), session
length 20 blocks (~31s/block -> ~10-11 min). Also checked `operator`'s
on-chain account via the LCD before staking and found `pub_key: null,
sequence: 0` — it had never sent a transaction — so per the toolkit's own
deploy guidance, sent one first (a trivial 1000upokt self-send) to get its
public key on-chain before gateways would need to verify its signed relay
responses.

Staked at **60,000 POKT** — 500 POKT above the live minimum, per the
toolkit's rule against staking exactly at the minimum (that's the amount
the protocol can slash, and the minimum itself is a governance parameter
that can rise). `operator`'s 100,000 POKT Beta balance covered it with
plenty of room.

Two txs, both confirmed via the resulting `show-supplier` query showing
the correct stake and all 4 services listed (not just trusted from CLI
echo):
- self-send (pubkey reveal): `68C75C38C61CB55EABC5783733CFC9BDF5A4D635D4C7F15B44A15DC225748249`
- `stake-supplier`: `8CE167AB7ADFB206F21EDB1E1E80AC724159603B1C4635D92430DBB2B8C6A98D`

`show-supplier` for `pokt1gfrde5dm0myk3l32h0j4jr7uzwj0yxjry6n7u9` confirms:
stake `60000000000upokt`, all 4 services (`pokt-network-intel`,
`rpc-quality-intel`, `agent-trust`, `wallet-defi-intel`) each with
endpoint `https://agentic.organiccryptoyyc.com:8444` (REST), 100% rev
share to `owner`, `activation_height: 679501`. Checked live chain height
at the same time: 679496 — only 5 blocks out, well under one session.
**§9 is done.**

Next: §11 — stake one test application per service and relay a real call
through the endpoint. This is what produces each service's Test
Transaction ID for the contest form. Still gated on explicit go-ahead.

## §11 — app stakes done, relay testing in progress, 2026-09-26

All 4 test applications staked at 1,100 POKT each (1,000 POKT live minimum
+ 10% margin, per the toolkit's own recommendation — an app staked at
exactly the minimum unbonds itself after the first settled relay).
Confirmed via `show-application` for each address (one hit a transient
"application not found" right after staking — a query-backend timing
race, not a real failure; the tx itself had `code: 0` and a real
`EventApplicationStaked` event when queried directly by hash, and
`show-application` resolved cleanly on retry).

Relay-testing tool: `pocket-ap` (`ghcr.io/pokt-network/pocket-ap:latest`,
Docker), run from the Umbrel box terminal (the only place with a working
Docker daemon — WSL's Docker daemon was never reachable, so all
Docker-dependent steps moved here). Stabilized into a reliable four-step
pattern per service: fresh app-key export in WSL -> regenerate
`pocket-ap.yaml` (service_id) -> regenerate `body.json` (that service's
test payload) -> `export APPKEY` + a script file (`run-relay.sh`, to avoid
long-line paste truncation in the interactive terminal) run via
`bash run-relay.sh`. Key gotchas hit and fixed along the way: `sudo`
resets the environment (fixed by passing `-e VARNAME=value` literally to
`docker run`, not relying on a bare `-e VARNAME` plus `-E`); a
`read -s -p` capture must be `export`ed to be visible to a child
`bash run-relay.sh` process; nothing carries over between services —
each one needs its own fresh key, yaml, and body file.

**pokt-network-intel: relay confirmed, 2026-09-26.** Real relay through
the staked supplier and staked application, real tokenomics data back
(mint_ratio, PIP-41 distribution), ~930ms supplier response time.

**rpc-quality-intel: relay confirmed, 2026-09-26 — after a real bug fix.**
First attempt returned a 404 from the backend: the submission doc's test
payload assumed `service_id: "pocket"` was always valid, but Beta actually
rejects it (`"no service with id 'pocket' on beta"`) — `"pocket"` is not
a real Beta service ID. Root-caused by pulling the live Beta service
catalog (`sauron-api.beta.infra.pocket.network/.../service/service`) and
found `pnf-pocket-beta` as a real, actively-served substitute (32
suppliers, high relay volume). Second attempt with that service_id
returned HTTP 422 from the backend itself — a genuine typo in our own
GraphQL query in `server.js` (`relayMiningDifficultyUpdatedEvents`
instead of the indexer's real field name, `eventRelayMiningDifficultyUpdateds`),
confirmed via live GraphQL introspection against
`data.beta.pocket.network/graphql` and cross-checked against every other
query in the file (all others already used the correct `event<Type>s`
pattern — this was isolated, not systemic). Fixed in the canonical source,
the deploy package copy, and the README's docs table. **Root cause of the
fix not reaching the running container the first time**: `deploy/`'s
`backend-compose.yaml` builds from `../backend` (a sibling folder, not a
subfolder of `deploy/`) — the corrected file needed to be edited directly
at `/opt/pocket/services/rpc-quality-intel/backend/server.js` on the box
itself (via `sed -i`) before a rebuild would actually pick it up; the
first rebuild attempt silently reused Docker's build cache (`COPY server.js`
showed CACHED) because the box's copy hadn't changed yet. After the
correct-path fix and a real rebuild (`COPY server.js` no longer cached),
the relay succeeded end-to-end: 32 active suppliers, 1 active application,
relay-mining difficulty EMA 5815, 192 settlements / 34,944 relays in the
trailing hour, ~1.46s supplier response via
`https://agentic.organiccryptoyyc.com:8444`.

**agent-trust: relay confirmed, 2026-09-26 — after a second real bug fix.**
First attempt returned `{"error":{"code":"upstream_unavailable","message":
"non-JSON response from https://rdap.org/domain/example.com (HTTP 403)"}}`.
Root-caused, not assumed external-outage: Node's built-in `fetch` (undici)
sends no `User-Agent` header at all unless the app sets one, and
rdap.org's redirect target (`rdap.verisign.com`, Cloudflare-fronted) blocks
UA-less requests as bot traffic, serving Cloudflare's branded HTML error
page instead of the real RDAP JSON — confirmed by reproducing the exact
same block with `curl -A ""` from the Umbrel box (which has real internet
access; this sandbox's own egress proxy blocks `rdap.org` outright, so the
diagnosis had to run on the box itself), then reproducing a clean 200 with
a real UA string. Also caught along the way: the error message in
`lib/net.js` logged the pre-redirect URL (`rdap.org`) rather than the
actual failing destination (`rdap.verisign.com`), which was misleading
during triage — worth knowing if this class of error resurfaces.
Fixed by adding a `DEFAULT_USER_AGENT` (`pocket-agentic-services-agent-trust/1.0
(+https://github.com/organiccryptoyyc/pocket-agentic-services)`,
overridable via `SERVICE_USER_AGENT`) applied to every outbound `fetchJSON`
call in the service, not just RDAP — same "fix it at the shared helper,
not the call site" approach as the rpc-quality-intel fix. Verified against
the live Verisign RDAP endpoint before touching the container. Fixed
directly on the box at `/opt/pocket/services/agent-trust/backend/lib/net.js`
(same sibling-`backend`-folder layout as rpc-quality-intel), rebuilt
(`COPY lib ./lib` actually re-ran, not cached), and relayed clean:
`trust_score: 100` for `example.com`, real RDAP data (registered 11,365
days ago, DNSSEC signed, SPF/DMARC present, 2+ nameservers), 636ms
supplier response.

**wallet-defi-intel: relay confirmed, 2026-09-26 — no bug this time.**
Clean relay on the first real attempt with the stabilized four-step
pattern (the earlier attempt, before the pattern stabilized, reused a
stale config/key from the pokt-network-intel test and never produced a
valid result — not counted). Real data back: protocol `Aave`, TVL
$19,307,136,536, 7d change +1.66%, 30d change +5.36%, 26 chains, market
cap $2.39B, and real hack history (the Aave V3 incident, $862,000, fully
recovered) — genuine DefiLlama-sourced data, not simulated. Supplier
responded in ~10s (slower than the other 3, still well within tolerance).

**§11 is fully done — all 4 services have a confirmed, real, end-to-end
relay through the staked supplier and a staked application:**
pokt-network-intel, rpc-quality-intel (after the GraphQL field-name fix),
agent-trust (after the missing-User-Agent fix), wallet-defi-intel.

## §11 — Test Transaction IDs found and verified, 2026-09-26

Confirmed the right artifact: the RelayMiner's automatic claim-submission
transaction, `/pocket.proof.MsgCreateClaim` — signed and broadcast by
`operator` automatically once a session ends and the claim window opens
(live params: `claim_window_open_offset_blocks` 11,
`claim_window_close_offset_blocks` 10 — so the window is roughly
session-end+11 to session-end+21 blocks, ~5.5-11 min after the session
closes). Distinct from the `MsgAddService` registration tx, and distinct
from `MsgSubmitProof`/settlement (not needed here — claimed amounts are
under the live `proof_requirement_threshold` of 100 upokt, so these
settle without a separate proof transaction).

Query method (this sandbox's own network can't reach `*.pocket.network`
directly, so run via the browser or from your own machine): the Beta
GraphQL indexer's `msgCreateClaims` query, filtered by `supplierId`:

```graphql
query {
  msgCreateClaims(
    filter: {supplierId: {equalTo: "pokt1gfrde5dm0myk3l32h0j4jr7uzwj0yxjry6n7u9"}}
    orderBy: SESSION_END_HEIGHT_DESC
    first: 20
  ) {
    nodes { serviceId sessionEndHeight numRelays transactionId }
  }
}
```
against `https://data.beta.pocket.network/graphql`. Each result's
`transactionId` was then independently verified against the raw LCD
(`GET /cosmos/tx/v1beta1/txs/<hash>` on
`sauron-api.beta.infra.pocket.network`) for `code: 0` and a real
`/pocket.proof.MsgCreateClaim` message signed by `operator` — not just
trusted from the indexer.

Found and verified, 2026-09-26 (chain height at check: 679690):

| Service | Session end height | Claim tx (`MsgCreateClaim`) |
|---|---|---|
| pokt-network-intel | 679540 | `ECCFADEADBC1829EF57FAF30FFE66D6903992B6D87B073C9F7A4186A1575D1A2` |
| rpc-quality-intel | 679640 | `E23DE328D3771CB4D366D4C057EBBEF4A3B8E8759468ED810D96B1F6F60A8196` |
| agent-trust | 679660 | `04727BC292BA71B6C2A238DF000B0DFAAD2B45C2F92E0DEB5DC5BF964184CFE8` |
| wallet-defi-intel | 679700 | ⏳ session hadn't closed yet at check time (679690 < 679700) — re-run the query above once the chain passes ~679711 |

`docs/contest-submission.md` updated with the 3 confirmed tx IDs — those
3 services are ready to submit now. wallet-defi-intel just needs the same
query re-run in a few minutes once its session closes and the claim
window opens.

**wallet-defi-intel's claim confirmed shortly after, 2026-09-26** (chain
height 679718 at check): tx
`8D546919822E33A7F4E39F0B49D66E4D6537A5F85DF1C141CC2729D1A1887222`,
verified the same way (code 0, real `/pocket.proof.MsgCreateClaim`,
correct signer and service_id) — all 4 Test Transaction IDs now confirmed.

## All 4 form responses submitted, 2026-09-26 — hackathon submission complete

User submitted pokt-network-intel's form directly (self-corrected one
field — the category radio — after browser automation mis-clicked it).
For the remaining 3, rather than keep fighting an unreliable background-
tab browser-automation issue with Google Form's custom (non-native)
radio/checkbox widgets, switched approach: opened a fresh blank form tab
per remaining service and gave the user every field's exact value in
form order in chat, for them to paste in and submit themselves — faster
and more reliable than continuing to debug click automation on a
consequential, real external form. User confirmed all 3 submitted.

**The entire pipeline is done**: §5 registration → §7-8 deploy → §9
supplier stake → §11 app stakes + relay-testing (including two genuine
backend bugs found and fixed along the way) → all 4 Test Transaction IDs
found and independently verified → all 4 contest form responses
submitted. Nothing outstanding before the Oct 12 deadline.

## Quick reference: what blocks what

1. GitHub repo pushed → spec URLs resolve → safe to register (§5).
2. §5 registration → §6 verify → §9 supplier stake needs a registered
   service to list.
3. §9 stake → one session wait → §11 app stake + relay → this is what
   produces the "test tx ID" and live endpoint URL the contest form (task
   #16) needs.
4. None of §9, §11, or the MainNet repeat happen without your explicit
   go-ahead in this chat, per the standing rule for this whole project.

## §14 — MainNet funding-mistake balance returned, 2026-09-26

The 4,100 POKT sitting on MainNet on `owner`'s address (a leftover from an
earlier funding mistake, previously earmarked as "free" future §13
onboarding money) was sent back to its original wallet
`pokt16cqt2tjzec6gsxdncl0v6k2aa7awya0wghevlw`, per your explicit
instruction, leaving 1 POKT on `owner` for gas. You ran the transfer
yourself; txhash `59387C28D8381E02773708F06F5D3E913170D642636AF0CD5B2BB817B07221DF`
verified against the raw MainNet LCD before/after — balance moved as
intended. Consequence: `owner`'s MainNet account now has ~1 POKT, not
4,100 — any future §13 MainNet registration pass needs fresh funding
first. No action needed unless/until you ask for §13.

## §15 — "What else should we build?" research, 2026-09-26

You asked whether we should build more API packages, grounded in real
usage/demand rather than a guess. Findings, each pulled live (not
recalled), in the order they change the recommendation:

**1. There are two separate Pocket "marketplaces" and our 4 services are
only in the smaller one.** The Beta TestNet service catalog (`sauron-api`)
is just the staking registry — anyone can register a service ID there for
1,000 POKT burn, and it's grown from 179 to 246 entries in about a week,
mostly other hackathon contestants' own minimal 1-supplier submissions
(checked live via the Beta indexer's `supplierServiceConfigs` count —
almost every "competitor" service on that catalog has exactly 1 supplier,
same as ours). Separately, **`agent.pocket.network`** is the Foundation's
actual live, MainNet, revenue-collecting x402/MPP marketplace — real
priced endpoints ($0.005/call flat), real payment rails (Base + Tempo,
x402 or MPP), real usage stats. **None of our 4 services are listed
there** — that catalog is populated by services the Foundation has
already onboarded/promoted, not by Beta registrations. Getting a service
onto it is presumably what "selected"/"judge's favorite" in the contest
rules actually means in practice, per `docs/contest-submission.md`.

**2. The real marketplace's own usage data is the best demand signal
available, and it's small but legible.** Snapshot 2026-09-26: 99 services
across 10 categories (Blockchain 50, Finance 10, Government 8, Web 8,
Security 5, Documents 5, Compliance 4, Health 3, Research 3, AI 3); 1,252
requests over the trailing 7 days, only 100 in the trailing 24h, 1,305 in
30 days (i.e. essentially all of the 30-day volume is from the last week —
this only started getting used recently); 10 active agents in 30 days;
$6.27 billed / $6.25 collected over 7 days. Top 5 services by 7-day calls:
AgentSearch (349, 27.9% of ALL calls on the entire portal), AgentSearch
Web Extract (26, 2.1%), Ethereum Mainnet JSON-RPC (24), Academic Literature
Search (20), Base Mainnet JSON-RPC (15). Reading: general-purpose web
search/extraction is, by a wide margin, the single most-called primitive
on the whole portal — well ahead of any blockchain-specific data service,
despite blockchain services being half the catalog by count. Overall
volume is tiny, though, so treat this as a directional signal, not a firm
number.

**3. Every category we were about to propose as a "gap" is already live
and built.** Checked the full 99-service list (`agent.pocket.network/services.json`)
category by category. Government: address standardization, entity
registration, federal contract opportunities, federal register search,
patents/trademarks, regulatory enforcement actions, trade/tariff data, US
Code/CFR — all 8, all live. Finance: crypto FX, fund/ETF holdings, insider
Form 4 transactions, rate benchmarks, occupational wages, SEC 8-K,
SEC EDGAR XBRL, SEC institutional holdings, treasury/fiscal data, US
macro — all 10, all live. Compliance: counterparty screening, debarment/
exclusion, export control, sanctions/watchlist — all 4, all live (direct
overlap with `agent-trust`'s sanctions-check feature, though ours bundles
it into a composite trust score rather than serving it standalone).
Security includes DNS/WHOIS/RDAP lookup — a direct duplicate of
`agent-trust`'s domain-trust building block, already shipped by someone
else on the real marketplace. The US-government/SEC/macro cluster we'd
tentatively scoped as a good candidate is **not a gap — it's already
comprehensively covered**, so it's off the list.

**4. One real, verified gap survived the check: general "agent utility"
file/media tooling.** Searched all 99 services for pdf/screenshot/image/
heic/convert/render/ocr/video/audio/transcribe. Only 3 hits: OCR document
parsing (text extraction, not image handling), Pretty Charts (renders a
chart from data you already have, not from an arbitrary page/file), and
Headless Browser Render (HTML only — explicitly no JS execution, no
screenshot, text/DOM out). **No service anywhere on the real portal takes
a URL or file and returns an actual image** (real rendered screenshot,
PDF-page-to-image), converts image formats (HEIC-to-PNG, etc.), or
transcribes audio/video. This is the same "Agent utility tools" idea
scoped but not built in the original 2026-09-19 audit — it survives this
second, much more rigorous check (against the real production catalog,
not just the Beta registry) as the one clean, unclaimed niche.

**5. A serious competitor exists in our own thematic space, and they're
good.** Found via search:
[jsymen1290/pocket-agents](https://github.com/jsymen1290/pocket-agents) —
7 services from the same contest, one supplier, stdlib-only Python,
"portal audit 9/9 on Beta TestNet (2026-09-20)". Two of theirs
(`pokt-settlement-agent-v1`, `pokt-network-watch-v1`) sit in the same
"Pocket protocol observability" theme as our `pokt-network-intel` /
`rpc-quality-intel`, but from a genuinely different angle — per-event
settlement evidence with operator-watch, and a change-detector over 15
official sources with fetch-receipt + SHA-256 verification, rather than
our network-wide-pulse/quality-scoring/forecast angle. No direct
one-to-one duplicate of anything we built, but it confirms this theme now
has at least two serious (not just minimally-staked) entrants — the
differentiator is build quality and comprehensiveness, not being first.
Their other 5 services (Korean exchange market data, Korean export/DART
filings data, Pine Script backtest-integrity linting, a meta-service that
audits/ranks other portal services) show the contest rewards genuine
originality over "another chain-data wrapper" — worth noting as a
pattern, not something to copy.

**6. Background, not current-cycle:** a Feb 2026 Pocket Network ×
AnChain.AI partnership/hackathon ("Compliance Unlocked," already
concluded ~April 2026) confirms compliance/risk-scoring is a
Foundation-endorsed theme in this ecosystem generally — supportive
context for `agent-trust`'s existing angle, not a live threat or an
opportunity for a new build.

**Net recommendation:** don't build another blockchain-RPC wrapper,
another government/regulatory-data service, or another SEC/finance-data
service — all saturated on the real marketplace already. The one
build-worthy candidate that survived contact with real data is a small
**"agent media utilities"** package: real screenshot capture (actual
rendered PNG/JPEG of a URL, not raw HTML), file-format conversion
(HEIC→PNG and similar), and possibly basic audio/video transcription —
genuinely unclaimed on the live 99-service catalog, cheap to build with
the same design-rule pattern as our 4 existing services, and it doesn't
compete with anything we or the known competitor have already shipped.
Given the portal's real usage is still tiny (10 active agents, ~$6/week),
this is a "worth doing because it's a clean gap and low-cost," not a
"proven high-demand" pitch — no execution started, this is scoped only,
pending your go-ahead.

## §16 — media-utils built, 2026-09-26

You asked to go ahead and build the "agent media utilities" package
scoped in §15. It's done — `media-utils/` in this repo, following the
same pattern as the other four (`card.json`, `server.js`, `openapi.json`,
`package.json`, `test/`, `README.md`) — but **design and build only**,
same as this project's rule for every prior package: nothing is
registered, staked, or deployed without your explicit go-ahead in the
moment.

**What it does**, four REST endpoints:

- `POST /v1/pdf-render` — one page of a PDF → a PNG/JPEG image, via
  `poppler` (`pdftoppm`/`pdfinfo`). Synchronous, fast.
- `POST /v1/image-convert` — any-format image conversion, including real
  HEIC/HEVC photos (see below). Synchronous, fast.
- `POST /v1/audio-transcribe` + `POST /v1/audio-transcribe-status` — a
  submit/poll pair (not one synchronous call) via `whisper.cpp`, because a
  real transcription pass can't reliably finish inside a gateway relay
  timeout — the service-builder skill's own guidance for this exact
  situation.

**A real bug found and fixed before it could ship, not a hypothetical**:
the obvious npm-only way to handle HEIC (the `sharp` package) silently
fails to decode real iPhone photos — confirmed by fetching a real
HEVC-coded HEIC test file and running it through `sharp` directly:
`"Support for this compression format has not been built in"`. `sharp`'s
bundled codec build supports AVIF but not the HEVC codec real HEIC files
use, for licensing reasons — a well-documented but easy-to-miss limit of
the whole sharp/libvips ecosystem. The fix: install `libheif-examples`
plus the `libde265` HEVC plugin via apt (`heif-convert`, a system tool)
as a fallback path, used only when `sharp` fails on a file whose magic
bytes say HEIC/HEVC rather than AVIF. Verified for real, both ways,
against the same live test file, before writing it into the Dockerfile.
A second, subtler bug surfaced by the same real test rather than a mock:
`sharp`'s `.metadata()` call succeeds on a real HEIC file (it can read
container-level info without invoking the broken codec), so an earlier
version of the fallback logic that only wrapped `.metadata()` in
try/catch let the real decode failure escape uncaught. Fixed by wrapping
the whole decode-resize-encode pipeline, not just the metadata read.

**What was and wasn't verified for real, honestly, same standard as every
other package in this repo**: PDF rendering, image conversion (both the
native `sharp` path and the `heif-convert` HEIC fallback), and ffmpeg
audio normalization to 16kHz mono PCM WAV were all run for real, in this
build's own sandbox, against real files (a hand-built PDF, a real HEIC
fixture fetched live, a synthetic audio clip) — not mocked. `whisper.cpp`
itself could not be built/run here: its model files are hosted on
`huggingface.co`, which this sandbox's own network cannot reach (the same
restriction already documented elsewhere in this repo for
`*.pocket.network`). The transcription code was written against
`whisper.cpp`'s long-stable plain-text output format and degrades
honestly (`422 not_configured`, confirmed as the actual response here) if
the binary/model aren't present, rather than faking a transcript — but a
real clip should be run through it on whatever machine actually builds
the Docker image, before staking this endpoint. Full detail in
`media-utils/README.md`'s "Verification" section.

**Lint/validation, same toolkit as the other four**: `lint_backend.py`
against a locally running instance passes 5/5, including the card's own
embedded functional healthcheck probe (a tiny fixture PDF baked directly
into `card.json`, rendered and checked for the exact expected pixel
width). `validate_card.py` reports schema OK (one size warning, 6.0 KiB
against a 4 KiB soft target — consistent with all four existing cards,
which are also 4.7–5.3 KiB; hard limit is 256 KiB, no concern).
`npm audit` came back with a real finding worth knowing about even though
it's not this project's own bug: every `sharp` version through
`0.35.4-rc.0` has known libvips/libheif CVEs; pinned to `^0.35.4`
instead, which reports zero.

**What's still open before this could be registered**, none of it done
without your go-ahead: (1) a live catalog-conflict check for the service
ID `media-utils` on both networks (`check_catalog.py media-utils --both`
— not run yet, needs a live chain query this build did not perform,
per the service-builder skill's Rule 1); (2) building the actual Docker
image somewhere with real outbound network access (the `git clone` of
whisper.cpp and its model download need it — this build's own sandbox
could not do this step, same restriction as the transcription
verification above); (3) the usual registration/stake/relay-test sequence
from §5/§9/§11, same as the other four, each still gated on your explicit
approval at the time. No urgency on any of this — the contest submission
is already closed out; this is purely optional follow-on work.

## §17 — media-utils deployment plan, 2026-09-26

You asked to deploy media-utils and submit it as a 5th contest entry.
Here's the live-verified state and the exact ordered steps.

**Checked live just now, not assumed:**

- Catalog conflict check: `media-utils` returns `service ID not found` on
  **both** Beta and MainNet LCDs — free on both. (Full `check_catalog.py`
  wasn't run — no `pocketd` in this environment — but this is the same
  underlying query it makes; the only thing it adds is the near-duplicate
  name check, and §15's full 99-service/246-entry catalog audit already
  covered that ground for this exact niche.)
- Live params (Beta, re-fetched, not reused from memory):
  `add_service_fee` 1,000 POKT (unchanged), `supplier.min_stake` 59,500
  POKT (unchanged), `application.min_stake` 1,000 POKT (unchanged).
- `owner` balance: ~95,998 POKT — covers the 1,000 POKT registration fee
  many times over, no new funding needed.
- `operator` balance: ~39,999 POKT, current supplier stake 60,000 POKT
  serving the existing 4 services. **min_stake is a flat bond on the
  supplier account, not per-service** — adding media-utils to the same
  supplier does NOT require staking more POKT, just re-running
  `stake-supplier` with the updated 5-service list (already added to
  `deploy/supplier/supplier_stake_config.yaml`).
- The only account that needs fresh funding is a **new** test application
  for media-utils, since it doesn't exist yet — this is what the 100k
  faucet request is for.

**Files already updated/created, no approval needed for this part (no
transaction, just repo files)**:
`deploy/services/media-utils/backend/` (copy of the built package),
`deploy/services/media-utils/deploy/backend-compose.yaml`,
`deploy/supplier/relayer-config.yaml` (added the `media-utils:` backend
route), `deploy/supplier/supplier_stake_config.yaml` (added media-utils
to the services list), `deploy/supplier/Caddyfile` (comment-only, no
functional change — it already routes by signed relay envelope, not URL
path, so a 5th service needs nothing new there).

**Ordered steps from here, each still gated on your go-ahead at the time,
same as every prior step in this project:**

1. 🟦 **WSL** — generate a new keyring account for the test application:
   `pocketd keys add test-app-media-utils`. Tell me the resulting address
   (never the mnemonic) so I can request faucet funds for it.
2. Once I have that address: I'll submit the Beta faucet request for it
   myself (100k POKT, one request, no wallet connect needed) — you asked
   for this explicitly in this message, so I'll go ahead and do it via
   browser rather than asking you to also click it, then confirm back
   here with the before/after balance.
3. 🖥️ **Umbrel box terminal** — copy `deploy/services/media-utils/` to
   `/opt/pocket/services/media-utils/` (same as the other 4 — remember
   the box's copy is what actually runs; this repo's copy is the delivery
   vehicle, not a live sync) and `docker compose -p media-utils up -d --build`.
   This is the step that needs real outbound network for the Dockerfile's
   `git clone` of whisper.cpp and its model download — this box has that,
   this build sandbox didn't.
4. 🖥️ **Umbrel box terminal** — copy the updated `relayer-config.yaml` to
   the box's real supplier config path and restart the relayer container
   so it picks up the new `media-utils:` route.
5. 🟦 **WSL** — register the service:
   `pocketd tx service add-service media-utils "Agent Media Utilities" 10000 --card-file ./media-utils/card.json --from owner --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5`
   (burns 1,000 POKT from `owner`, needs your go-ahead in the moment, per
   this project's standing rule even though `owner`'s balance already
   covers it).
6. 🟦 **WSL** — re-stake the supplier with the updated 5-service config:
   `pocketd tx supplier stake-supplier --config ./supplier_stake_config.yaml --from operator --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5`
   (no new POKT locked, just an update — still your call, per the
   standing rule that nothing gets pushed to chain without it).
7. Wait one Beta session (~10-11 min) for the updated service list to
   activate.
8. 🟦 **WSL** — stake the new test application once faucet-funded:
   `pocketd tx application stake-application --service media-utils --from test-app-media-utils --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5`
   (locks ~1,000+ POKT from the freshly-faucet-funded address, your call).
9. Relay-test `/v1/pdf-render` and `/v1/image-convert` via `pocket-ap`,
   same method as the other 4 — both are synchronous, so this proves them
   the same way. `/v1/audio-transcribe` additionally needs one real real
   clip run through the deployed box (its whisper.cpp path was not
   verified in this build's own sandbox — see media-utils/README.md) —
   worth doing before calling this endpoint contest-ready, separate from
   the relay test itself.
10. Find and verify the Test Transaction ID (the `MsgCreateClaim`), same
    method as §11 for the other 4.
11. Submit the 5th Google Form response for media-utils, same form, same
    field order as `docs/contest-submission.md`.

Nothing beyond the catalog check, live param fetch, and file scaffolding
above has been executed yet — steps 1 onward need you, in the moment,
same as always.
