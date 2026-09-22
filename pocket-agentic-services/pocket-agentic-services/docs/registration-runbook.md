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

## 4. Keyring and funding (you do this; I never see the keys)

You need, per network you register on:

- One **owner** key — the account that registers services and receives
  supplier revenue. Can be the same for all 4 services.
- One **operator** key — the RelayMiner's signing key. Can be the same
  operator for all 4 services (one supplier stack serves many services).
- One **application** test key **per service** — an application stakes for
  exactly one service, so testing all 4 needs 4 app accounts.

```bash
pocketd keys add owner
pocketd keys add operator
pocketd keys add test-app-pokt-network-intel
pocketd keys add test-app-rpc-quality-intel
pocketd keys add test-app-agent-trust
pocketd keys add test-app-wallet-defi-intel
```

Fund every account (Beta only — MainNet has no faucet):

```bash
pocketd faucet fund upokt <owner-address> --network=beta
pocketd faucet fund upokt <operator-address> --network=beta
pocketd faucet fund upokt <test-app-...-address> --network=beta   # x4
```

or the web faucet: https://faucet.beta.pocket.network/

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

**Before you run these**: each card's `specs[].url` points at
`raw.githubusercontent.com/organiccryptoyyc/pocket-agentic-services/main/...`.
That repo needs to exist and be pushed *first*, or the spec URL 404s the
moment anyone (a gateway, a judge) tries to fetch it. Registering with a
dead spec URL isn't wrong on-chain, but it's the kind of thing worth fixing
before rather than after judging opens — say the word when you're ready to
handle the GitHub side and I'll prepare the exact push-ready file tree the
same way we've done for `alpha1`.

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

## Quick reference: what blocks what

1. GitHub repo pushed → spec URLs resolve → safe to register (§5).
2. §5 registration → §6 verify → §9 supplier stake needs a registered
   service to list.
3. §9 stake → one session wait → §11 app stake + relay → this is what
   produces the "test tx ID" and live endpoint URL the contest form (task
   #16) needs.
4. None of §9, §11, or the MainNet repeat happen without your explicit
   go-ahead in this chat, per the standing rule for this whole project.
