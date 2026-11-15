#!/bin/bash
# BlackBole: SWITCH both Marketing OS systems to this VPS (run after the cloud builds turned the cloud into forwarders).
#  1. auto-update deploys the real code (removes convex.json, which points cloud builds at the forwarder)
#  2. final copy of settings + data from the cloud (read only)
#  3. LIVE: automatic jobs on, redeploy now
#  4. Ops sends its product updates straight to the VPS Marketing OS
set -u
W=/opt/convex/mos/work
clear
AD=/opt/convex/mos/autodeploy.sh
if ! grep -q "rm -f \$REPO/convex.json" $AD; then
  sed -i 's#^  LOCKSUM=\$(sha1sum#  rm -f $REPO/convex.json\n  LOCKSUM=$(sha1sum#' $AD
  sed -i 's#^  git -C \$REPO checkout -q -- convex/crons.ts#  git -C $REPO checkout -q -- convex/crons.ts convex.json 2>/dev/null#' $AD
fi
echo "auto-update patched: $(grep -c 'convex.json' $AD) lines"

# 2. final copy (same as s10)
wget -q -O /root/s10.sh blackbole-ops.vercel.app/vps/s10.sh && bash /root/s10.sh || { echo "COPY FAILED - not switching"; exit 1; }

# 3. live
touch /opt/convex/mos/LIVE /opt/convex/bbos/LIVE
rm -f /opt/convex/mos/last-deployed /opt/convex/bbos/last-deployed
echo "deploying live code (2-4 min)..."
$AD
grep -E "deployed|FAILED" /var/log/bb-mos-deploy.log | tail -4

# 4. Ops -> Marketing OS address
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    npx convex env set MARKETING_OS_URL https://mos-site.216-219-95-184.sslip.io >/dev/null 2>&1 && echo "Ops: MARKETING_OS_URL set" || echo "Ops: MARKETING_OS_URL FAILED"'
echo; free -h | head -2
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep convex
echo "== DONE s11 =="
