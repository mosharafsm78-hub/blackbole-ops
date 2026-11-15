#!/bin/bash
# Give heavy pages more time on the (slower, 1-CPU) VPS: query/mutation user-code limit 1s -> 5s.
# Restarts the Convex container once (~15s). Data is kept (volume).
set -u
cd /opt/convex/ops
clear
if ! grep -q DATABASE_UDF_USER_TIMEOUT_SECONDS docker-compose.yml; then
  sed -i 's#      - RUST_LOG=warn#      - RUST_LOG=warn\n      - DATABASE_UDF_USER_TIMEOUT_SECONDS=5#' docker-compose.yml
fi
grep -n "TIMEOUT" docker-compose.yml
docker compose up -d
sleep 10
docker ps --filter name=convex-ops --format '{{.Names}} {{.Status}}'
curl -s -m 10 https://ops-api.216-219-95-184.sslip.io/version; echo
echo "== done =="
