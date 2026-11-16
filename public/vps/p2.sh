#!/bin/bash
# Ops auto-update: skip the (slow, CPU-heavy) redeploy when a commit changes no Ops code (e.g. only helper scripts)
clear
AD=/opt/convex/ops/autodeploy.sh
if ! grep -q "NOCODE" $AD; then
  python3 - "$AD" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
anchor='[ "$(cat $DIR/last-deployed 2>/dev/null)" = "$SHA-$MODE" ] && exit 0'
add='''LASTSHA=$(cut -d- -f1 $DIR/last-deployed 2>/dev/null)  # NOCODE: no Ops code changed -> nothing to deploy
if [ -n "$LASTSHA" ] && [ "$MODE" = live ] && git -C $REPO cat-file -e "$LASTSHA^{commit}" 2>/dev/null && [ -z "$(git -C $REPO diff --name-only $LASTSHA $SHA -- convex package.json package-lock.json scripts)" ]; then echo "$SHA-$MODE" > $DIR/last-deployed; exit 0; fi
'''
assert anchor in s
s=s.replace(anchor, add+anchor,1)
open(p,"w").write(s)
PY
fi
grep -c NOCODE $AD
bash -n $AD && echo "syntax ok"
grep -E "deployed|FAILED" /var/log/bb-ops-deploy.log | tail -2
echo "== DONE p2 =="
