import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/_app/import")({
  component: () => (
    <Guard perm="team.manage">
      <ImportPage />
    </Guard>
  ),
})

type Bundle = { products?: any[]; stock?: any[]; customers?: any[]; orders?: any[] }

async function readFile(f: File): Promise<Bundle> {
  if (f.name.endsWith(".gz")) {
    const stream = f.stream().pipeThrough(new DecompressionStream("gzip"))
    return JSON.parse(await new Response(stream).text())
  }
  return JSON.parse(await f.text())
}

const STEPS: { kind: keyof Bundle; size: number }[] = [
  { kind: "products", size: 100 },
  { kind: "stock", size: 100 },
  { kind: "customers", size: 300 },
  { kind: "orders", size: 40 },
]

function ImportPage() {
  const issueKey = useMutation(api.migrate.issueKey)
  const clearKey = useMutation(api.migrate.clearKey)
  const [bundle, setBundle] = useState<Bundle>({})
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const add = (line: string) => setLog((l) => [...l, line])
  const [manual, setManual] = useState<{ key: string; url: string } | null>(null)

  async function run() {
    setBusy(true)
    setLog([])
    try {
      const { key, url } = await issueKey({})
      const post = async (kind: string, rows?: any[]) => {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, kind, rows }) })
          const json = await res.json().catch(() => ({}))
          if (res.ok) return json
          if (attempt >= 2) throw new Error(`${kind}: ${json.error ?? res.status}`)
        }
      }
      add(`Setup: ${JSON.stringify(await post("setup"))}`)
      for (const step of STEPS) {
        const rows = bundle[step.kind] ?? []
        if (!rows.length) continue
        const total: Record<string, number> = {}
        for (let i = 0; i < rows.length; i += step.size) {
          const r = await post(step.kind, rows.slice(i, i + step.size))
          for (const [k, n] of Object.entries(r)) if (typeof n === "number") total[k] = (total[k] ?? 0) + n
          setLog((l) => [...l.filter((x) => !x.startsWith(`${step.kind} `)), `${step.kind} ${Math.min(i + step.size, rows.length)}/${rows.length} ${JSON.stringify(total)}`])
        }
      }
      add(`Finalize: ${JSON.stringify(await post("finalize"))}`)
      add("Done ✓")
    } catch (e) {
      add(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      await clearKey({}).catch(() => {})
      setBusy(false)
    }
  }

  const counts = STEPS.map((s) => `${s.kind}: ${bundle[s.kind]?.length ?? 0}`).join(" · ")

  return (
    <div className="max-w-3xl">
      <PageHeader title="Data import" sub="Load products, stock, customers and orders exported from Nuport. Safe to run again — existing records are updated, not duplicated." />
      <div className="space-y-4 rounded-lg border bg-card p-5">
        <input
          type="file"
          multiple
          accept=".json,.gz"
          data-testid="import-files"
          onChange={async (e) => {
            const merged: Bundle = { ...bundle }
            for (const f of Array.from(e.target.files ?? [])) {
              const b = await readFile(f)
              for (const s of STEPS) if (b[s.kind]) merged[s.kind] = [...(merged[s.kind] ?? []), ...b[s.kind]!]
            }
            setBundle(merged)
          }}
        />
        <p className="text-sm text-muted-foreground">{counts}</p>
        <Button onClick={run} disabled={busy}>{busy ? "Importing…" : "Start import"}</Button>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={async () => setManual(await issueKey({}))}>Create import key</Button>
          {manual && <Button variant="outline" size="sm" onClick={async () => { await clearKey({}); setManual(null) }}>Turn import off</Button>}
          {manual && <code className="break-all text-xs" data-testid="import-key" data-url={manual.url}>{manual.key}</code>}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs" data-testid="import-log">{log.join("\n")}</pre>
      </div>
    </div>
  )
}
