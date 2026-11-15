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
echo '== DONE p1 =='
