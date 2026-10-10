# PMIC hub on the Hetzner server

The hub runs on the same Hetzner server as prediction-market-intel and treasury-capital-score
(PSM server `hetzner-mainnet`, `agentic.organiccryptoyyc.com`). It is deployed through Pocket
Service Manager (PSM) the same way as TCS-6. It costs no POKT and needs no chain
transaction. It is not a paid service, so there is nothing to register or stake.

What it does: the Pi pushes its data to the hub after every pass, and the service packs read the
hub over the server's private `pocket-supplier` network.

## 1. Build the PSM folder (PowerShell, your PC)

In the folder where you keep `pocket-agentic-services`:

```powershell
git fetch origin market-intel-collector
git checkout market-intel-collector
git pull
node pmic/ops/package-psm.js
```

This creates `Downloads\pmic-hub` (with a `service.json`, so PSM lists it) and prints these lines:

- `pi_push_url`, needed in step 3
- where the token is kept: `pmic\.secrets\hub.env`. Open it with `notepad pmic\.secrets\hub.env`;
  the `PMIC_INGEST_TOKEN` value is the Pi's push token. Keep it private
- `packs_hub_url`, used later by the service packs

The tokens are saved in `pmic\.secrets\hub.env` (never committed). If you run the command again,
it keeps the same tokens.

## 2. Deploy it in PSM (MainNet tab, server `hetzner-mainnet`)

1. Open **Services → Deploy service**.
2. Choose **Service** `pmic-hub` and **Server** `hetzner-mainnet`, then click **Deploy**. The route
   `/pmic-ingest → 8091` comes from `deploy/routes.json` in the folder.

Never use Register service, Suppliers or Stake for `pmic-hub`. The hub is not a relay backend.

Check on the server (Hetzner SSH):

```bash
docker ps --filter name=pmic-hub
docker exec pmic-hub-backend wget -qO- http://localhost:8080/v1/health
```

The health check shows `"role":"hub"`. Its `series` count stays at 0 until the Pi pushes.

## 3. Point the Pi at the hub (SSH to muttb)

```bash
cd ~/pmic-src && git pull && cd pmic
nano .env
```

Set these two lines, using the values from step 1:

```
PMIC_PUSH_URL=https://agentic.organiccryptoyyc.com/pmic-ingest/ingest/sync
PMIC_PUSH_TOKEN=<pi_push_token>
```

Save with Ctrl+O, Enter, Ctrl+X. Then push the year of history once, without waiting for the
next pass:

```bash
docker compose up -d --build
docker exec pmic-collector node bin/collect.js --push
```

## 4. Check the data arrived (Hetzner SSH)

```bash
docker exec pmic-hub-backend wget -qO- http://localhost:8080/v1/health
```

`series` and `scored_series` should now be about 312, and `last_sync` should show the time of the
push. After this the Pi pushes on its own after every pass.

## 5. Price bank replica (TCS-6 Build B, optional)

1. On the Pi: `cd ~/tcs6-pi-collector && sh ops/pricebank-setup.sh`. It prints the bank's **public** key.
2. On the PC: add the line `PRICEBANK_PUBLIC_KEY=<that key>` to `pmic\.secrets\hub.env`, run
   `node pmic/ops/package-psm.js` (its output says `pricebank_public_key: "set"`), and redeploy `pmic-hub`
   in PSM (Deploy service only; never register or stake).
3. The next pushing collector run on the Pi logs `pricebank replica: {"pushed": true, ...}`.

