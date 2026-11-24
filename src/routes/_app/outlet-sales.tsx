import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Stat } from "@/components/bits"
import { ProductSearch } from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/outlet-sales")({
  component: () => (
    <Guard perm="orders.view">
      <OutletSalesPage />
    </Guard>
  ),
})

const dayStr = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
const startOf = (s: string) => new Date(`${s}T00:00:00`).getTime()
const endOf = (s: string) => new Date(`${s}T23:59:59.999`).getTime()

type Line = { variantId: Id<"variants">; label: string; sku: string; qty: number; unitPrice: number; available: number }

function OutletSalesPage() {
  const can = useCan()
  const locations = useQuery(api.team.listLocations)
  const outlets = (locations ?? []).filter((l) => l.isOutlet && l.active)
  const now = Date.now()
  const [from, setFrom] = useState(dayStr(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime()))
  const [to, setTo] = useState(dayStr(now))
  const [view, setView] = useState<string>("all") // all | online | <outletId>
  const range = { from: startOf(from), to: endOf(to) }
  const overview = useQuery(api.outlets.salesOverview, range)
  const sales = useQuery(api.outlets.listSales, { ...range, locationId: view !== "all" && view !== "online" ? (view as Id<"locations">) : undefined })
  const undo = useMutation(api.outlets.undoSale)

  const shown = view === "online" ? [] : (sales ?? [])
  const totalPairs = (overview?.online.pairs ?? 0) + (overview?.outlets.reduce((s, o) => s + o.pairs, 0) ?? 0)
  const totalAmount = (overview?.online.amount ?? 0) + (overview?.outlets.reduce((s, o) => s + o.amount, 0) ?? 0)

  return (
    <div className="space-y-5">
      <PageHeader title="Sales · online + outlets" sub="Online = parcels delivered in the dates (product value, without delivery fee). Outlets = sales typed in by the team.">
        <Input type="date" className="h-8 w-36" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" className="h-8 w-36" value={to} onChange={(e) => setTo(e.target.value)} />
      </PageHeader>

      {!overview || !locations ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="All sales" value={taka(totalAmount)} hint={`${totalPairs} pairs`} />
            <button type="button" className="text-left" onClick={() => setView("online")}><Stat label="Online" value={taka(overview.online.amount)} hint={`${overview.online.pairs} pairs · ${overview.online.orders} orders`} /></button>
            {overview.outlets.map((o) => (
              <button key={o.locationId} type="button" className="text-left" onClick={() => setView(o.locationId)}><Stat label={o.name} value={taka(o.amount)} hint={`${o.pairs} pairs`} /></button>
            ))}
            <Stat label="Pairs left at outlets" value={overview.outletStockLeft} />
          </div>
          {overview.truncated && <p className="text-xs text-tone-amber">Very large range — numbers may be incomplete. Pick fewer days.</p>}
          <div className="flex flex-wrap gap-2">
            {[["all", "All"], ["online", "Online"], ...overview.outlets.map((o) => [o.locationId, o.name])].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setView(k)} className={`rounded-full border px-3 py-1 text-xs ${view === k ? "border-foreground bg-foreground text-background" : "hover:bg-accent"}`}>{l}</button>
            ))}
          </div>
        </>
      )}

      {can("inventory.receive") && outlets.length > 0 && <RecordSale outlets={outlets.map((o) => ({ id: o._id, name: o.name }))} />}
      {can("inventory.receive") && locations && outlets.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No outlet yet. Add one in Settings → Warehouses → Add outlet.</p>}

      <section>
        <h2 className="mb-2 text-sm font-semibold">{view === "online" ? "Online sales are in Reports → Sales Report by Delivered" : "Outlet sales"}</h2>
        {view === "online" ? null : sales === undefined ? <Loading /> : shown.length === 0 ? <Empty title="No outlet sales in these dates" /> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="p-3 font-medium">Date</th><th className="p-3 font-medium">Outlet</th><th className="p-3 font-medium">Product</th><th className="p-3 text-right font-medium">Pairs</th><th className="p-3 text-right font-medium">Price</th><th className="p-3 text-right font-medium">Total</th><th className="p-3 font-medium">Entered by</th><th className="p-3" /></tr></thead>
              <tbody className="divide-y">
                {shown.map((s) => (
                  <tr key={s._id} className={s.undoneAt ? "text-muted-foreground line-through" : ""}>
                    <td className="whitespace-nowrap p-3 text-xs">{dateTime(s.soldAt)}</td>
                    <td className="p-3 text-xs">{s.locationName}</td>
                    <td className="p-3">{s.productName} <span className="text-muted-foreground">· {s.title}</span><div className="font-mono text-[11px] text-muted-foreground">{s.sku}{s.note ? ` · ${s.note}` : ""}</div></td>
                    <td className="p-3 text-right tabular-nums">{s.qty}</td>
                    <td className="p-3 text-right tabular-nums">{taka(s.unitPrice)}</td>
                    <td className="p-3 text-right tabular-nums">{taka(s.qty * s.unitPrice)}</td>
                    <td className="p-3 text-xs">{s.byName}</td>
                    <td className="p-3 text-right">{!s.undoneAt && can("inventory.receive") && (
                      <Button variant="ghost" size="xs" onClick={async () => { if (!confirm("Undo this sale? The pair goes back into the outlet's stock.")) return; try { await undo({ id: s._id }); toast.success("Sale undone") } catch (e) { toast.error(errMsg(e)) } }}>Undo</Button>
                    )}{s.undoneAt ? <span className="text-xs no-underline">undone</span> : null}</td>
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

function RecordSale({ outlets }: { outlets: { id: Id<"locations">; name: string }[] }) {
  const record = useMutation(api.outlets.recordSale)
  const [outletId, setOutletId] = useState<Id<"locations"> | undefined>(outlets[0]?.id)
  const [date, setDate] = useState(dayStr(Date.now()))
  const [note, setNote] = useState("")
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const pairs = lines.reduce((s, l) => s + l.qty, 0)
  const amount = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const outletId2 = useMemo(() => (outlets.some((o) => o.id === outletId) ? outletId : outlets[0]?.id), [outlets, outletId])
  return (
    <section className="grid gap-4 rounded-lg border bg-card p-4 lg:grid-cols-[1fr_1.2fr]" data-testid="outlet-record">
      <div className="flex h-[420px] flex-col gap-2">
        <h2 className="text-sm font-semibold">Record an outlet sale</h2>
        <div className="min-h-0 flex-1">
          <ProductSearch
            locationId={outletId2}
            onAdd={(p) => setLines((ls) => ls.some((l) => l.variantId === p.variantId) ? ls.map((l) => l.variantId === p.variantId ? { ...l, qty: Math.min(l.qty + 1, Math.max(1, l.available)) } : l) : [...ls, { variantId: p.variantId, label: `${p.name} · ${p.title}`, sku: p.sku, qty: 1, unitPrice: p.price, available: p.available }])}
          />
        </div>
      </div>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Outlet</Label>
            <Select value={outletId2} onValueChange={(v) => { setOutletId(v as Id<"locations">); setLines([]) }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{outlets.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Sale date</Label><Input type="date" value={date} max={dayStr(Date.now())} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></div>
        </div>
        {lines.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Search the shoe on the left and tap Add. Only pairs the outlet holds can be sold.</div> : (
          <div className="divide-y rounded-md border">
            {lines.map((l, i) => (
              <div key={l.variantId} className="flex flex-wrap items-center gap-2 p-2.5 text-sm">
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{l.label}</div><div className="text-xs text-muted-foreground">{l.sku} · {l.available} at outlet</div></div>
                <label className="flex items-center gap-1 text-xs">Pairs<Input type="number" className="h-8 w-16" value={l.qty} onChange={(e) => set(i, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /></label>
                <label className="flex items-center gap-1 text-xs">Price<Input type="number" className="h-8 w-24" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} /></label>
                <Button variant="ghost" size="icon-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between rounded-md bg-muted/60 p-3 text-sm"><span>{pairs} pairs</span><span className="font-semibold">{taka(amount)}</span></div>
        <Button className="w-full" disabled={busy || !outletId2 || pairs === 0} onClick={async () => {
          if (!outletId2) return
          setBusy(true)
          try {
            await record({ locationId: outletId2, soldAt: Math.min(startOf(date) + 12 * 3600_000, Date.now()), note: note || undefined, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice })) })
            toast.success(`${pairs} pair${pairs > 1 ? "s" : ""} recorded`)
            setLines([]); setNote("")
          } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
        }}>Save sale</Button>
      </div>
    </section>
  )
}
