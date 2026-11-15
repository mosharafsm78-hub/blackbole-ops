#!/bin/bash
# read-only check of the Marketing OS web addresses
clear
echo "== extra.caddy (last lines) =="; tail -14 /opt/shaperk/caddy/extra.caddy
echo "== in live Caddyfile: $(grep -c 'mos-api\|bbos-api' /opt/shaperk/caddy/Caddyfile) =="
for h in mos-api bbos-api ops-api; do echo "$h -> $(curl -s -m 8 https://$h.216-219-95-184.sslip.io/version)"; done
echo "== caddy log =="; docker logs --since 10m caddy 2>&1 | grep -iE 'mos|bbos|error' | tail -6 | cut -c1-220
echo "== sync log =="; journalctl -u shaperk-sync --since "10 min ago" --no-pager 2>/dev/null | tail -5 | cut -c1-200
echo "== mos deploy log =="; tail -5 /var/log/bb-mos-deploy.log 2>/dev/null | cut -c1-200
echo "== DONE c6 =="
