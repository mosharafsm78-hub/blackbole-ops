#!/bin/bash
# Read-only: who rewrites the Caddyfile? Changes nothing.
clear
F=/opt/shaperk/caddy/Caddyfile
echo "== caddyfile now (sites) =="; grep -n "sslip\|{" $F | head -20
echo "== backups =="; ls -la /opt/shaperk/caddy/
echo "== who writes it (scripts/services/timers mentioning Caddyfile) =="
grep -rl "Caddyfile" /opt/shaperk/src /opt/shaperk/repo /etc/systemd /etc/cron* 2>/dev/null | grep -v node_modules | head -15
systemctl list-timers --all --no-pager 2>/dev/null | grep -i -v "^$" | head -15
crontab -l 2>/dev/null | head -10
echo "== done =="
