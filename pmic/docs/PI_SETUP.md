# Deploying PMIC on the Raspberry Pi 5 / Umbrel

Run these on the Pi itself, over SSH from your computer's terminal. Each block can be pasted as is.

## 1. Connect to the Pi

```bash
ssh umbrel@umbrel.local        # Umbrel; on Raspberry Pi OS it is usually pi@raspberrypi.local
```

## 2. Make sure Docker is there

```bash
docker --version
```

Umbrel already has it. If the command is not found (plain Raspberry Pi OS):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
exit                           # then ssh back in
```

## 3. Get the code

Until the PR is merged the code lives on the `market-intel-collector` branch.

```bash
git clone -b market-intel-collector https://github.com/organiccryptoyyc/pocket-agentic-services.git ~/pmic-src
cd ~/pmic-src/pmic
```

## 4. Settings

```bash
cp .env.example .env
openssl rand -hex 32           # copy the output: this is your PMIC_API_TOKEN
nano .env
```

Fill in at least:

- `PMIC_SEC_USER_AGENT=PMIC your-email@example.com` (SEC requires a name and contact email)
- `BEA_API_KEY=` a free key from https://apps.bea.gov/API/signup/ (arrives by email; leave blank for now if you do not have it, BEA is skipped until it is set)
- `PMIC_API_TOKEN=` the value from `openssl rand -hex 32`

Optional, same day or later: `FRED_API_KEY` (https://fredaccount.stlouisfed.org/apikeys), `BLS_API_KEY` (https://data.bls.gov/registrationEngine/), `OPENFDA_API_KEY` (https://open.fda.gov/apis/authentication/).
Leave `PMIC_PUSH_URL` and `PMIC_PUSH_TOKEN` empty until the hub on the Pocket server exists.

Save in nano with Ctrl+O, Enter, then Ctrl+X.

## 5. Start it

```bash
docker compose up -d --build
docker logs -f pmic-collector  # watch the first pass; Ctrl+C stops watching, not the collector
```

The first pass backfills about a year of history and takes a few minutes (SEC is paced at under 10 requests a second).

## 6. Check it

```bash
export T=<your PMIC_API_TOKEN>
curl -s localhost:8088/v1/health
curl -s -H "Authorization: Bearer $T" -d '{}' localhost:8088/v1/sources
curl -s -H "Authorization: Bearer $T" -d '{}' localhost:8088/v1/alerts
curl -s -H "Authorization: Bearer $T" -d '{"series_id":"fred:UNRATE"}' localhost:8088/v1/signal
```

`/v1/health` should show `"ready":true` and `scored_series` in the hundreds. Paste the `/v1/alerts`
output into the PMIC thread: any `schema_change` or `api_failure` there is something to fix.
`missing_key` just means a key is not set yet.

## Day to day

- It restarts on its own after a reboot (`restart: unless-stopped`).
- Update to new code: `cd ~/pmic-src && git pull && cd pmic && docker compose up -d --build`
- Stop: `docker compose down` (data stays in the `pmic-data` volume).
- CSV export: `docker exec pmic-api node bin/export.js scores > scores.csv`
