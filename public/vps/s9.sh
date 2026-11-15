#!/bin/bash
# BlackBole: install two more self-hosted Convex backends for Marketing OS on this VPS.
#   convex-mos  = BlackBole's private Marketing OS   (mos-api / mos-site)
#   convex-bbos = the BlackBole OS product for sale   (bbos-api / bbos-site)
# Plus a read-only GitHub deploy key for blackbole-marketing-os and an auto-update every 2 minutes
# (TEST MODE: no automatic jobs until /opt/convex/<name>/LIVE exists). Safe to re-run. Ops is not touched.
set -u
IP=216-219-95-184
IMG=$(grep -o 'image: .*' /opt/convex/ops/docker-compose.yml | head -1 | cut -d' ' -f2)
EXTRA=/opt/shaperk/caddy/extra.caddy
clear
echo "== memory before =="; free -h | head -2

install_one() { # name container instance
  local N=$1 C=$2 I=$3 DIR=/opt/convex/$1
  mkdir -p $DIR && cd $DIR
  [ -f .env ] || { echo "INSTANCE_SECRET=$(openssl rand -hex 32)" > .env; chmod 600 .env; }
  cat > docker-compose.yml <<YML
services:
  backend:
    image: $IMG
    container_name: $C
    restart: unless-stopped
    stop_grace_period: 20s
    volumes:
      - data:/convex/data
    environment:
      - INSTANCE_NAME=$I
      - INSTANCE_SECRET=\${INSTANCE_SECRET}
      - CONVEX_CLOUD_ORIGIN=https://$N-api.$IP.sslip.io
      - CONVEX_SITE_ORIGIN=https://$N-site.$IP.sslip.io
      - DISABLE_BEACON=true
      - RUST_LOG=warn
      - DATABASE_UDF_USER_TIMEOUT_SECONDS=5
    networks:
      - shaperk
networks:
  shaperk:
    external: true
volumes:
  data:
YML
  docker compose up -d >/dev/null 2>&1
  sleep 6
  if [ ! -s $DIR/admin-key ]; then
    docker exec $C ./generate_admin_key.sh 2>/dev/null | tail -1 > $DIR/admin-key; chmod 600 $DIR/admin-key
  fi
  [ -s $DIR/admin-key ] && echo "$C running, admin key saved" || echo "$C: admin key NOT created"
  if ! grep -q "$N-api.$IP" $EXTRA; then
    printf '%s\n' "$N-api.$IP.sslip.io {" "  reverse_proxy $C:3210" "}" "$N-site.$IP.sslip.io {" "  reverse_proxy $C:3211" "}" >> $EXTRA
  fi
}
echo "== installing =="
install_one mos convex-mos blackbole-mos
install_one bbos convex-bbos blackbole-os

# read-only deploy key for the Marketing OS repo (public part published for adding to GitHub)
K=/opt/convex/mos/deploy_key
[ -f $K ] || ssh-keygen -q -t ed25519 -N "" -C "vps3758598-blackbole-marketing-os" -f $K
cp $K.pub /var/lib/shaperk/public/.well-known/shaperk/bbmos.txt
echo "deploy key: https://keys.$IP.sslip.io/bbmos.txt"

# auto-update: one clone, deployed to both backends
cat > /opt/convex/mos/autodeploy.sh <<'AD'
#!/bin/bash
set -u
REPO=/opt/convex/mos/repo; LOG=/var/log/bb-mos-deploy.log
exec 9>/opt/convex/mos/.lock; flock -n 9 || exit 0
export GIT_SSH_COMMAND="ssh -i /opt/convex/mos/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d $REPO/.git ]; then git clone -q --depth 20 git@github.com:mosharafsm78-hub/blackbole-marketing-os.git $REPO >>$LOG 2>&1 || { echo "$(date -u +%FT%TZ) clone failed (deploy key not added yet?)" >>$LOG; exit 0; }; fi
git -C $REPO fetch -q --depth 20 origin main >>$LOG 2>&1 || { echo "$(date -u +%FT%TZ) fetch failed" >>$LOG; exit 0; }
git -C $REPO reset -q --hard origin/main
SHA=$(git -C $REPO rev-parse --short HEAD)
for T in mos:convex-mos bbos:convex-bbos; do
  N=${T%%:*}; C=${T##*:}; DIR=/opt/convex/$N
  MODE=test; [ -f $DIR/LIVE ] && MODE=live
  [ "$(cat $DIR/last-deployed 2>/dev/null)" = "$SHA-$MODE" ] && continue
  echo "$(date -u +%FT%TZ) $N deploying $SHA ($MODE)" >>$LOG
  if [ $MODE = test ]; then
    printf '%s\n' '// TEST COPY on the VPS: no automatic jobs.' 'import { cronJobs } from "convex/server"' 'const crons = cronJobs()' 'export default crons' > $REPO/convex/crons.ts
  fi
  LOCKSUM=$(sha1sum $REPO/package-lock.json | cut -c1-12)
  docker run --rm --network shaperk -v $REPO:/app -v bb-mos-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -w /app \
    -e CONVEX_SELF_HOSTED_URL=http://$C:3210 -e LOCKSUM=$LOCKSUM node:22 bash -c '
      export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
      if [ "$(cat node_modules/.locksum 2>/dev/null)" != "$LOCKSUM" ]; then npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && echo $LOCKSUM > node_modules/.locksum; fi
      npx convex deploy --typecheck disable' >>$LOG 2>&1
  RC=$?
  git -C $REPO checkout -q -- convex/crons.ts
  if [ $RC = 0 ]; then echo "$SHA-$MODE" > $DIR/last-deployed; echo "$(date -u +%FT%TZ) $N deployed $SHA ($MODE) OK" >>$LOG; else echo "$(date -u +%FT%TZ) $N deploy $SHA FAILED" >>$LOG; fi
done
AD
chmod 700 /opt/convex/mos/autodeploy.sh
cat > /etc/systemd/system/bb-mos-deploy.service <<UNIT
[Unit]
Description=BlackBole Marketing OS: deploy new code to the self-hosted Convex
[Service]
Type=oneshot
ExecStart=/opt/convex/mos/autodeploy.sh
UNIT
cat > /etc/systemd/system/bb-mos-deploy.timer <<UNIT
[Unit]
Description=BlackBole Marketing OS code check every 2 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now bb-mos-deploy.timer >/dev/null 2>&1

# backups for both (added to the nightly Ops backup)
for N in mos bbos; do
  if ! grep -q "convex-$N" /opt/convex/ops/backup.sh; then
    cat >> /opt/convex/ops/backup.sh <<BK
# $N
N2=$N-\$(date -u +%Y%m%d-%H%M).zip
docker run --rm --network shaperk -v /opt/convex/mos/repo:/app -v bb-mos-nodemodules:/app/node_modules -v /opt/convex/$N/admin-key:/admin-key:ro -v \$DIR/backups:/backups -w /app \\
  -e CONVEX_SELF_HOSTED_URL=http://convex-$N:3210 node:22 bash -c 'export CONVEX_SELF_HOSTED_ADMIN_KEY=\$(cat /admin-key); npx convex export --path /backups/'"\$N2" >>\$DIR/backup.log 2>&1 && echo "\$(date -u +%FT%TZ) backup \$N2 OK" >>\$DIR/backup.log
ls -1t \$DIR/backups/$N-*.zip 2>/dev/null | tail -n +8 | xargs -r rm -f
BK
  fi
done

echo "== test (https certificates, up to ~2 min) =="
sleep 20
for N in mos bbos; do
  for i in $(seq 1 12); do v=$(curl -s -m 5 https://$N-api.$IP.sslip.io/version) && [ -n "$v" ] && break; sleep 5; done
  echo "$N-api -> ${v:-no answer yet}"
done
echo "== memory after =="; free -h | head -2
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep convex
echo "== DONE s9 =="
