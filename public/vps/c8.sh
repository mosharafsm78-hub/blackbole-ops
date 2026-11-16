#!/bin/bash
# read-only health check: why is the server slow?
clear
echo "== load (1/5/15 min) & uptime =="; uptime
echo "== memory =="; free -m | head -3
echo "== top cpu =="; ps -eo pcpu,pmem,rss,etime,comm --sort=-pcpu | head -8
echo "== containers =="; docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'
echo "== deploys last 3h =="; grep -h "deploy" /var/log/bb-ops-deploy.log /var/log/bb-mos-deploy.log 2>/dev/null | tail -6 | cut -c1-90
echo "== running node containers =="; docker ps --filter ancestor=node:22 --format '{{.Names}} {{.RunningFor}}'
echo "== vmstat (5s) =="; vmstat 1 5 | tail -3
echo "== DONE c8 =="
