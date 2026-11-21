# Pocket Confidential (queue)

The Pocket side of the confidential decision layer. Customers and agents call this API through Pocket
Network (service ID `pocket-confidential`); the work runs in a PROOF Liskov job on Acurast that holds the
only decryption key. This server never sees plaintext input.

## Flow (protocol `pocket-confidential/0.1`)

1. `GET /v1/key`: the job's signed key announcement. Check the Ed25519 signature over the canonical
   (sorted-key) JSON of `announcement` with `job_ed25519_public_key`, and check `artifact_digest` and
   `policy_digest` against the published Liskov policy for application `app-de6e28366b387125fe2d51512a0d2b32`.
2. Seal the input to `encryption_public_key`: ephemeral X25519, HKDF-SHA256, AES-256-GCM. Add
   `input_commitment` = sha256(canonical(input) + salt). Keep the salt.
3. `POST /v1/submit {request}` returns `202 queued`.
4. `POST /v1/result {request_id}` until `status` is `done`. Verify the result: signed by the same job key,
   `evidence.input_commitment` equals yours, `evidence.output_hash` = sha256(canonical(result)).

Reference client and worker: the `pocket-confidential` worker repository (`src/protocol.ts`:
`verifyAnnouncement`, `encryptRequest`, `verifyResult`).

## Services

| `service` | Version | What it returns |
|---|---|---|
| `treasury-stress` | 0.2.0 | Mild and severe 30-day shocks against the customer's liquidity floor and limits, plus a `current` scenario: the mild set scaled by today's conditions from public Pocket signals (PMIC macro-regime and credit-stress; PMIC crypto-liquidity, stablecoin-supply and crypto-prices). Ranges, not exact figures, by default. |

### Live signals

The queue fetches those five scored briefs from our own PMIC services on the internal network (cached 30
minutes) and attaches the same bundle to every batch of sealed requests, so the signals reveal nothing about a
customer. The job lists each signal it used in the evidence (`signals_used`: id, as-of date, fetch time and the
brief's sha256). If fewer than two signals are fresh, the `current` scenario is left out and a gap says so.
Dossier exit liquidity and TCS-6 peer data would need the customer's tokens or entity, so they are not used.
`GET /v1/health` shows how many signals were usable at the last fetch.

`treasury-stress` input: `positions[]` (1-500; `class`: stable, major, alt, lp, own_token; `amount_usd`;
`liquid`; optional `lockup_days`), `liquidity_floor_usd`, optional `horizon_days` (default 30), `limits`
(`min_stable_share`, `max_single_share`), `scenarios` (custom shocks, -1 to 1 per class) and
`disclosure` (`range`, the default, or `exact`).

## Limits and honesty

- The signature proves which job key signed a result for a committed input. Tie that key to the Liskov
  runtime evidence for the deployment; the signature alone does not prove a TEE ran it. Hardware-backed
  confidentiality under the platform's threat model, not an absolute guarantee.
- Results are signed, not encrypted. Anyone holding a `request_id` can read its result for 24 hours, so keep
  it private.
- Requests up to 128 KiB; at most 1,000 pending; results kept 24 hours.
- Analysis only: not a recommendation to buy, sell or move assets.

## Ports

- `:8080` public API (behind the RelayMiner).
- `:8090` job API (`/job/keys`, `/job/requests`, `/job/results`), bearer token, private Caddy route only.

Tests: `node --test test/queue.test.js`.
