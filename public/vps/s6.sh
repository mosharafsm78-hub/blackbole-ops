#!/bin/bash
# BlackBole SWITCH, server side: final data copy from the cloud (read-only key), then LIVE mode
# (automatic jobs on) and an immediate deploy of the real code. The cloud itself is not changed here.
set -u
DIR=/opt/convex/ops; W=$DIR/work
clear
[ -s $W/cloud-key ] || { echo "cloud key missing"; exit 1; }
cat > $W/final.sh <<'RUN'
set -u
cd /work/code
CLOUD="env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY CONVEX_DEPLOY_KEY=$(cat /work/cloud-key)"
SELF="env -u CONVEX_DEPLOY_KEY CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /work/sh-key)"
echo ">> 1/2 final copy of all data from cloud"; rm -f /work/final.zip
$CLOUD npx convex export --path /work/final.zip --include-file-storage >>/work/log.txt 2>&1 && ls -la /work/final.zip || { echo "export FAILED"; tail -10 /work/log.txt; exit 1; }
echo ">> 2/2 loading it into the VPS (replaces the test copy)"
$SELF npx convex import --replace-all -y /work/final.zip >>/work/log.txt 2>&1 && echo ok || { echo "import FAILED"; tail -10 /work/log.txt; exit 1; }
tail -3 /work/log.txt
RUN
docker run --rm --network shaperk -v $W:/work -w /work node:22 bash /work/final.sh || { echo "STOPPED - nothing switched"; exit 1; }
echo ">> going LIVE: automatic jobs on"
touch $DIR/LIVE; rm -f $DIR/last-deployed
$DIR/autodeploy.sh; tail -3 /var/log/bb-ops-deploy.log
echo "== SERVER SIDE DONE $(date -u +%H:%M) UTC =="
