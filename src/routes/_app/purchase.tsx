import { useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, ChevronDown, FileText, Pencil, Paperclip, PackageCheck, Plus, Printer, Search, Trash2, Truck, Upload, Wallet } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { PO_STATUS_LABEL, SUPPLIER_PAY_METHODS } from "@/convex/rules"
import { Guard, useCan, Perm } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { POStatus, ProductBuilder, SupplierDialog, UploadList, poCode, type POLine } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateOnly, dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/purchase")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "new") }),
  component: () => (
    <Guard perm="inventory.receive">
      <PurchasePage />
    </Guard>
  ),
})

const toDateInput = (t?: number) => (t ? new Date(t + 6 * 3600000).toISOString().slice(0, 10) : "")
const fromDateInput = (s: string) => (s ? new Date(`${s}T12:00:00+06:00`).getTime() : undefined)

function PurchasePage() {
  const { id } = Route.useSearch()
  const isNew = id === "new"
  const data = useQuery(api.purchasing.getPO, isNew ? "skip" : { id: id as Id<"purchaseOrders"> })
  if (!isNew && data === undefined) return <Loading />
  if (!isNew && (data === null || data?.missing)) return <p className="text-sm text-muted-foreground">Purchase not found.</p>
  return <Editor key={id} data={isNew ? null : (data as Extract<NonNullable<typeof data>, { missing: false }>)} />
}

type Data = Extract<NonNullable<ReturnType<typeof useQuery<typeof api.purchasing.getPO>>>, { missing: false }>

function Editor({ data }: { data: Data | null }) {
  const can = useCan()
  const navigate = useNavigate()
  const po = data?.po
  const save = useMutation(api.purchasing.savePO)
  const setStatus = useMutation(api.purchasing.setPOStatus)
  const addPayment = useMutation(api.purchasing.addSupplierPayment)
  const [payAmt, setPayAmt] = useState(0)
  const [payMethod, setPayMethod] = useState("Cash")
  const [payRef, setPayRef] = useState("")
  const suppliers = useQuery(api.purchasing.listSuppliers) ?? []
  const locations = useQuery(api.team.listLocations) ?? []

  const [supplierId, setSupplierId] = useState<string>(po?.supplierId ?? "")
  const [locationId, setLocationId] = useState<string>(po?.locationId ?? "")
  const [supplierRef, setSupplierRef] = useState(po?.supplierRef ?? "")
  const [tracking, setTracking] = useState(po?.tracking ?? "")
  const [expected, setExpected] = useState(toDateInput(po?.expectedAt))
  const [note, setNote] = useState(po?.note ?? "")
  const [lines, setLines] = useState<POLine[]>(po?.items.map((i) => ({ ...i })) ?? [])
  const [discount, setDiscount] = useState(po?.discount ?? 0)
  const [shipping, setShipping] = useState(po?.shippingCost ?? 0)
  const [other, setOther] = useState(po?.otherCost ?? 0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dlg, setDlg] = useState<null | "search" | "builder" | "upload" | "supplier" | "editSupplier" | "receive" | "pay" | "ship">(null)
  const [preset, setPreset] = useState<Parameters<typeof ProductBuilder>[0]["preset"]>()

  useEffect(() => { if (!locationId && locations.length) setLocationId((locations.find((l) => l.isDefault) ?? locations[0])._id) }, [locations, locationId])

  const status = po?.status ?? "draft"
  const locked = status === "cancelled" || status === "received"
  const editable = can("purchases.manage") && !locked
  const touch = () => setDirty(true)
  const addLines = (ls: POLine[]) => {
    setLines((cur) => {
      const next = [...cur]
      for (const l of ls) {
        const i = next.findIndex((x) => x.variantId === l.variantId)
        if (i >= 0) next[i] = { ...next[i], orderedQty: next[i].orderedQty + (l.orderedQty || 1) }
        else next.push({ ...l, orderedQty: l.orderedQty || 1 })
      }
      return next
    })
    touch()
  }
  const setLine = (i: number, patch: Partial<POLine>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); touch() }

  const subtotal = lines.reduce((t, l) => t + l.orderedQty * l.unitCost, 0)
  const total = Math.max(0, subtotal - discount + shipping + other)
  const paid = po?.paid ?? 0
  const units = lines.reduce((t, l) => t + l.orderedQty, 0)
  const landed = subtotal > 0 ? 1 + (shipping + other - discount) / subtotal : 1

  async function doSave(nextStatus?: "draft" | "ordered") {
    if (!locationId) return toast.error("Choose the warehouse")
    if (!supplierId) return toast.error("Choose a supplier (or add a new one)")
    setBusy(true)
    try {
      const newId = await save({
        id: po?._id, supplierId: supplierId as Id<"suppliers">, locationId: locationId as Id<"locations">,
        supplierRef: supplierRef || undefined, tracking: tracking || undefined, expectedAt: fromDateInput(expected), note: note || undefined,
        lines: lines.map((l) => ({ variantId: l.variantId, orderedQty: l.orderedQty, unitCost: l.unitCost })),
        discount, shippingCost: shipping, otherCost: other, status: nextStatus,
      })
      setDirty(false)
      if (payAmt > 0 && can("purchases.pay")) {
        await addPayment({ id: newId, amount: payAmt, method: payMethod, reference: payRef || undefined })
        setPayAmt(0); setPayRef("")
      }
      toast.success((nextStatus === "ordered" ? "Purchase placed (Ordered)" : "Saved") + (payAmt > 0 && can("purchases.pay") ? ` · payment ${taka(payAmt)} recorded` : ""))
      if (!po) navigate({ to: "/purchase", search: { id: newId } })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(s: string, extra?: { tracking?: string }) {
    if (!po) return
    if (dirty) await doSave()
    try { await setStatus({ id: po._id, status: s, ...extra }); toast.success(`Marked ${PO_STATUS_LABEL[s] ?? s}`) } catch (e) { toast.error(errMsg(e)) }
  }

  const anyReceived = (po?.items ?? []).some((i) => i.receivedQty + i.damagedQty > 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm"><Link to="/purchases" className="inline-flex items-center gap-1 text-muted-foreground hover:underline"><ArrowLeft className="size-4" /> Purchases</Link></div>
      <PageHeader
        title={po ? poCode(po.code) : "New purchase"}
        sub={po ? <span className="inline-flex flex-wrap items-center gap-2"><POStatus status={status} label={PO_STATUS_LABEL[status] ?? status} /> {po.supplierName} · created {dateOnly(po.createdAt)} by {po.createdBy}</span> : "Order from a supplier. Save as draft, then mark Ordered when you confirm with the supplier."}
      >
        {editable && (dirty || !po) && <Button variant="outline" size="sm" disabled={busy} onClick={() => doSave()}>Save{!po ? " draft" : ""}</Button>}
        {editable && status === "draft" && <Button size="sm" disabled={busy} onClick={() => (po ? (dirty ? doSave("ordered") : changeStatus("ordered")) : doSave("ordered"))}>Place order</Button>}
        {po && status === "ordered" && <Perm perm="purchases.manage"><Button size="sm" variant="outline" onClick={() => setDlg("ship")}><Truck className="size-4" /> Mark on the way</Button></Perm>}
        {po && ["ordered", "shipped", "partial"].includes(status) && <Perm perm="inventory.receive"><Button size="sm" onClick={() => setDlg("receive")}><PackageCheck className="size-4" /> Receive goods</Button></Perm>}
        {po && status !== "draft" && status !== "cancelled" && <Perm perm="purchases.pay"><Button size="sm" variant="outline" onClick={() => setDlg("pay")}><Wallet className="size-4" /> Pay supplier</Button></Perm>}
        {po && anyReceived && <Button size="sm" variant="outline" asChild><a href={`/labels?po=${po._id}`} target="_blank" rel="noreferrer"><Printer className="size-4" /> Labels</a></Button>}
        {po && status === "partial" && <Perm perm="purchases.manage"><Button size="sm" variant="ghost" onClick={() => { if (confirm("Close this purchase? The rest won't be received.")) changeStatus("received") }}>Close</Button></Perm>}
        {po && !anyReceived && status !== "cancelled" && <Perm perm="purchases.manage"><Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Cancel this purchase?")) changeStatus("cancelled") }}>Cancel</Button></Perm>}
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {/* Details */}
          <section className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Supplier</Label>
              <div className="flex gap-2">
                <Select value={supplierId} onValueChange={(v) => { setSupplierId(v); touch() }} disabled={!editable}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose supplier" /></SelectTrigger>
                  <SelectContent>{suppliers.filter((s) => s.active || s._id === supplierId).map((s) => <SelectItem key={s._id} value={s._id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
                {<Perm perm="purchases.manage"><Button type="button" variant="outline" size="icon" onClick={() => setDlg("supplier")} aria-label="New supplier" title="Add supplier"><Plus className="size-4" /></Button></Perm>}
                {supplierId && <Perm perm="purchases.manage"><Button type="button" variant="outline" size="icon" onClick={() => setDlg("editSupplier")} aria-label="Edit or delete supplier" title="Edit / delete supplier"><Pencil className="size-4" /></Button></Perm>}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Receive into</Label>
              <Select value={locationId} onValueChange={(v) => { setLocationId(v); touch() }} disabled={!editable || anyReceived}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                <SelectContent>{locations.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Supplier invoice / PI no.</Label><Input value={supplierRef} disabled={!editable} onChange={(e) => { setSupplierRef(e.target.value); touch() }} /></div>
            <div className="space-y-1.5"><Label>Shipment tracking / forwarder</Label><Input value={tracking} disabled={!editable} onChange={(e) => { setTracking(e.target.value); touch() }} placeholder="e.g. Sea cargo, BL / tracking no." /></div>
            <div className="space-y-1.5"><Label>Expected arrival</Label><Input type="date" value={expected} disabled={!editable} onChange={(e) => { setExpected(e.target.value); touch() }} /></div>
            <div className="space-y-1.5 sm:col-span-3"><Label>Note</Label><Textarea rows={2} value={note} disabled={!editable} onChange={(e) => { setNote(e.target.value); touch() }} /></div>
          </section>

          {/* Lines */}
          <section className="rounded-lg border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
              <h2 className="text-sm font-semibold">Products ({lines.length} lines · {units} pcs)</h2>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDlg("search")}><Search className="size-4" /> Add existing</Button>
                  <Button size="sm" variant="outline" onClick={() => { setPreset(undefined); setDlg("builder") }}><Plus className="size-4" /> New product</Button>
                  <Button size="sm" variant="outline" onClick={() => setDlg("upload")}><Upload className="size-4" /> Upload supplier list</Button>
                </div>
              )}
            </div>
            {lines.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No products yet. Add existing products, create a new one, or upload the supplier's list (Excel/CSV).</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2.5 font-medium">Product</th><th className="p-2.5 text-right font-medium">Ordered</th>
                      {po && <><th className="p-2.5 text-right font-medium">Received</th><th className="p-2.5 text-right font-medium">Damaged</th><th className="p-2.5 text-right font-medium">Left</th></>}
                      <th className="p-2.5 text-right font-medium">Unit cost</th><th className="p-2.5 text-right font-medium">Landed</th><th className="p-2.5 text-right font-medium">Total</th><th className="p-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((l, i) => {
                      const got = (l.receivedQty ?? 0) + (l.damagedQty ?? 0)
                      return (
                        <tr key={l.variantId}>
                          <td className="p-2.5"><div className="font-medium">{l.name} · {l.title}</div><div className="font-mono text-xs text-muted-foreground">{l.sku}</div></td>
                          <td className="p-2.5 text-right">{editable ? <Input type="number" className="ml-auto h-8 w-20 text-right" value={l.orderedQty} onChange={(e) => setLine(i, { orderedQty: Math.max(0, Number(e.target.value) || 0) })} /> : l.orderedQty}</td>
                          {po && <><td className="p-2.5 text-right tabular-nums text-tone-green">{l.receivedQty ?? 0}</td><td className="p-2.5 text-right tabular-nums text-tone-red">{l.damagedQty || ""}</td><td className="p-2.5 text-right tabular-nums">{Math.max(0, l.orderedQty - got)}</td></>}
                          <td className="p-2.5 text-right">{editable ? <Input type="number" className="ml-auto h-8 w-24 text-right" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) || 0 })} /> : taka(l.unitCost)}</td>
                          <td className="p-2.5 text-right text-xs text-muted-foreground tabular-nums">{taka(Math.round(l.unitCost * landed))}</td>
                          <td className="p-2.5 text-right tabular-nums">{taka(l.orderedQty * l.unitCost)}</td>
                          <td className="p-2.5 text-right">{editable && got === 0 && <Button size="icon" variant="ghost" onClick={() => { setLines(lines.filter((_, j) => j !== i)); touch() }} aria-label="Remove"><Trash2 className="size-4" /></Button>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {po && <History data={data!} />}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <section className="space-y-2 rounded-lg border bg-card p-4 text-sm">
            <h2 className="font-semibold">Cost</h2>
            <div className="flex justify-between"><span>Products</span><span className="tabular-nums">{taka(subtotal)}</span></div>
            <label className="flex items-center justify-between gap-2"><span>Supplier discount</span><Input type="number" className="h-8 w-28 text-right" disabled={!editable} value={discount} onChange={(e) => { setDiscount(Number(e.target.value) || 0); touch() }} /></label>
            <label className="flex items-center justify-between gap-2"><span>Shipping / freight</span><Input type="number" className="h-8 w-28 text-right" disabled={!editable} value={shipping} onChange={(e) => { setShipping(Number(e.target.value) || 0); touch() }} /></label>
            <label className="flex items-center justify-between gap-2"><span>Customs / other</span><Input type="number" className="h-8 w-28 text-right" disabled={!editable} value={other} onChange={(e) => { setOther(Number(e.target.value) || 0); touch() }} /></label>
            <div className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span className="tabular-nums">{taka(total)}</span></div>
            <div className="flex justify-between text-tone-green"><span>Paid</span><span className="tabular-nums">{taka(paid)}</span></div>
            <div className="flex justify-between font-semibold"><span>Due to supplier</span><span className={cn("tabular-nums", total - paid - payAmt > 0 && "text-tone-red")}>{taka(Math.max(0, total - paid - payAmt))}</span></div>
            {status !== "cancelled" && can("purchases.pay") && (
              <div className="space-y-2 rounded-md border border-dashed border-tone-green/50 bg-tone-green-bg/40 p-2.5" data-testid="pay-now">
                <div className="text-xs font-semibold text-tone-green">Pay supplier now (advance / payment)</div>
                <div className="flex gap-2">
                  <Input type="number" className="h-8 w-28 text-right" placeholder="Amount" value={payAmt || ""} onChange={(e) => setPayAmt(Math.max(0, Number(e.target.value) || 0))} />
                  <Select value={payMethod} onValueChange={setPayMethod}>
                    <SelectTrigger size="sm" className="h-8 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{SUPPLIER_PAY_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Input className="h-8" placeholder="Reference / TrxID / cheque no. (optional)" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
                {po && !dirty ? (
                  <Button size="sm" className="w-full" disabled={payAmt <= 0 || busy} onClick={async () => {
                    setBusy(true)
                    try { await addPayment({ id: po._id, amount: payAmt, method: payMethod, reference: payRef || undefined }); toast.success(`Payment ${taka(payAmt)} recorded`); setPayAmt(0); setPayRef("") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
                  }}>Save payment</Button>
                ) : (
                  <p className="text-[11px] text-muted-foreground">{payAmt > 0 ? "Saved together when you click Save / Place order." : "Leave empty if you haven't paid yet."}</p>
                )}
              </div>
            )}
            <p className="pt-1 text-xs text-muted-foreground">Shipping, customs and discount are spread over the products by value ("landed cost"). When goods are received, each product's purchase price is updated to the average cost.</p>
          </section>
          {po && <Files po={po} />}
        </div>
      </div>

      {/* dialogs */}
      <Dialog open={dlg === "search"} onOpenChange={(o) => setDlg(o ? "search" : null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Add existing products</DialogTitle><DialogDescription>Find the product, open it, and type how many pairs of each size to order.</DialogDescription></DialogHeader>
          <div className="h-[65vh]"><SizePicker locationId={locationId ? (locationId as Id<"locations">) : undefined} onAdd={(ls) => { addLines(ls); toast.success(`${ls.reduce((t, l) => t + l.orderedQty, 0)} pcs added`) }} /></div>
        </DialogContent>
      </Dialog>
      <ProductBuilder open={dlg === "builder"} onOpenChange={(o) => setDlg(o ? "builder" : null)} preset={preset} onCreated={(ls) => addLines(ls.filter((l) => l.orderedQty > 0).length ? ls.filter((l) => l.orderedQty > 0) : ls)} />
      <UploadList open={dlg === "upload"} onOpenChange={(o) => setDlg(o ? "upload" : null)} onAdd={addLines} onCreateNew={(p) => { setPreset(p); setDlg("builder") }} />
      <SupplierDialog open={dlg === "supplier"} onOpenChange={(o) => setDlg(o ? "supplier" : null)} onSaved={(sid) => { setSupplierId(sid); touch() }} />
      <SupplierDialog supplier={suppliers.find((x) => x._id === supplierId) ?? null} open={dlg === "editSupplier"} onOpenChange={(o) => setDlg(o ? "editSupplier" : null)}
        onSaved={() => {}} onDeleted={(to) => { setSupplierId(to ?? ""); touch() }} />
      {po && <ShipDialog open={dlg === "ship"} onOpenChange={(o) => setDlg(o ? "ship" : null)} tracking={tracking} onConfirm={(t) => { setTracking(t); changeStatus("shipped", { tracking: t }) }} />}
      {po && <ReceiveDialog po={po} open={dlg === "receive"} onOpenChange={(o) => setDlg(o ? "receive" : null)} />}
      {po && <PayDialog poId={po._id} due={Math.max(0, po.total - po.paid)} open={dlg === "pay"} onOpenChange={(o) => setDlg(o ? "pay" : null)} />}
    </div>
  )
}

/** Product search grouped by product: open a product to see its sizes and type a quantity for each. */
function SizePicker({ locationId, onAdd }: { locationId?: Id<"locations">; onAdd: (ls: POLine[]) => void }) {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const results = useQuery(api.catalog.searchVariants, { q: debounced, locationId })
  const [openId, setOpenId] = useState<string | null>(null)
  const [qty, setQty] = useState<Record<string, number>>({})
  const [cost, setCost] = useState<Record<string, number>>({})
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; imageUrl?: string; rows: NonNullable<typeof results> }>()
    for (const r of results ?? []) {
      const g = m.get(r.productId) ?? { id: r.productId, name: r.productName, imageUrl: r.imageUrl, rows: [] }
      g.rows.push(r); m.set(r.productId, g)
    }
    for (const g of m.values()) g.rows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    return [...m.values()]
  }, [results])
  useEffect(() => { if (groups.length === 1) setOpenId(groups[0].id) }, [groups])
  return (
    <div className="flex h-full flex-col gap-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product name or SKU, e.g. Veyron" autoFocus />
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
        {results === undefined && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
        {results?.length === 0 && <div className="p-4 text-sm text-muted-foreground">No products found.</div>}
        {groups.map((g) => {
          const isOpen = openId === g.id
          const picked = g.rows.reduce((t, r) => t + (qty[r._id] || 0), 0)
          const stock = g.rows.reduce((t, r) => t + r.available, 0)
          return (
            <div key={g.id} className="border-b last:border-b-0">
              <button type="button" className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-muted/40" onClick={() => setOpenId(isOpen ? null : g.id)}>
                {g.imageUrl ? <img src={g.imageUrl} alt="" className="size-10 rounded object-cover" /> : <div className="size-10 rounded bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{g.name}</div>
                  <div className="text-xs text-muted-foreground">{g.rows.length} sizes · {g.rows.map((r) => r.title).join(", ")} · {stock} in stock</div>
                </div>
                {picked > 0 && <span className="rounded-full bg-tone-green-bg px-2 py-0.5 text-xs font-semibold text-tone-green">{picked} pcs</span>}
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", isOpen && "rotate-180")} />
              </button>
              {isOpen && (
                <div className="bg-muted/20 px-2.5 pb-3">
                  <div className="grid grid-cols-[1fr_5rem_5.5rem_6rem] items-center gap-2 px-1 py-1.5 text-[11px] text-muted-foreground">
                    <span>Size</span><span className="text-right">In stock</span><span className="text-right">Unit cost</span><span className="text-right">Order qty</span>
                  </div>
                  {g.rows.map((r) => (
                    <div key={r._id} className="grid grid-cols-[1fr_5rem_5.5rem_6rem] items-center gap-2 rounded px-1 py-1">
                      <div className="min-w-0"><div className="text-sm font-medium">{r.title}</div><div className="truncate text-[11px] text-muted-foreground">{r.sku}</div></div>
                      <span className={cn("text-right text-sm tabular-nums", r.available > 0 ? "" : "text-tone-red")}>{r.available}</span>
                      <Input type="number" className="h-8 text-right" value={cost[r._id] ?? r.purchasePrice ?? 0} onChange={(e) => setCost((c) => ({ ...c, [r._id]: Number(e.target.value) || 0 }))} />
                      <Input type="number" min={0} className="h-8 text-right" value={qty[r._id] || ""} placeholder="0" onChange={(e) => setQty((x) => ({ ...x, [r._id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))} />
                    </div>
                  ))}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Same qty for all sizes:</span>
                    {[1, 2, 5, 10].map((n) => (
                      <Button key={n} size="sm" variant="outline" className="h-7 px-2" onClick={() => setQty((x) => ({ ...x, ...Object.fromEntries(g.rows.map((r) => [r._id, n])) }))}>{n}</Button>
                    ))}
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setQty((x) => ({ ...x, ...Object.fromEntries(g.rows.map((r) => [r._id, 0])) }))}>Clear</Button>
                    <Button size="sm" className="ml-auto" disabled={picked === 0} onClick={() => {
                      onAdd(g.rows.filter((r) => (qty[r._id] || 0) > 0).map((r) => ({ variantId: r._id, sku: r.sku, name: r.productName, title: r.title, orderedQty: qty[r._id], unitCost: cost[r._id] ?? r.purchasePrice ?? 0 })))
                      setQty((x) => ({ ...x, ...Object.fromEntries(g.rows.map((r) => [r._id, 0])) }))
                    }}><Plus className="size-4" /> Add {picked || ""} pcs</Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ShipDialog({ open, onOpenChange, tracking, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; tracking: string; onConfirm: (t: string) => void }) {
  const [t, setT] = useState(tracking)
  useEffect(() => { if (open) setT(tracking) }, [open, tracking])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Shipment is on the way</DialogTitle><DialogDescription>Add the forwarder / tracking number so the team can follow it.</DialogDescription></DialogHeader>
        <Input value={t} onChange={(e) => setT(e.target.value)} placeholder="e.g. Sea cargo · BL 123456 · ETA 25 Nov" autoFocus />
        <DialogFooter><Button onClick={() => { onConfirm(t); onOpenChange(false) }}>Mark on the way</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReceiveDialog({ po, open, onOpenChange }: { po: Data["po"]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const receive = useMutation(api.purchasing.receivePO)
  const pending = useMemo(() => po.items.filter((i) => i.orderedQty - i.receivedQty - i.damagedQty > 0), [po.items])
  const [qty, setQty] = useState<Record<string, number>>({})
  const [dmg, setDmg] = useState<Record<string, number>>({})
  const [costMode, setCostMode] = useState<"average" | "latest" | "keep">("average")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ code: number; receiptId: string } | null>(null)
  useEffect(() => {
    if (open) {
      setQty(Object.fromEntries(pending.map((i) => [i.variantId, i.orderedQty - i.receivedQty - i.damagedQty])))
      setDmg({}); setNote(""); setDone(null)
    }
  }, [open, pending])
  const total = Object.values(qty).reduce((a, b) => a + b, 0)
  const totalDmg = Object.values(dmg).reduce((a, b) => a + b, 0)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive goods · {poCode(po.code)}</DialogTitle>
          <DialogDescription>Count what actually arrived. Good pieces go to Available, damaged pieces to Damaged. Anything not received stays open for the next delivery.</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 py-4 text-center">
            <p className="text-lg font-semibold">Received — GRN-{done.code}</p>
            <p className="text-sm text-muted-foreground">Stock is updated. Print barcode labels for the received pieces:</p>
            <Button asChild><a href={`/labels?receipt=${done.receiptId}`} target="_blank" rel="noreferrer"><Printer className="size-4" /> Print labels</a></Button>
          </div>
        ) : (
          <>
            <div className="divide-y rounded-md border text-sm">
              <div className="grid grid-cols-[1fr_70px_90px_90px] gap-2 bg-muted/40 p-2 text-xs text-muted-foreground"><span>Product</span><span className="text-right">Left</span><span className="text-right">Good</span><span className="text-right">Damaged</span></div>
              {pending.map((i) => {
                const left = i.orderedQty - i.receivedQty - i.damagedQty
                return (
                  <div key={i.variantId} className="grid grid-cols-[1fr_70px_90px_90px] items-center gap-2 p-2">
                    <div><div className="font-medium">{i.name} · {i.title}</div><div className="font-mono text-xs text-muted-foreground">{i.sku}</div></div>
                    <span className="text-right tabular-nums">{left}</span>
                    <Input type="number" className="h-8 text-right" value={qty[i.variantId] ?? 0} onChange={(e) => setQty({ ...qty, [i.variantId]: Math.max(0, Math.min(left, Number(e.target.value) || 0)) })} />
                    <Input type="number" className="h-8 text-right" value={dmg[i.variantId] ?? 0} onChange={(e) => setDmg({ ...dmg, [i.variantId]: Math.max(0, Number(e.target.value) || 0) })} />
                  </div>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={() => setQty(Object.fromEntries(pending.map((i) => [i.variantId, i.orderedQty - i.receivedQty - i.damagedQty])))}>All arrived</Button>
              <Button size="xs" variant="outline" onClick={() => setQty({})}>Clear</Button>
            </div>
            <div className="space-y-1.5 text-sm">
              <Label>Purchase price update</Label>
              <div className="flex flex-wrap gap-2">
                {([["average", "Average with current stock (recommended)"], ["latest", "Use this purchase's cost"], ["keep", "Don't change"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setCostMode(k)} className={cn("rounded-full border px-3 py-1 text-xs", costMode === k ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>{l}</button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5"><Label>Note (challan, carton count…)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </>
        )}
        {!done && (
          <DialogFooter>
            <span className="mr-auto text-sm text-muted-foreground">{total} good · {totalDmg} damaged</span>
            <Button disabled={busy || total + totalDmg === 0} onClick={async () => {
              setBusy(true)
              try {
                const lines = pending.map((i) => ({ variantId: i.variantId, qty: qty[i.variantId] ?? 0, damaged: dmg[i.variantId] ?? 0 }))
                const r = await receive({ id: po._id, lines, costMode, note: note || undefined })
                setDone({ code: r.code, receiptId: r.receiptId })
                toast.success(`Received ${total} pcs into stock`)
              } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Receive into stock</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PayDialog({ poId, due, open, onOpenChange }: { poId: Id<"purchaseOrders">; due: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const pay = useMutation(api.purchasing.addSupplierPayment)
  const [amount, setAmount] = useState(due)
  const [method, setMethod] = useState("Bank transfer")
  const [ref, setRef] = useState("")
  useEffect(() => { if (open) { setAmount(due); setRef("") } }, [open, due])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pay supplier</DialogTitle><DialogDescription>Due now: {taka(due)}</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Amount</Label><Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>Method</Label>
            <Select value={method} onValueChange={setMethod}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{SUPPLIER_PAY_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Reference / TT no.</Label><Input value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        </div>
        <DialogFooter><Button onClick={async () => {
          try { await pay({ id: poId, amount, method, reference: ref || undefined }); toast.success("Payment saved"); onOpenChange(false) } catch (e) { toast.error(errMsg(e)) }
        }}>Save payment</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Files({ po }: { po: Data["po"] }) {
  const can = useCan()
  const getUrl = useMutation(api.purchasing.uploadUrl)
  const attach = useMutation(api.purchasing.attachFile)
  const remove = useMutation(api.purchasing.removeFile)
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <section className="space-y-2 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Supplier invoice & files</h2>
        {<Perm perm="purchases.manage"><Button size="xs" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Paperclip className="size-3" /> {busy ? "Uploading…" : "Attach"}</Button></Perm>}
      </div>
      <input ref={input} type="file" className="hidden" accept="image/*,application/pdf,.xlsx,.xls,.csv" multiple onChange={async (e) => {
        const files = Array.from(e.target.files ?? [])
        setBusy(true)
        try {
          for (const f of files) {
            const url = await getUrl({})
            const res = await fetch(url, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
            const { storageId } = await res.json()
            await attach({ id: po._id, storageId, name: f.name, type: f.type })
          }
          toast.success("Attached")
        } catch (err) { toast.error(errMsg(err)) } finally { setBusy(false); if (input.current) input.current.value = "" }
      }} />
      {po.files.length === 0 ? <p className="text-xs text-muted-foreground">Attach the supplier's invoice, packing list or photos (image, PDF or Excel).</p> : (
        <ul className="space-y-1.5">
          {po.files.map((f) => (
            <li key={f.storageId} className="flex items-center gap-2">
              {f.type.startsWith("image/") && f.url ? <img src={f.url} alt="" className="size-10 rounded object-cover" /> : <FileText className="size-5 text-muted-foreground" />}
              <a href={f.url ?? "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-tone-blue hover:underline">{f.name}</a>
              {<Perm perm="purchases.manage"><Button size="icon" variant="ghost" onClick={() => remove({ id: po._id, storageId: f.storageId })} aria-label="Remove file"><Trash2 className="size-4" /></Button></Perm>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function History({ data }: { data: Data }) {
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border bg-card p-4 text-sm">
        <h2 className="mb-2 font-semibold">Deliveries received (GRN)</h2>
        {data.receipts.length === 0 ? <p className="text-xs text-muted-foreground">Nothing received yet.</p> : (
          <ul className="divide-y">
            {data.receipts.map((r) => (
              <li key={r._id} className="flex items-center justify-between gap-2 py-2">
                <div><div className="font-medium">GRN-{r.code} · {r.totalQty} pcs{r.items.some((i) => i.damaged) ? ` · ${r.items.reduce((t, i) => t + (i.damaged ?? 0), 0)} damaged` : ""}</div><div className="text-xs text-muted-foreground">{dateTime(r.at)} · {r.byName}{r.note ? ` · ${r.note}` : ""}</div></div>
                <Button size="xs" variant="outline" asChild><a href={`/labels?receipt=${r._id}`} target="_blank" rel="noreferrer"><Printer className="size-3" /> Labels</a></Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-lg border bg-card p-4 text-sm">
        <h2 className="mb-2 font-semibold">Payments to supplier</h2>
        {data.payments.length === 0 ? <p className="text-xs text-muted-foreground">No payments yet.</p> : (
          <ul className="divide-y">
            {data.payments.map((p) => (
              <li key={p._id} className="flex items-center justify-between gap-2 py-2">
                <div><div className="font-medium">{taka(p.amount)} · {p.method}</div><div className="text-xs text-muted-foreground">{dateTime(p.at)} · {p.byName}{p.reference ? ` · ${p.reference}` : ""}</div></div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
