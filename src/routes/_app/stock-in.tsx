import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Empty, PageHeader } from "@/components/bits"
import { ProductSearch } from "@/components/order-parts"
import { ProductBuilder } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/stock-in")({
  component: () => (
    <Guard perm="inventory.receive">
      <StockIn />
    </Guard>
  ),
})

type Line = { variantId: Id<"variants">; label: string; sku: string; qty: number; unitCost: number }

function StockIn() {
  const receive = useMutation(api.catalog.receiveStock)
  const locations = useQuery(api.team.listLocations)
  const receipts = useQuery(api.catalog.listReceipts)
  const [locationId, setLocationId] = useState<Id<"locations"> | undefined>()
  const [supplier, setSupplier] = useState("")
  const [note, setNote] = useState("")
  const [updateCost, setUpdateCost] = useState(true)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [builder, setBuilder] = useState(false)

  useEffect(() => {
    if (!locationId && locations?.length) setLocationId((locations.find((l) => l.isDefault) ?? locations[0])._id)
  }, [locations, locationId])

  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const totalCost = lines.reduce((s, l) => s + l.qty * l.unitCost, 0)

  return (
    <div className="space-y-6">
      <PageHeader title="Stock in" sub="Record products coming in from the factory or a supplier. Units go straight into Available." />
      <ProductBuilder
        open={builder}
        onOpenChange={setBuilder}
        onCreated={(created) => setLines((ls) => [
          ...ls,
          ...created
            .filter((c) => !ls.some((l) => l.variantId === c.variantId))
            .map((c) => ({ variantId: c.variantId, label: `${c.name} · ${c.title}`, sku: c.sku, qty: c.orderedQty, unitCost: c.unitCost })),
        ])}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <section className="flex h-[560px] flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Find products</h2>
            <Button size="sm" variant="outline" onClick={() => setBuilder(true)} data-testid="stockin-new-product"><Plus className="size-4" /> New product</Button>
          </div>
          <div className="min-h-0 flex-1">
            <ProductSearch
              locationId={locationId}
              onAdd={(p) => setLines((ls) => ls.some((l) => l.variantId === p.variantId) ? ls.map((l) => l.variantId === p.variantId ? { ...l, qty: l.qty + 1 } : l) : [...ls, { variantId: p.variantId, label: `${p.name} · ${p.title}`, sku: p.sku, qty: 1, unitCost: 0 }])}
            />
          </div>
        </section>
        <section className="space-y-4 rounded-lg border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Into warehouse</Label>
              <Select value={locationId} onValueChange={(v) => setLocationId(v as Id<"locations">)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{locations?.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Supplier / factory</Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Own factory, Batch 14" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Challan no., transport, etc." /></div>
          </div>
          {lines.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Add products from the left.</div>
          ) : (
            <div className="divide-y rounded-md border">
              {lines.map((l, i) => (
                <div key={l.variantId} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{l.label}</div><div className="text-xs text-muted-foreground">{l.sku}</div></div>
                  <label className="flex items-center gap-1 text-xs">Qty<Input type="number" className="h-8 w-20" value={l.qty} onChange={(e) => set(i, { qty: Math.max(0, Number(e.target.value) || 0) })} /></label>
                  <label className="flex items-center gap-1 text-xs">Unit cost<Input type="number" className="h-8 w-24" value={l.unitCost} onChange={(e) => set(i, { unitCost: Number(e.target.value) || 0 })} /></label>
                  <Button variant="ghost" size="icon-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="size-4" /></Button>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={updateCost} onCheckedChange={(v) => setUpdateCost(!!v)} /> Update each product's purchase cost to this unit cost</label>
          <div className="flex items-center justify-between rounded-md bg-muted/60 p-3 text-sm">
            <span>{totalQty} units</span><span className="font-semibold">{taka(totalCost)}</span>
          </div>
          <Button
            className="w-full" disabled={busy || !locationId || totalQty === 0}
            onClick={async () => {
              if (!locationId) return
              setBusy(true)
              try {
                const code = await receive({ locationId, supplier: supplier || undefined, note: note || undefined, updateCost, items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: l.unitCost })) })
                toast.success(`Saved GRN-${code}: ${totalQty} units added`)
                setLines([]); setNote(""); setSupplier("")
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Receive {totalQty || ""} units
          </Button>
        </section>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Recent stock-ins</h2>
        {!receipts ? null : receipts.length === 0 ? <Empty title="No stock received yet" /> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-3 font-medium">GRN</th><th className="p-3 font-medium">Date</th><th className="p-3 font-medium">Warehouse</th><th className="p-3 font-medium">Supplier</th><th className="p-3 font-medium">Items</th><th className="p-3 text-right font-medium">Units</th><th className="p-3 text-right font-medium">Cost</th><th className="p-3 font-medium">By</th></tr>
              </thead>
              <tbody className="divide-y">
                {receipts.map((r) => (
                  <tr key={r._id} className="align-top">
                    <td className="p-3 font-medium">GRN-{r.code}</td>
                    <td className="whitespace-nowrap p-3 text-xs">{dateTime(r.at)}</td>
                    <td className="p-3 text-xs">{r.locationName}</td>
                    <td className="p-3 text-xs">{r.supplier ?? "—"}{r.note ? <div className="text-muted-foreground">{r.note}</div> : null}</td>
                    <td className="p-3 text-xs">{r.items.map((i) => <div key={i.sku}>{i.qty} × {i.sku}</div>)}</td>
                    <td className="p-3 text-right tabular-nums">{r.totalQty}</td>
                    <td className="p-3 text-right tabular-nums">{taka(r.totalCost)}</td>
                    <td className="p-3 text-xs">{r.byName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
