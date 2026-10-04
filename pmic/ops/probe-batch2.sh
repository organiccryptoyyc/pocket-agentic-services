#!/bin/sh
# Live check of the batch 2 sources from the Pi, with the code in this folder and the Pi's .env,
# in a throwaway container: the running collector and its data are not touched.
#   cd ~/pmic-src && git pull && cd pmic && sh ops/probe-batch2.sh
cd "$(dirname "$0")/.." || exit 1
docker run --rm --env-file .env -v "$PWD":/app:ro -w /app pmic:latest node bin/probe.js "$@" 2>&1 | tee /tmp/pmic-probe.txt
echo "Saved to /tmp/pmic-probe.txt"
