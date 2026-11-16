#!/bin/bash
# OLD SERVER: allow the new server (only its IP) to copy Ops files over SSH. Usage: bash x1.sh 43-1-2-3
set -u
clear
N=${1:-}; [ -n "$N" ] || { echo "give the new server code"; exit 1; }
IP=$(echo $N | tr - .)
K=$(curl -s -m 10 http://$IP/k.txt)
echo "$K" | grep -q '^ssh-ed25519 .* bbmove$' || { echo "key not found at http://$IP/k.txt"; exit 1; }
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
sed -i '/ bbmove$/d' /root/.ssh/authorized_keys
echo "from=\"$IP\" $K" >> /root/.ssh/authorized_keys
echo "key added for $IP"
systemctl is-active ssh 2>/dev/null || systemctl is-active sshd
sshd -T 2>/dev/null | grep -E '^(permitrootlogin|pubkeyauthentication|port) '
ufw status 2>/dev/null | head -3
echo "== DONE x1 =="
