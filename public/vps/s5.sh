#!/bin/bash
# BlackBole: automatic Ops code updates for the self-hosted Convex (like Vercel does for the cloud).
# Every 2 minutes: pull blackbole-ops (read-only deploy key), and if the code changed, deploy it here.
# TEST MODE (no automatic jobs) until /opt/convex/ops/LIVE exists. Safe to re-run.
set -u
DIR=/opt/convex/ops
clear
# 1. read-only GitHub deploy key (private part stays here; public part shown at a web path for adding to GitHub)
if [ ! -f $DIR/deploy_key ]; then ssh-keygen -q -t ed25519 -N "" -C "vps3758598-blackbole-ops" -f $DIR/deploy_key; fi
mkdir -p /var/lib/shaperk/public/.well-known/shaperk
cp $DIR/deploy_key.pub /var/lib/shaperk/public/.well-known/shaperk/bbops.txt
echo "public key published at http://216.219.95.184/.well-known/shaperk/bbops.txt"

# the public key folder over HTTPS too (browsers refuse plain http); only that folder is served
EXTRA=/opt/shaperk/caddy/extra.caddy
if ! grep -q "keys.216-219-95-184" $EXTRA; then
  printf '%s\n' "keys.216-219-95-184.sslip.io {" "  root * /srv/public/.well-known/shaperk" "  file_server" "}" >> $EXTRA
fi
echo "also at https://keys.216-219-95-184.sslip.io/bbops.txt (live within 2 minutes)"

# 2. the update script
cat > $DIR/autodeploy.sh <<'AD'
#!/bin/bash
set -u
DIR=/opt/convex/ops; REPO=$DIR/repo; LOG=/var/log/bb-ops-deploy.log
exec 9>$DIR/.lock; flock -n 9 || exit 0
export GIT_SSH_COMMAND="ssh -i $DIR/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d $REPO/.git ]; then git clone -q --depth 20 git@github.com:mosharafsm78-hub/blackbole-ops.git $REPO >>$LOG 2>&1 || { echo "$(date -u +%FT%TZ) clone failed (deploy key not added yet?)" >>$LOG; exit 0; }; fi
git -C $REPO fetch -q --depth 20 origin main >>$LOG 2>&1 || { echo "$(date -u +%FT%TZ) fetch failed" >>$LOG; exit 0; }
git -C $REPO reset -q --hard origin/main
SHA=$(git -C $REPO rev-parse --short HEAD)
MODE=test; [ -f $DIR/LIVE ] && MODE=live
[ "$(cat $DIR/last-deployed 2>/dev/null)" = "$SHA-$MODE" ] && exit 0
echo "$(date -u +%FT%TZ) deploying $SHA ($MODE)" >>$LOG
if [ $MODE = test ]; then
  printf '%s\n' '// TEST COPY on the VPS: no automatic jobs.' 'import { cronJobs } from "convex/server"' 'const crons = cronJobs()' 'export default crons' > $REPO/convex/crons.ts
fi
LOCKSUM=$(sha1sum $REPO/package-lock.json | cut -c1-12)
docker run --rm --network shaperk -v $REPO:/app -v bb-ops-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 -e LOCKSUM=$LOCKSUM node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    if [ "$(cat node_modules/.locksum 2>/dev/null)" != "$LOCKSUM" ]; then npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && echo $LOCKSUM > node_modules/.locksum; fi
    npx convex deploy --typecheck disable && node scripts/after-deploy.mjs' >>$LOG 2>&1
RC=$?
git -C $REPO checkout -q -- convex/crons.ts
if [ $RC = 0 ]; then echo "$SHA-$MODE" > $DIR/last-deployed; echo "$(date -u +%FT%TZ) deployed $SHA ($MODE) OK" >>$LOG; else echo "$(date -u +%FT%TZ) deploy $SHA FAILED" >>$LOG; fi
AD
chmod 700 $DIR/autodeploy.sh

# 3. run it every 2 minutes
cat > /etc/systemd/system/bb-ops-deploy.service <<UNIT
[Unit]
Description=BlackBole Ops: deploy new code to the self-hosted Convex
[Service]
Type=oneshot
ExecStart=$DIR/autodeploy.sh
UNIT
cat > /etc/systemd/system/bb-ops-deploy.timer <<UNIT
[Unit]
Description=BlackBole Ops code check every 2 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now bb-ops-deploy.timer >/dev/null 2>&1
systemctl is-active bb-ops-deploy.timer
echo "== done =="
