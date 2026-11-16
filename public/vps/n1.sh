#!/bin/bash
# NEW SERVER (Tencent Singapore) step 1: swap, Docker, Caddy, and a one-time key so it can copy from the old server.
set -u
clear
IP=$(curl -s -4 -m 10 https://api.ipify.org || curl -s -4 -m 10 ifconfig.me)
D=$(echo $IP | tr . -)
echo "new server ip: $IP"

# 2 GB emergency memory on disk
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
sysctl -q vm.swappiness=10; echo "vm.swappiness=10" > /etc/sysctl.d/99-bb.conf

echo "== installing docker (1-2 min) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq docker.io docker-compose-v2 git curl >/dev/null 2>&1
systemctl enable --now docker >/dev/null 2>&1
docker --version
docker network create shaperk >/dev/null 2>&1

# one-time key for copying from the old server (public part served over http for the old server to accept)
mkdir -p /root/.ssh /opt/caddy/keys && chmod 700 /root/.ssh
[ -f /root/.ssh/bbmove ] || ssh-keygen -q -t ed25519 -N "" -C bbmove -f /root/.ssh/bbmove
cp /root/.ssh/bbmove.pub /opt/caddy/keys/k.txt

cat > /opt/caddy/Caddyfile <<CADDY
http://$IP {
  root * /srv/keys
  file_server
}
ops-api.$D.sslip.io {
  reverse_proxy convex-ops:3210
}
ops-site.$D.sslip.io {
  reverse_proxy convex-ops:3211
}
CADDY
docker rm -f caddy >/dev/null 2>&1
docker run -d -q --name caddy --restart unless-stopped --network shaperk -p 80:80 -p 443:443 \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v /opt/caddy/keys:/srv/keys:ro \
  -v caddy_data:/data -v caddy_config:/config caddy:2 >/dev/null
sleep 4
docker ps --format '{{.Names}} {{.Status}}'
curl -s -m 5 http://$IP/k.txt | cut -c1-30
free -h | head -3
echo "== DONE n1 =="
echo "NEW SERVER CODE: $D"
