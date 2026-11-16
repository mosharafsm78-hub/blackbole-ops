#!/bin/bash
# read-only: 2 minutes of Ops function activity while the team works
clear
uptime
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | grep convex
echo "collecting 120s..."
docker run --rm --network shaperk -v /opt/convex/ops/repo:/app -v bb-ops-nodemodules:/app/node_modules -v /opt/convex/ops/admin-key:/admin-key:ro -w /app \
  -e CONVEX_SELF_HOSTED_URL=http://convex-ops:3210 node:22 bash -c '
    export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /admin-key)
    timeout 120 npx convex logs --jsonl 2>/dev/null > /tmp/l.jsonl
    node -e "
      const L=require(\"fs\").readFileSync(\"/tmp/l.jsonl\",\"utf8\").split(\"\n\").filter(Boolean);
      const m={}; let n=0, cached=0, tot=0;
      for (const x of L){ let j; try{j=JSON.parse(x)}catch{continue}; if(j.kind&&j.kind!==\"Completion\"&&j.kind!==\"completion\"&&j.executionTime===undefined)continue; const p=(j.udfType||\"\")[0]+\" \"+(j.identifier||\"?\"); const t=Number(j.executionTime||0); if(j.cachedResult)cached++; const m2=m[p]||(m[p]={n:0,t:0,err:0,max:0}); m2.n++; m2.t+=t; m2.max=Math.max(m2.max,t); if(j.error)m2.err++; n++; tot+=t }
      console.log(\"executions\",n,\"cached\",cached,\"total sec\",tot.toFixed(1));
      Object.entries(m).sort((a,b)=>b[1].t-a[1].t).slice(0,22).forEach(([p,v])=>console.log(v.t.toFixed(1).padStart(7)+\"s\",String(v.n).padStart(4)+\"x\",\"max\"+v.max.toFixed(1)+\"s\",v.err?\"ERR\"+v.err:\"\",p))
    "'
uptime
echo "== DONE c11 =="
