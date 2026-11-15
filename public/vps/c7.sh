#!/bin/bash
# read-only: last WhatsApp verify events (to see why a message failed)
clear
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    npx convex data waVerifyEvents --limit 2 --order desc 2>/dev/null | cut -c1-400'
echo "== DONE c7 =="
