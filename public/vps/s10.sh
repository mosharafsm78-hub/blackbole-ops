#!/bin/bash
# BlackBole: copy settings (env vars) and data of both Marketing OS systems from Convex cloud to this VPS.
# The cloud is only READ (read-only keys). Run it again for the final copy just before switching.
set -u
W=/opt/convex/mos/work
clear
read -s -p "unlock password: " P; echo
mkdir -p $W && chmod 700 $W && cd $W
rm -f *.enc
for N in mos bbos; do
  wget -q -O $N-key.enc blackbole-ops.vercel.app/vps/$N-key.enc
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -in $N-key.enc -pass pass:$P -out $N-cloud-key || { echo "WRONG PASSWORD"; exit 1; }
  chmod 600 $N-cloud-key; cp /opt/convex/$N/admin-key $N-sh-key; chmod 600 $N-sh-key
done
unset P; rm -f *.enc
cat > run.sh <<'RUN'
set -u
cd /app
N=$1; C=$2
CLOUD="env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY CONVEX_DEPLOY_KEY=$(cat /work/$N-cloud-key)"
SELF="env -u CONVEX_DEPLOY_KEY CONVEX_SELF_HOSTED_URL=http://$C:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /work/$N-sh-key)"
echo; echo "######## $N ########"
echo ">> settings (env vars)"
names=$($CLOUD npx convex env list 2>>/work/$N-log.txt | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d '=')
n=0; f=0
for k in $names; do
  case $k in CONVEX_SITE_URL|CONVEX_CLOUD_URL) continue;; esac
  v=$($CLOUD npx convex env get "$k" 2>>/work/$N-log.txt)
  if $SELF npx convex env set -- "$k" "$v" >>/work/$N-log.txt 2>&1; then n=$((n+1)); else f=$((f+1)); echo "  could not set $k"; fi
done
echo "settings copied: $n, failed: $f"
echo ">> downloading data from cloud (read only)"
rm -f /work/$N-snap.zip
$CLOUD npx convex export --path /work/$N-snap.zip --include-file-storage >>/work/$N-log.txt 2>&1 && ls -la /work/$N-snap.zip || { echo "export FAILED"; tail -8 /work/$N-log.txt; exit 1; }
echo ">> loading data into the VPS"
$SELF npx convex import --replace-all -y /work/$N-snap.zip >>/work/$N-log.txt 2>&1 && echo ok || { echo "import FAILED"; tail -8 /work/$N-log.txt; exit 1; }
tail -3 /work/$N-log.txt
RUN
# pause the auto-update while copying
exec 9>/opt/convex/mos/.lock; flock 9
for T in mos:convex-mos bbos:convex-bbos; do
  docker run --rm --network shaperk -v /opt/convex/mos/repo:/app -v bb-mos-nodemodules:/app/node_modules -v $W:/work -w /app node:22 bash /work/run.sh ${T%%:*} ${T##*:}
done
rm -f $W/*-cloud-key $W/*-sh-key
echo; echo "memory:"; free -h | head -2
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep convex
echo "== DONE s10 ($(date -u +%H:%M) UTC) =="
