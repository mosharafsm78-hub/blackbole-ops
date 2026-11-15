#!/bin/bash
# Daily backup of the Ops database (keeps the last 7), plus a quick health print.
set -u
DIR=/opt/convex/ops
REPO=$DIR/repo
mkdir -p $DIR/backups
cat > $DIR/backup.sh <<'BK'
#!/bin/bash
DIR=/opt/convex/ops
REPO=$DIR/repo
NAME=ops-$(date -u +%Y%m%d-%H%M).zip
docker run --rm --network shaperk -v $REPO:/app -v bb-ops-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -v $DIR/backups:/backups -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    npx convex export --path /backups/'"$NAME"' --include-file-storage' >>$DIR/backup.log 2>&1
if [ -s $DIR/backups/$NAME ]; then echo "$(date -u +%FT%TZ) backup $NAME OK $(du -h $DIR/backups/$NAME | cut -f1)" >>$DIR/backup.log
else echo "$(date -u +%FT%TZ) backup FAILED" >>$DIR/backup.log; fi
ls -1t $DIR/backups/ops-*.zip 2>/dev/null | tail -n +8 | xargs -r rm -f
BK
chmod 700 $DIR/backup.sh

cat > /etc/systemd/system/bb-ops-backup.service <<'U'
[Unit]
Description=BlackBole Ops daily backup
[Service]
Type=oneshot
ExecStart=/opt/convex/ops/backup.sh
U
cat > /etc/systemd/system/bb-ops-backup.timer <<'U'
[Unit]
Description=BlackBole Ops daily backup (04:30 Dhaka)
[Timer]
OnCalendar=*-*-* 22:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
U
systemctl daemon-reload
systemctl enable --now bb-ops-backup.timer >/dev/null 2>&1

echo "== running first backup now (1-3 min) =="
$DIR/backup.sh
tail -1 $DIR/backup.log
ls -lh $DIR/backups
echo "== health =="
echo "cpus: $(nproc)  ram: $(free -h | awk '/Mem/{print $2" total, "$7" free"}')  disk free: $(df -h / | awk 'NR==2{print $4}')"
grep -E "deployed|FAILED|pathao-webhook" /var/log/bb-ops-deploy.log | tail -3
systemctl list-timers --no-pager | grep bb-ops
echo "== DONE s8 =="
