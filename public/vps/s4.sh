#!/bin/bash
# BlackBole: copy Ops (code in TEST mode, settings, data) from Convex cloud to the VPS Convex.
# The cloud is only READ (read-only key). Nothing is sent to customers: the test copy has no automatic jobs.
set -u
DIR=/opt/convex/ops; W=$DIR/work
clear
read -s -p "unlock password: " P; echo
mkdir -p $W && chmod 700 $W && cd $W
rm -rf code snap.zip log.txt run.sh
wget -q -O code.enc blackbole-ops.vercel.app/vps/code.enc
wget -q -O key.enc blackbole-ops.vercel.app/vps/key.enc
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -in code.enc -pass pass:$P -out code.tgz || { echo "WRONG PASSWORD (code)"; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -a -in key.enc -pass pass:$P -out cloud-key || { echo "WRONG PASSWORD (key)"; exit 1; }
chmod 600 cloud-key; unset P
mkdir code && tar -xzf code.tgz -C code && rm -f code.tgz code.enc key.enc
cp $DIR/admin-key sh-key && chmod 600 sh-key
cat > run.sh <<'RUN'
set -u
cd /work/code
CLOUD="env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY CONVEX_DEPLOY_KEY=$(cat /work/cloud-key)"
SELF="env -u CONVEX_DEPLOY_KEY CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /work/sh-key)"
step() { echo; echo ">> $1"; }
step "1/5 installing tools (2-4 min)"
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error >/work/log.txt 2>&1 && echo ok || { echo "npm FAILED"; tail -5 /work/log.txt; exit 1; }
step "2/5 copying settings (env vars) from cloud"
names=$($CLOUD npx convex env list 2>>/work/log.txt | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d '=')
n=0; f=0
for k in $names; do
  v=$($CLOUD npx convex env get "$k" 2>>/work/log.txt)
  if $SELF npx convex env set -- "$k" "$v" >>/work/log.txt 2>&1; then n=$((n+1)); else f=$((f+1)); echo "  could not set $k"; fi
done
echo "settings copied: $n, failed: $f"
step "3/5 installing Ops code (test mode, no automatic jobs)"
$SELF npx convex deploy --typecheck disable >>/work/log.txt 2>&1 && echo ok || { echo "deploy FAILED"; tail -15 /work/log.txt; exit 1; }
step "4/5 downloading a copy of all data from cloud (read only)"
$CLOUD npx convex export --path /work/snap.zip --include-file-storage >>/work/log.txt 2>&1 && ls -la /work/snap.zip || { echo "export FAILED"; tail -15 /work/log.txt; exit 1; }
step "5/5 loading the data into the VPS"
$SELF npx convex import --replace-all -y /work/snap.zip >>/work/log.txt 2>&1 && echo ok || { echo "import FAILED"; tail -15 /work/log.txt; exit 1; }
tail -4 /work/log.txt
echo; echo "== ALL DONE =="
RUN
docker run --rm --network shaperk -v $W:/work -w /work node:22 bash /work/run.sh
echo "(finished $(date -u +%H:%M) UTC)"
