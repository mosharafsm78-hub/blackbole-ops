#!/bin/bash
# patch the Marketing OS auto-update so it ignores convex.json (cloud forwarder setting)
clear
AD=/opt/convex/mos/autodeploy.sh
if ! grep -q "rm -f \$REPO/convex.json" $AD; then
  sed -i 's#^  LOCKSUM=\$(sha1sum#  rm -f $REPO/convex.json\n  LOCKSUM=$(sha1sum#' $AD
  sed -i 's#^  git -C \$REPO checkout -q -- convex/crons.ts#  git -C $REPO checkout -q -- convex/crons.ts convex.json 2>/dev/null#' $AD
fi
echo "auto-update patched: $(grep -c 'convex.json' $AD) lines"
tail -3 /var/log/bb-mos-deploy.log | cut -c1-150
# 2 GB swap as a safety buffer for memory (only if there is none yet)
if [ "$(swapon --show | wc -l)" = "0" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-bb-swap.conf
fi
free -h | head -3
echo '== DONE p1 =='
