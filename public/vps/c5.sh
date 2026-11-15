#!/bin/bash
# Read-only: how shaperk builds the Caddyfile. Changes nothing.
clear
cd /opt/shaperk/repo
echo "== repo =="; git remote -v 2>/dev/null | head -2; git log --oneline -3 2>/dev/null
echo "== apply.sh caddy part =="; grep -n -i -B2 -A12 "caddy" bin/apply.sh | head -60
echo "== caddy files in repo =="; find . -iname "*caddy*" -not -path "./node_modules/*" 2>/dev/null | head
echo "== done =="
