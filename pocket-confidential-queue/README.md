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
| `covenant-monitor` | 0.1.0 | A watch on the same engine (Service 2). Nothing but `within_limits` while every limit holds; when one is crossed, only which limit, by how much (a band unless `exact`) and the weak public signals that drove it. Never positions, ids, amounts or the floor. |
| `counterparty-screen` | 0.1.0 | Service 3: screens names, wallets and domains against public U.S. screening lists inside the job; the answer is sealed to the customer's `reply_key`, so the queue sees neither the items nor the result. |
| `evidence-chain` | 0.1.0 | Service 4: the job fetches up to 8 https sources from the processor's own network (robots.txt honoured, honest user-agent, no private addresses) and returns an evidence packet sealed to `reply_key`: per source the redirect chain, HTTP status, retrieval time, SHA-256 of the exact bytes, title, and which of your claims appear (200-character excerpts); per claim, which sources agree and which differ, never resolved. The target sites see the requests; Pocket sees only ciphertext. |

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

### Counterparty screening (sealed answer)

`counterparty-screen` input: `items[]` (1-500; `type`: name, wallet or domain; `value`; optional `chain`,
`ref`), `reply_key` (a base64url X25519 public key you hold the private half of) and `match` (`standard`, the
default, or `broad`). The queue downloads the U.S. Consolidated Screening List (data.trade.gov) and the OFAC
SDN list (treasury.gov) every 12 hours, keeps only names, wallet addresses and websites, and gives the same
bundle to the job; `GET /v1/health` shows its date and fingerprint. The job matches your items inside itself
and encrypts the answer to `reply_key` (protocol `reply` envelope, AAD `reply|<request_id>`) before signing
it, so `POST /v1/result` returns `result.status: "sealed_for_customer"` and ciphertext only. Open it with
`openReply` in the worker repository's `src/protocol.ts`. The answer lists flagged items only (with the list
entry matched and why) and unflagged items as a count. Names match by their words (legal suffixes and word
order ignored); wallets and websites match exactly as OFAC lists them. No live lookups: nothing is sent to
any other server. A match is a lead for review, not a legal determination.

### Covenant monitor (watch)

`covenant-monitor` takes the `treasury-stress` input without `scenarios`, plus `watch` (one or more of
`current`, `mild`, `severe`; default `current`). Submit it once with `POST /v1/submit`. The queue keeps the
sealed request (it still cannot read it) and hands it back to the job each time the public signals refresh,
about every 30 minutes. `POST /v1/result` then returns `status: "watching"` and a `watch` object: number of
checks, last check time, `alert` (the first signed result that crossed a limit, kept even if the limit later
recovers) and `latest` (the newest signed check). Both verify like any result. The watch ends when the job key
it was sealed to changes (Liskov replaces the job at least every 24 hours, and on every release) or 24 hours
after submission: the status becomes `ended`; seal again to the current `GET /v1/key` to keep watching. Each
submit and each read is one paid relay; there is no subscription. If the signals are stale, a check says
`not_checked`, never `within_limits`.

## How to verify a result

1. **Signature.** Check the Ed25519 signature over `{result, evidence}` with
   `evidence.job_ed25519_public_key`, and that `evidence.input_commitment` matches the request you sealed.
2. **The key on chain.** Without a Liskov account, run PROOF's public recipe
   (<https://docs.proof.computer/liskov/operate/verify-job-keys>, script
   `examples/liskov-v1/verify-job-key` in <https://github.com/proof-computer/docs>) with
   `evidence.acurast_origin`, `evidence.acurast_job_id`, `evidence.job_ed25519_public_key` and
   `evidence.artifact_digest`. It checks on the Acurast chain that this job published that key, that the job
   ran that artifact, and that the processor presented a Google-rooted attestation when it joined Acurast.
   Acurast deletes a job's records about an hour after the job ends, so use an archive node (the script's
   default, `wss://archive.mainnet.acurast.com`); it finds the blocks from the job id.
3. **The build.** `artifact_digest` names the exact attested build; the signed key announcement from
   `GET /v1/key` carries the same digest. A new build means a new key.

## Witness re-check (TCS-6, phase 1, Beta)

A second, independent read of the chain for TCS-6 treasury reports. TCS-6 posts its verified on-chain holdings
as public claims (entity, chain, holder, token, quantity, observed time) to the internal peer API. The Liskov
job then, on its own:

- draws the sample: per entity, the 3 largest claims by value and 3 at random from the rest;
- finds the block at each claim's observed time and reads the balance there (`eth_getBalance`, or
  `balanceOf` and `decimals()` by `eth_call`) from **keyless Pocket public gateways fixed in the job's code**,
  so neither the queue nor TCS-6 can choose the node;
- labels each read `match` (within 0.5% at that block), `match_in_window` (within 0.5% ten minutes before or
  twenty after), `differs` or `unavailable` (never a guessed value), and gives each entity a verdict;
- signs the witness (schema `pocket-confidential-witness/0.1`) with the job key; it commits to the whole claim
  set by `claims_sha256`.

The queue accepts a witness only if it answers that task set, commits to exactly those claims and is signed by a
job key it holds a current announcement for. To check one yourself:

```
node tools/verify-witness.mjs witness.json --rpc ethereum=https://<your archive node>
```

It checks the signature, then repeats every read at the recorded block and requires the same block hash and the
same raw value. Then check the job key on chain as in step 2 above. A witness confirms that the sampled holdings
existed at those blocks; it does not confirm prices, control of the addresses, obligations or the score. The job
and the TCS-6 collector both read through Pocket gateways, so a gateway fault could affect both; `--rpc` with
your own node removes that.

## Limits and honesty

- The safe claim: a result is signed by the key that the attested Acurast processor published on chain for
  this job. The key is held by Acurast's processor app; it is **not hardware-attested**. The processor
  attestation covers the processor's account, not the job key.
- One key serves every job of the same release on the same processor. A new release is the rotation; nothing on
  chain revokes an old key.
- The policy digest is not on chain; today only Liskov can vouch for it.
- Confidentiality rests on the platform under its threat model; it is not an absolute guarantee.
- Results are signed, not encrypted. Anyone holding a `request_id` can read its result for 24 hours, so keep
  it private.
- Requests up to 128 KiB; at most 1,000 pending; results kept 24 hours.
- Analysis only: not a recommendation to buy, sell or move assets.

## Ports

- `:8080` public API (behind the RelayMiner).
- `:8090` job API (`/job/keys`, `/job/requests`, `/job/results`, `/job/witness`), bearer token, private Caddy
  route only.
- `:8091` peer API (`POST /peer/witness/tasks`, `GET /peer/witness/result?task_set_id=`), internal Docker
  network only: no Caddy route, no host port. Task sets are kept 7 days; at most 20 open.

Tests: `node --test test/queue.test.js`.
