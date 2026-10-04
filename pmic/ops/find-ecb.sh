#!/bin/sh
# Lists the ECB series that could replace a stale key (default: euro area HICP inflation).
#   sh ~/pmic-probe/pmic/ops/find-ecb.sh
cd "$(dirname "$0")/.." || exit 1
docker run --rm -v "$PWD":/app:ro -w /app pmic:latest node bin/find-ecb.js "$@" 2>&1 | tee /tmp/pmic-find-ecb.txt
