#!/bin/bash
# THE SWITCH (run on the NEW server). ~4 minutes.
#  1. old server: Ops addresses answer "moving, back in 2 minutes" (webhooks retry later, nothing is lost)
#  2. final copy of all Ops data old -> new
#  3. new server goes LIVE (automatic jobs on)
#  4. old server: Ops addresses now pass everything to the new server; old Ops stopped (no double jobs)
# Any failure before step 4 puts the old server back exactly as it was.
set -u -o pipefail
OLD=216.219.95.184
S="ssh -i /root/.ssh/bbmove -o BatchMode=yes -o ConnectTimeout=15 root@$OLD"
DIR=/opt/convex/ops; W=$DIR/work
NEWAPI=ops-api.43-156-155-69.sslip.io; NEWSITE=ops-site.43-156-155-69.sslip.io
LOG=/root/switch.log
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a $LOG; }
clear

caddy_mode() { # maint | proxy | normal
  $S "python3 - $1" <<'PY'
import sys, re, subprocess
mode = sys.argv[1]
new = {'3210': 'ops-api.43-156-155-69.sslip.io', '3211': 'ops-site.43-156-155-69.sslip.io'}
def block(port):
    if mode == 'normal': return '  reverse_proxy convex-ops:%s\n' % port
    if mode == 'maint': return '  respond "BlackBole Ops is moving to a faster server. Back in 2 minutes." 503\n'
    return '  reverse_proxy https://%s {\n    header_up Host {upstream_hostport}\n  }\n' % new[port]
for p in ['/opt/shaperk/caddy/extra.caddy', '/opt/shaperk/caddy/Caddyfile']:
    s = open(p).read()
    for host, port in [('ops-api.216-219-95-184.sslip.io', '3210'), ('ops-site.216-219-95-184.sslip.io', '3211')]:
        s, n = re.subn(re.escape(host) + r' \{\n.*?\n\}\n', lambda m: host + ' {\n' + block(port) + '}\n', s, count=1, flags=re.S)
        if n != 1: print('block not found', host, p); sys.exit(1)
    open(p, 'w').write(s)
r = subprocess.run(['docker', 'exec', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], capture_output=True, text=True)
print('old router ->', mode, 'OK' if r.returncode == 0 else 'FAILED ' + r.stderr[-300:])
sys.exit(r.returncode)
PY
}
undo() { say "PROBLEM: $1 -> putting the old server back"; caddy_mode normal | tee -a $LOG
  if [ -f $DIR/LIVE ]; then rm -f $DIR/LIVE $DIR/last-deployed; $DIR/autodeploy.sh; tail -1 /var/log/bb-ops-deploy.log | tee -a $LOG; fi
  say "old server restored, nothing switched"; exit 1; }

say "== SWITCH START =="
$S true || { say "cannot reach old server"; exit 1; }
caddy_mode maint | tee -a $LOG || undo "router (maintenance)"

say "final export on old server"
$S "cat > /root/final-export.sh" <<'EX'
rm -f /opt/convex/ops/backups/final-switch.zip
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -v /opt/convex/ops/backups:/backups -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c 'export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key); npx convex export --path /backups/final-switch.zip --include-file-storage' >/root/final-export.log 2>&1
ls -l /opt/convex/ops/backups/final-switch.zip
EX
$S "bash /root/final-export.sh" | tee -a $LOG || undo "export"
rm -f $W/final.zip
$S "cat /opt/convex/ops/backups/final-switch.zip" > $W/final.zip
SZ=$(stat -c %s $W/final.zip 2>/dev/null || echo 0)
say "copied $SZ bytes"
[ "$SZ" -gt 1000000 ] || undo "copy too small"

say "loading data into new server"
docker run --rm --network shaperk -v $DIR/repo:/app -v bb-ops-nodemodules:/app/node_modules -v $DIR/admin-key:/admin-key:ro -v $W:/work -w /app node:22 bash -c '
  export CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
  npx convex import --replace-all -y /work/final.zip' >$W/import.log 2>&1 || { tail -5 $W/import.log | tee -a $LOG; undo "import"; }
tail -2 $W/import.log | tee -a $LOG

say "new server LIVE (automatic jobs on)"
touch $DIR/LIVE; rm -f $DIR/last-deployed
$DIR/autodeploy.sh
tail -1 /var/log/bb-ops-deploy.log | tee -a $LOG
grep -q "(live) OK" <(tail -1 /var/log/bb-ops-deploy.log) || undo "live deploy"

caddy_mode proxy | tee -a $LOG || undo "router (pass-through)"
say "stopping old Ops (Marketing OS on the old server keeps running)"
$S "systemctl disable --now bb-ops-deploy.timer >/dev/null 2>&1; rm -f /opt/convex/ops/LIVE; docker stop convex-ops >/dev/null; docker update --restart=no convex-ops >/dev/null; docker ps --format '{{.Names}}'" | tee -a $LOG

# backups on the new server: Ops only
sed -i '/^N2=mos/,$d' $DIR/backup.sh
echo 'ls -1t $DIR/backups/ops-*.zip 2>/dev/null | tail -n +8 | xargs -r rm -f' >> $DIR/backup.sh

say "checks:"
echo "new api:          $(curl -s -m 10 https://$NEWAPI/version)" | tee -a $LOG
echo "old address -> new: $(curl -s -m 15 -o /dev/null -w '%{http_code}' https://ops-site.216-219-95-184.sslip.io/)" | tee -a $LOG
free -h | head -2 | tee -a $LOG
say "== SWITCH DONE =="
