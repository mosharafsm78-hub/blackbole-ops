#!/bin/bash
# read-only: which Ops functions use the most time (60 seconds of logs)
clear
echo "collecting 60s of function logs..."
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    timeout 60 npx convex logs --success 2>/dev/null > /tmp/l.txt
    echo "lines: $(wc -l < /tmp/l.txt)"
    echo "== most calls =="
    grep -oE "\[CONVEX [QMAH]\([^)]*\)\]" /tmp/l.txt | sort | uniq -c | sort -rn | head -12
    echo "== failures/timeouts =="
    grep -iE "timed out|timeout|error" /tmp/l.txt | grep -oE "\[CONVEX [QMAH]\([^)]*\)\].{0,60}" | sort | uniq -c | sort -rn | head -6
  '
echo "== DONE c9 =="
