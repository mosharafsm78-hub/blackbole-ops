import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation } from "convex/react"
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
      <NuportSync />
      <ConsolidateDuplicates />
    </div>
  )
}

/** Paste the order list read from Nuport; every matching order here gets Nuport's status. */
function NuportSync() {
  const sync = useAction(api.migrate.nuportSyncNow)
  const create = useMutation(api.migrate.nuportCreateOrders)
  const importCarts = useMutation(api.checkouts.importMany)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<any>(null)
  return (
    <div className="mt-5 space-y-3 rounded-lg border bg-card p-5" data-testid="nuport-sync">
      <div>
        <h2 className="font-semibold">Sync statuses from Nuport</h2>
        <p className="text-sm text-muted-foreground">While the team still works in Nuport, this makes our order statuses the same as Nuport's. Paste the Nuport order list (JSON) and press Sync.</p>
      </div>
      <textarea className="h-24 w-full rounded-md border bg-background p-2 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"bbNuportRows":[...]}' data-testid="nuport-sync-input" />
      <Button disabled={busy || !text.trim()} data-testid="nuport-sync-run" onClick={async () => {
        setBusy(true); setRes(null)
        try {
          const parsed = JSON.parse(text)
          if (parsed.bbNuportCreate) { setRes(await create({ rows: parsed.bbNuportCreate })); return }
          if (parsed.bbCarts) {
            let added = 0, skipped = 0
            for (let i = 0; i < parsed.bbCarts.length; i += 40) { const r = await importCarts({ rows: parsed.bbCarts.slice(i, i + 40) }); added += r.added; skipped += r.skipped }
            setRes({ created: [`${added} carts added`], skipped: skipped ? [`${skipped} already here`] : [] }); return
          }
          const rows = (parsed.bbNuportRows ?? parsed).map((r: any) => ({ inv: String(r.inv), shopify: r.shopify ?? null, phone: r.phone ?? null, cid: r.cid ?? null, status: String(r.status), nuport: String(r.nuport ?? "") }))
          setRes(await sync({ rows, dryRun: !!parsed.dryRun }))
        } catch (e) { setRes({ error: e instanceof Error ? e.message : String(e) }) } finally { setBusy(false) }
      }}>{busy ? "Syncing…" : "Sync"}</Button>
      {res && (
        <div className="space-y-2 text-sm" data-testid="nuport-sync-result">
          {res.error ? <p className="text-tone-red">{res.error}</p> : (
            <>
              {res.received !== undefined && <p><b>{res.received}</b> orders read from Nuport · <b>{res.alreadySame}</b> already the same · <b className="text-tone-green">{res.changed}</b> status changed · <b>{res.linked}</b> Pathao parcels linked · <b className="text-tone-amber">{res.unmatched?.length ?? 0}</b> not found here · <b className="text-tone-red">{res.errors?.length ?? 0}</b> errors</p>}
              {res.notSeen?.length > 0 && <p className="text-muted-foreground">{res.notSeen.length} open orders here were not in the Nuport list: {res.notSeen.slice(0, 60).map((x: any) => `${x.inv} (${x.status})`).join(", ")}</p>}
              {res.unmatched?.length > 0 && <p className="text-muted-foreground">Not found here: {res.unmatched.slice(0, 60).join(", ")}</p>}
              {res.renumbered > 0 && <p><b>{res.renumbered}</b> invoice numbers changed to Nuport's number</p>}
              {res.movedAside?.length > 0 && <p className="text-muted-foreground">Orders only in this app moved to a free number: {res.movedAside.join(", ")}</p>}
              {res.groupMismatch?.length > 0 && <p className="text-tone-amber">Different from Nuport: {res.groupMismatch.slice(0, 40).join(" · ")}</p>}
              {res.errors?.length > 0 && <p className="text-tone-red">{res.errors.slice(0, 20).join(" · ")}</p>}
              {res.dryRun && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-testid="nuport-sync-preview">{JSON.stringify(res, null, 1)}</pre>}
              {res.created && <p>Added: <b className="text-tone-green">{res.created.join(", ") || "none"}</b>{res.skipped?.length ? ` · skipped: ${res.skipped.join(", ")}` : ""}</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One-time repair: merges stock stranded on throwaway duplicate products (same name, ৳0 price, 1 SKU, no
 *  image — left behind when a product got "fixed" by recreating it instead of editing it) back onto the
 *  real, customer-facing product. Always run a dry run first and read the preview before applying. */
function ConsolidateDuplicates() {
  const run = useMutation(api.migrate.consolidateDuplicateProducts)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<any>(null)
  return (
    <div className="mt-5 space-y-3 rounded-lg border bg-card p-5" data-testid="consolidate-duplicates">
      <div>
        <h2 className="font-semibold">Merge duplicate-product stock</h2>
        <p className="text-sm text-muted-foreground">
          Finds throwaway duplicate products (same name, ৳0 price, usually 1 SKU, no photo) that are quietly
          holding real stock, moves every unit back onto the real product's matching size, and deactivates the
          empty duplicate. Run a dry run first — it changes nothing and just shows what it would move.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} data-testid="consolidate-dry-run" onClick={async () => {
          setBusy(true); setRes(null)
          try { setRes(await run({ dryRun: true })) } finally { setBusy(false) }
        }}>{busy ? "Checking…" : "Dry run (preview only)"}</Button>
        <Button
          disabled={busy || !res || res.dryRun === false}
          data-testid="consolidate-apply"
          onClick={async () => {
            if (!confirm(`This will actually move ${res.totalUnits} units across ${res.moves} stock rows. Continue?`)) return
            setBusy(true)
            try { setRes(await run({ dryRun: false })) } finally { setBusy(false) }
          }}
        >
          {busy ? "Applying…" : "Apply the fix"}
        </Button>
      </div>
      {res && (
        <div className="space-y-2 text-sm" data-testid="consolidate-result">
          <p>
            {res.dryRun ? "Would move " : "Moved "}
            <b className={res.dryRun ? "text-tone-amber" : "text-tone-green"}>{res.totalUnits}</b> units across{" "}
            <b>{res.moves}</b> stock rows
            {res.deactivated?.length > 0 && <> · deactivated <b>{res.deactivated.length}</b> empty duplicate product{res.deactivated.length === 1 ? "" : "s"}</>}
            .
          </p>
          {res.skipped?.length > 0 && (
            <p className="text-tone-amber">Needs a human look ({res.skipped.length}): {res.skipped.slice(0, 20).join(" · ")}</p>
          )}
          {res.sample?.length > 0 && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-testid="consolidate-preview">
              {res.sample.map((m: any) => `${m.product} · size ${m.size || "—"} · ${m.bucket} +${m.amount} → ${m.toSku} (from ${m.fromSku}, "${m.fromProduct}")`).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
