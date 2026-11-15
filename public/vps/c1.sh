#!/bin/bash
# BlackBole VPS check (read-only): resources and what is already running. Changes nothing.
clear
echo "== cpu / memory / disk =="
echo "cpus: $(nproc)"; free -h | head -2; df -h / | tail -1
echo "== containers (name | image | status | ports | restart policy) =="
for c in $(docker ps -aq); do
  docker inspect -f '{{.Name}} | {{.Config.Image}} | {{.State.Status}} | {{range $p,$b := .NetworkSettings.Ports}}{{$p}} {{end}}| {{.HostConfig.RestartPolicy.Name}}' "$c"
done
echo "== compose projects =="
docker compose ls 2>/dev/null
echo "== proxy config files (caddy/nginx/traefik) =="
for c in $(docker ps -q); do
  docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' "$c"
done
echo "== done =="
