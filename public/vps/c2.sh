#!/bin/bash
# BlackBole VPS check 2 (read-only): web server config and docker networks. Changes nothing.
clear
echo "== Caddyfile =="; cat /opt/shaperk/caddy/Caddyfile
echo "== caddy networks =="; docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}} {{end}}' caddy
echo "== docker0 =="; ip -4 addr show docker0 | grep inet
echo "== /opt =="; ls /opt /opt/shaperk
echo "== firewall =="; ufw status 2>/dev/null | head -5
echo "== done =="
