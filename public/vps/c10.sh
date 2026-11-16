#!/bin/bash
# read-only: Ops function time per minute (which functions eat the CPU)
clear
grep -E "deployed|FAILED" /var/log/bb-ops-deploy.log | tail -2
echo "collecting 60s..."
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    timeout 60 npx convex logs --jsonl 2>/dev/null > /tmp/l.jsonl
    node -e "
      const L=require(\"fs\").readFileSync(\"/tmp/l.jsonl\",\"utf8\").split(\"\n\").filter(Boolean);
      const m={}; let n=0;
      for (const x of L){ let j; try{j=JSON.parse(x)}catch{continue}; const p=j.udfPath||j.identifier||j.function||\"?\"; const t=Number(j.executionTime??j.execution_time??0); const e=j.error||j.success===false; if(!m[p])m[p]={n:0,t:0,err:0}; m[p].n++; m[p].t+=t; if(e)m[p].err++; n++ }
      console.log(\"events\",n, \"keys\", L[0]?Object.keys(JSON.parse(L[0])).join(\",\").slice(0,200):\"\");
      Object.entries(m).sort((a,b)=>b[1].t-a[1].t).slice(0,14).forEach(([p,v])=>console.log(String(Math.round(v.t*1000)/1000).padStart(8),\"s\",String(v.n).padStart(4),\"x\",v.err?\"ERR\"+v.err:\"\",p))
    "'
echo "== DONE c10 =="
