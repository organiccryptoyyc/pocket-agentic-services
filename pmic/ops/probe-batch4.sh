#!/bin/sh
# Live check of the batch 4 sources from the Pi, with the code in this folder and the Pi's .env,
# in a throwaway container: the running collector and its data are not touched, nothing is pushed.
# Covers the new collectors plus the batch 4 FRED (state labor, ISRATIO), BLS and openFDA device series.
#   cd ~/pmic-src/pmic && git pull && sh ops/probe-batch4.sh
cd "$(dirname "$0")/.." || exit 1
ENV_FILE=.env
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/pmic-src/pmic/.env"
docker run --rm --env-file "$ENV_FILE" -v "$PWD":/app:ro -w /app pmic:latest node bin/probe.js --source pokt,defillama,nifc,noaa,fbi,tsa,imf,fedreg,cms,secftd,bls,fred,openfda "$@" 2>&1 | tee /tmp/pmic-probe4.txt
echo "Saved to /tmp/pmic-probe4.txt"
