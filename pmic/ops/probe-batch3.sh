#!/bin/sh
# Live check of the batch 3 sources from the Pi, with the code in this folder and the Pi's .env,
# in a throwaway container: the running collector and its data are not touched, nothing is pushed.
# NVD without a key is slow on purpose (about 6 minutes); PatentsView needs PATENTSVIEW_API_KEY.
#   cd ~/pmic-src/pmic && git pull && sh ops/probe-batch3.sh
cd "$(dirname "$0")/.." || exit 1
ENV_FILE=.env
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/pmic-src/pmic/.env"
docker run --rm --env-file "$ENV_FILE" -v "$PWD":/app:ro -w /app pmic:latest node bin/probe.js --source treasury,fema,usgs,nws,cisa,cdc,patentsview,fred,openfda,nvd "$@" 2>&1 | tee /tmp/pmic-probe3.txt
echo "Saved to /tmp/pmic-probe3.txt"
