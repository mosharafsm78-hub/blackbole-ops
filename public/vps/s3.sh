#!/bin/bash
# BlackBole: install self-hosted Convex for Ops on this VPS, next to the Shopify apps.
# Safe to re-run. Touches only /opt/convex and ADDS two sites to the Caddyfile (backup kept, restored if invalid).
set -u
IP_DASH=216-219-95-184
API=ops-api.$IP_DASH.sslip.io
SITE=ops-site.$IP_DASH.sslip.io
DIR=/opt/convex/ops
CADDYFILE=/opt/shaperk/caddy/Caddyfile
clear
echo "== memory =="; echo "cpus: $(nproc)"; free -h | head -2

mkdir -p $DIR && cd $DIR
if [ ! -f .env ]; then
  echo "INSTANCE_SECRET=$(openssl rand -hex 32)" > .env
  chmod 600 .env
fi
cat > docker-compose.yml <<YML
services:
  backend:
    image: ghcr.io/get-convex/convex-backend:latest
    container_name: convex-ops
    restart: unless-stopped
    stop_grace_period: 20s
    volumes:
      - data:/convex/data
    environment:
      - INSTANCE_NAME=blackbole-ops
      - INSTANCE_SECRET=\${INSTANCE_SECRET}
      - CONVEX_CLOUD_ORIGIN=https://$API
      - CONVEX_SITE_ORIGIN=https://$SITE
      - DISABLE_BEACON=true
      - RUST_LOG=warn
    networks:
      - shaperk
networks:
  shaperk:
    external: true
volumes:
  data:
YML
echo "== starting convex (first time downloads the image, ~1-2 min) =="
# Pull anonymously: a saved (stale) registry login on this server makes ghcr.io answer "denied".
# The saved login itself is left alone - the Shopify apps may need it.
mkdir -p /tmp/anon-docker
DOCKER_CONFIG=/tmp/anon-docker docker pull -q ghcr.io/get-convex/convex-backend:latest
docker compose up -d
sleep 8
docker ps --filter name=convex-ops --format 'table {{.Names}}\t{{.Status}}'

echo "== web address (caddy) =="
if ! grep -q "$API" $CADDYFILE; then
  cp $CADDYFILE $CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)
  BAK=$(ls -t $CADDYFILE.bak-* | head -1)
  cat >> $CADDYFILE <<CADDY

$API {
  reverse_proxy convex-ops:3210
}
$SITE {
  reverse_proxy convex-ops:3211
}
CADDY
  if docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && echo "caddy: sites added"
  else
    cat $BAK > $CADDYFILE; echo "caddy: NEW CONFIG INVALID - restored the old one, nothing changed"
  fi
else
  echo "caddy: sites already there"
fi

echo "== admin key (kept on this server only, not shown) =="
if [ ! -s $DIR/admin-key ]; then
  docker exec convex-ops ./generate_admin_key.sh 2>/dev/null | tail -1 > $DIR/admin-key
  chmod 600 $DIR/admin-key
fi
[ -s $DIR/admin-key ] && echo "admin key saved in $DIR/admin-key" || echo "admin key NOT created yet"

echo "== test (waits for the https certificate, up to ~60s) =="
for i in $(seq 1 12); do
  v=$(curl -s -m 5 https://$API/version) && [ -n "$v" ] && break
  sleep 5
done
echo "https://$API/version -> ${v:-no answer yet}"
echo "== done =="
