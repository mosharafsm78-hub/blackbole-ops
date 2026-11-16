#!/bin/bash
# NEW SERVER step 2: copy Ops setup from the old server, start Convex, copy settings + data (TEST mode: no automatic jobs).
set -u
clear
OLD=216.219.95.184; OD=216-219-95-184
IP=$(curl -s -4 -m 10 https://api.ipify.org); D=$(echo $IP | tr . -)
DIR=/opt/convex/ops; W=$DIR/work
S="ssh -i /root/.ssh/bbmove -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 root@$OLD"
$S true || { echo "CANNOT REACH OLD SERVER (run x1 there first)"; exit 1; }
mkdir -p $DIR $W && chmod 700 $W && cd $DIR
for f in .env admin-key deploy_key deploy_key.pub docker-compose.yml autodeploy.sh backup.sh; do
  $S "cat /opt/convex/ops/$f" > $DIR/$f || echo "missing $f"
done
chmod 600 .env admin-key deploy_key; chmod 700 autodeploy.sh backup.sh
rm -f $DIR/LIVE $DIR/last-deployed
sed -i "s/$OD/$D/g" docker-compose.yml
echo "files copied: $(ls $DIR | tr '\n' ' ')"

echo "== starting convex (image download 1-2 min) =="
docker compose up -d --quiet-pull 2>&1 | tail -2
for i in $(seq 1 30); do v=$(curl -s -m 5 https://ops-api.$D.sslip.io/version) && [ -n "$v" ] && break; sleep 5; done
echo "https://ops-api.$D.sslip.io/version -> ${v:-NO ANSWER}"
[ -n "$v" ] || exit 1

echo "== getting code + tools (3-5 min) =="
export GIT_SSH_COMMAND="ssh -i $DIR/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
[ -d $DIR/repo/.git ] || git clone -q --depth 20 git@github.com:mosharafsm78-hub/blackbole-ops.git $DIR/repo
LOCKSUM=$(sha1sum $DIR/repo/package-lock.json | cut -c1-12)
cat > $W/copy.sh <<'RUN'
set -u
cd /app
if [ "$(cat node_modules/.locksum 2>/dev/null)" != "$LOCKSUM" ]; then npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && echo $LOCKSUM > node_modules/.locksum; fi
K=$(cat /admin-key)
OLDC="env CONVEX_SELF_HOSTED_URL=https://ops-api.216-219-95-184.sslip.io CONVEX_SELF_HOSTED_ADMIN_KEY=$K"
NEWC="env CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$K"
echo ">> settings"
n=0; f=0
for k in $($OLDC npx convex env list 2>/dev/null | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d '='); do
  v=$($OLDC npx convex env get "$k" 2>/dev/null)
  if $NEWC npx convex env set -- "$k" "$v" >/dev/null 2>&1; then n=$((n+1)); else f=$((f+1)); echo "  failed $k"; fi
done
echo "settings copied: $n failed: $f"
echo ">> data export from old server (2-6 min)"
rm -f /work/snap.zip
$OLDC npx convex export --path /work/snap.zip --include-file-storage >/work/log.txt 2>&1 && ls -la /work/snap.zip || { echo "EXPORT FAILED"; tail -8 /work/log.txt; exit 1; }
RUN
docker run --rm --network shaperk -v $DIR/repo:/app -v bb-ops-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -v $W:/work \
  -e LOCKSUM=$LOCKSUM node:22 bash /work/copy.sh || { echo "STOPPED"; exit 1; }

echo "== installing Ops code (test mode) =="
$DIR/autodeploy.sh; tail -2 /var/log/bb-ops-deploy.log

echo "== loading data =="
docker run --rm --network shaperk -v $DIR/repo:/app -v bb-ops-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -v $W:/work -w /app node:22 bash -c '
  export CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
  npx convex import --replace-all -y /work/snap.zip 2>&1 | tail -3'

echo "== timers: code updates every 2 min, backup nightly =="
cat > /etc/systemd/system/bb-ops-deploy.service <<U
[Unit]
Description=BlackBole Ops deploy
[Service]
Type=oneshot
ExecStart=$DIR/autodeploy.sh
U
cat > /etc/systemd/system/bb-ops-deploy.timer <<U
[Unit]
Description=BlackBole Ops code check
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
U
cat > /etc/systemd/system/bb-ops-backup.service <<U
[Unit]
Description=BlackBole Ops backup
[Service]
Type=oneshot
ExecStart=$DIR/backup.sh
U
cat > /etc/systemd/system/bb-ops-backup.timer <<U
[Unit]
Description=BlackBole Ops nightly backup
[Timer]
OnCalendar=*-*-* 22:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
U
mkdir -p $DIR/backups
systemctl daemon-reload
systemctl enable --now bb-ops-deploy.timer bb-ops-backup.timer >/dev/null 2>&1
systemctl list-timers --no-pager | grep bb-ops | wc -l
echo; free -h | head -3
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
echo "== DONE n2 =="
