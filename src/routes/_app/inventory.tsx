import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { whTone } from "@/lib/warehouse"

export const Route = createFileRoute("/_app/inventory")({
  component: () => (
    <Guard perm="orders.view">
      <InventoryPage />
    </Guard>
  ),
})

function InventoryPage() {
  const can = useCan()
  const locations = useQuery(api.team.listLocations)
  const [loc, setLoc] = useState<string>("all")
  const data = useQuery(api.catalog.inventory, { locationId: loc === "all" ? undefined : (loc as Id<"locations">) })
  const logs = useQuery(api.catalog.stockLogs, { locationId: loc === "all" ? undefined : (loc as Id<"locations">) })
  const [q, setQ] = useState("")
  const [only, setOnly] = useState<"all" | "low" | "short">("all")
  const [adjust, setAdjust] = useState<{ variantId: Id<"variants">; label: string } | null>(null)

  const rows = useMemo(() => {
    if (!data) return []
    const t = q.trim().toLowerCase()
    return data.rows
      .filter((r) => !t || r.sku.toLowerCase().includes(t) || `${r.productName} ${r.title}`.toLowerCase().includes(t))
      .filter((r) => only === "all" || (only === "low" ? r.available >= 0 && r.available <= 2 : r.available < 0))
  }, [data, q, only])

  return (
    <div>
      <PageHeader title="Inventory" sub="Available = ready to sell. Processing = reserved by approved orders. In transit = with the courier.">
        <Select value={loc} onValueChange={setLoc}>
          <SelectTrigger size="sm" className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All warehouses</SelectItem>
            {locations?.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </PageHeader>
      <Tabs defaultValue="stock">
        <TabsList className="mb-3">
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="logs">Movements</TabsTrigger>
        </TabsList>
        <TabsContent value="stock">
          {data === undefined || data === null ? <Loading /> : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Available units" value={data.totals.available} />
                <Stat label="Shortage" value={data.totals.shortage} tone={data.totals.shortage ? "red" : undefined} hint="approved beyond stock" />
                <Stat label="Processing" value={data.totals.processing} />
                <Stat label="In transit" value={data.totals.inTransit} />
                <Stat label="Stock value (MRP)" value={taka(data.totals.stockValue)} />
                <Stat label="Stock cost" value={taka(data.totals.costValue)} />
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search SKU or product" className="max-w-xs" />
                {(["all", "low", "short"] as const).map((k) => (
                  <Button key={k} size="sm" variant={only === k ? "default" : "outline"} onClick={() => setOnly(k)}>
                    {k === "all" ? "All" : k === "low" ? "Low (0–2)" : "Shortage"}
                  </Button>
                ))}
              </div>
              {rows.length === 0 ? <Empty title="Nothing to show">Add products, then record goods with Stock in.</Empty> : (
                <div className="overflow-x-auto rounded-lg border bg-card">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="p-3 font-medium">SKU</th><th className="p-3 font-medium">Product</th><th className="p-3 font-medium">Warehouse</th>
                        <th className="p-3 text-right font-medium">Available</th><th className="p-3 text-right font-medium">Processing</th>
                        <th className="p-3 text-right font-medium">In transit</th><th className="p-3 text-right font-medium">Returning</th>
                        <th className="p-3 text-right font-medium">Damaged</th><th className="p-3 text-right font-medium">Value</th><th className="p-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((r) => (
                        <tr key={r._id} className="hover:bg-muted/30">
                          <td className="p-3 font-mono text-xs">{r.sku}</td>
                          <td className="p-3">{r.productName} <span className="text-muted-foreground">· {r.title}</span></td>
                          <td className="p-3">
                            <div className="flex flex-wrap gap-1">
                              {r.wh.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : r.wh.map((w) => (
                                <span key={w.name} className={cn("whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold", whTone(w.name))}>{w.name}{r.wh.length > 1 || loc === "all" ? ` · ${w.available}` : ""}</span>
                              ))}
                            </div>
                          </td>
                          <td className={cn("p-3 text-right font-semibold tabular-nums", r.available < 0 ? "text-tone-red" : r.available <= 2 ? "text-tone-amber" : "")}>{r.available}</td>
                          <td className="p-3 text-right tabular-nums">{r.processing}</td>
                          <td className="p-3 text-right tabular-nums">{r.inTransit}</td>
                          <td className="p-3 text-right tabular-nums">{r.returning}</td>
                          <td className="p-3 text-right tabular-nums">{r.damaged}</td>
                          <td className="p-3 text-right tabular-nums">{taka(Math.max(0, r.stockValue))}</td>
                          <td className="p-3 text-right">
                            {can("inventory.adjust") && loc !== "all" && (
                              <Button variant="ghost" size="xs" onClick={() => setAdjust({ variantId: r._id, label: `${r.sku} — ${r.productName} ${r.title}` })}>Adjust</Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {can("inventory.adjust") && loc === "all" && <p className="mt-2 text-xs text-muted-foreground">Pick a warehouse above to adjust stock.</p>}
            </>
          )}
        </TabsContent>
        <TabsContent value="logs">
          {!logs ? <Loading /> : logs.length === 0 ? <Empty title="No stock movements yet" /> : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr><th className="p-3 font-medium">When</th><th className="p-3 font-medium">SKU</th><th className="p-3 font-medium">Warehouse</th><th className="p-3 font-medium">Bucket</th><th className="p-3 text-right font-medium">Change</th><th className="p-3 font-medium">Reason</th><th className="p-3 font-medium">By</th></tr>
                </thead>
                <tbody className="divide-y">
                  {logs.map((l) => (
                    <tr key={l._id}>
                      <td className="whitespace-nowrap p-3 text-xs">{dateTime(l.at)}</td>
                      <td className="p-3 font-mono text-xs">{l.sku}</td>
                      <td className="p-3 text-xs"><span className={cn("whitespace-nowrap rounded-md px-1.5 py-0.5 font-semibold", whTone(l.locationName))}>{l.locationName}</span></td>
                      <td className="p-3 text-xs">{l.bucket}</td>
                      <td className={cn("p-3 text-right font-medium tabular-nums", l.change > 0 ? "text-tone-green" : "text-tone-red")}>{l.change > 0 ? `+${l.change}` : l.change}</td>
                      <td className="p-3 text-xs">{l.reason}{l.note ? ` — ${l.note}` : ""}</td>
                      <td className="p-3 text-xs">{l.byName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
      {adjust && loc !== "all" && <AdjustDialog target={adjust} locationId={loc as Id<"locations">} onClose={() => setAdjust(null)} />}
    </div>
  )
}

function AdjustDialog({ target, locationId, onClose }: { target: { variantId: Id<"variants">; label: string }; locationId: Id<"locations">; onClose: () => void }) {
  const adjustStock = useMutation(api.catalog.adjustStock)
  const [bucket, setBucket] = useState<"available" | "damaged">("available")
  const [change, setChange] = useState(0)
  const [note, setNote] = useState("")
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Adjust stock</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{target.label}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Bucket</Label>
            <Select value={bucket} onValueChange={(v) => setBucket(v as "available" | "damaged")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="available">Available</SelectItem><SelectItem value="damaged">Damaged</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Change (+ add, − remove)</Label><Input type="number" value={change} onChange={(e) => setChange(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Reason</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Stock count correction, found 2 pairs" /></div>
        </div>
        <DialogFooter>
          <Button
            disabled={!change || !note.trim()}
            onClick={async () => {
              try { await adjustStock({ variantId: target.variantId, locationId, bucket, change, note }); toast.success("Stock adjusted"); onClose() } catch (e) { toast.error(errMsg(e)) }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
