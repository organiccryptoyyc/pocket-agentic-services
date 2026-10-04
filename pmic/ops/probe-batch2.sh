#!/bin/sh
# Live check of the batch 2 sources from the Pi, with the code in this folder and the Pi's .env,
# in a throwaway container: the running collector and its data are not touched, nothing is pushed.
#   git clone -q -b pmic-batch2-phase2 https://github.com/organiccryptoyyc/pocket-agentic-services.git ~/pmic-probe && sh ~/pmic-probe/pmic/ops/probe-batch2.sh
cd "$(dirname "$0")/.." || exit 1
ENV_FILE=.env
[ -f "$ENV_FILE" ] || ENV_FILE="$HOME/pmic-src/pmic/.env"
docker run --rm --env-file "$ENV_FILE" -v "$PWD":/app:ro -w /app pmic:latest node bin/probe.js "$@" 2>&1 | tee /tmp/pmic-probe.txt
echo "Saved to /tmp/pmic-probe.txt"
