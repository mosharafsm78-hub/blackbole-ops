import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { PackagePlus, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { RestockSuggestion } from "@/convex/targetPlan"
import type { TargetProgress } from "@/convex/targets"
import { useCan } from "@/components/app-shell"
import { Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errMsg } from "@/lib/format"

const REASON_LABEL: Record<RestockSuggestion["reasons"][number], string> = {
  running_low: "Running low",
  missing_sizes: "Missing sizes",
}

/** What to buy soon, and in which sizes — before a product runs out, or before more size-seeking customers leave
 *  because one size is empty while its siblings pile up. Suggested quantities are a starting point, editable per
 *  size; picking products and creating a draft only opens the purchase page pre-filled, it places nothing — the
 *  team still adds the supplier invoice and places the order from there, same as any other purchase. */
export function RestockSuggestions({ data }: { data: TargetProgress }) {
  const can = useCan()
  const canBuy = can("purchases.manage")
  const navigate = useNavigate()
  const list = data.restock
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [qty, setQty] = useState<Record<string, number>>({}) // variantId -> edited qty; falls back to the suggestion
  const [dlg, setDlg] = useState(false)
  const [supplierId, setSupplierId] = useState("")
  const [locationId, setLocationId] = useState("")
  const [busy, setBusy] = useState(false)
  const suppliers = useQuery(api.purchasing.listSuppliers, canBuy ? {} : "skip") ?? []
  const locations = useQuery(api.team.listLocations, canBuy ? {} : "skip") ?? []
  const save = useMutation(api.purchasing.savePO)

  if (!list || list.length === 0) return null

  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const toggleOpen = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const uncheck = (key: string) => setSelected((s) => { const n = new Set(s); n.delete(key); return n })

  const selectedRows = list.filter((r) => selected.has(r.key))
  const lines = selectedRows
    .flatMap((r) => r.sizes.map((s) => ({ variantId: s.variantId, orderedQty: qty[s.variantId] ?? s.suggest, unitCost: s.cost })))
    .filter((l) => l.orderedQty > 0)

  const openCreate = () => {
    if (lines.length === 0) { toast.error("Pick at least one product to restock"); return }
    if (!locationId) setLocationId((locations.find((l) => l.isDefault) ?? locations[0])?._id ?? "")
    setDlg(true)
  }

  const create = async () => {
    if (lines.length === 0) { toast.error("Pick at least one product to restock"); setDlg(false); return }
    if (!supplierId) { toast.error("Choose a supplier"); return }
    if (!locationId) { toast.error("Choose a warehouse"); return }
    setBusy(true)
    try {
      const id = await save({
        supplierId: supplierId as Id<"suppliers">, locationId: locationId as Id<"locations">,
        lines: lines.map((l) => ({ variantId: l.variantId as Id<"variants">, orderedQty: l.orderedQty, unitCost: l.unitCost })),
        discount: 0, shippingCost: 0, otherCost: 0, status: "draft",
      })
      toast.success("Draft purchase order created")
      setDlg(false)
      void navigate({ to: "/purchase", search: { id: id as string } })
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border bg-card p-4" data-testid="target-restock">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Restock soon</h2>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Running low at the current pace, or a size is empty while its siblings pile up. Quantities are a starting
            point — edit them, then create a draft purchase: nothing is ordered until the supplier invoice is attached and it's placed.
          </p>
        </div>
        {canBuy && selectedRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedRows.map((r) => (
              <span key={r.key} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs">
                {r.name}
                <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-tone-red" onClick={() => uncheck(r.key)} aria-label={`Remove ${r.name} from this purchase`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {canBuy && (
          <Button size="sm" disabled={selected.size === 0} onClick={openCreate}>
            <PackagePlus className="size-4" />Create draft purchase{selected.size > 0 && ` (${selected.size})`}
          </Button>
        )}
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {canBuy && <th className="w-8 px-3 py-1.5" />}
              <th className="px-3 py-1.5 text-left font-medium">Product</th>
              <th className="px-3 py-1.5 text-left font-medium">Why</th>
              <th className="px-3 py-1.5 text-right font-medium">In stock</th>
              <th className="px-3 py-1.5 text-right font-medium">Days left</th>
              <th className="px-3 py-1.5 text-right font-medium">Suggest buy</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <Row key={r.key} r={r} isOpen={open.has(r.key)} isSelected={selected.has(r.key)} toggle={() => toggle(r.key)} toggleOpen={() => toggleOpen(r.key)} qty={qty} setQty={setQty} canBuy={canBuy} />
            ))}
          </tbody>
        </table>
      </div>
      {dlg && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => !busy && setDlg(false)}>
          <div className="w-full max-w-sm rounded-xl border bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold">Create draft purchase order</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Changed your mind on one of these? Remove it below — nothing is ordered until the invoice is attached and it's placed.
            </p>
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
              {selectedRows.length === 0 && <p className="px-1 py-1 text-xs text-muted-foreground">Nothing picked — close this and select a product first.</p>}
              {selectedRows.map((r) => {
                const rowTotal = r.sizes.reduce((s, x) => s + (qty[x.variantId] ?? x.suggest), 0)
                return (
                  <div key={r.key} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                    <span className="truncate">{r.name} <span className="text-muted-foreground">· {rowTotal} pairs</span></span>
                    <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-tone-red" onClick={() => uncheck(r.key)} aria-label={`Remove ${r.name} from this purchase`}>
                      <X className="size-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {lines.length} line{lines.length === 1 ? "" : "s"} · {lines.reduce((s, l) => s + l.orderedQty, 0)} pairs.
              You can still edit quantities, split it by supplier, or attach the invoice on the purchase page before placing it.
            </p>
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <Label>Supplier</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose supplier" /></SelectTrigger>
                  <SelectContent>{suppliers.filter((s) => s.active).map((s) => <SelectItem key={s._id} value={s._id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Warehouse</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                  <SelectContent>{locations.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setDlg(false)}>Cancel</Button>
              <Button disabled={busy || lines.length === 0} onClick={() => void create()}>{busy ? "Creating…" : "Create draft"}</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function Row({ r, isOpen, isSelected, toggle, toggleOpen, qty, setQty, canBuy }: {
  r: RestockSuggestion
  isOpen: boolean
  isSelected: boolean
  toggle: () => void
  toggleOpen: () => void
  qty: Record<string, number>
  setQty: (f: (q: Record<string, number>) => Record<string, number>) => void
  canBuy: boolean
}) {
  const total = r.sizes.reduce((s, x) => s + (qty[x.variantId] ?? x.suggest), 0)
  return (
    <>
      <tr className="border-t">
        {canBuy && <td className="px-3 py-1.5"><Checkbox checked={isSelected} onCheckedChange={toggle} aria-label={`Include ${r.name}`} /></td>}
        <td className="px-3 py-1.5 font-medium"><button type="button" className="text-left hover:underline" onClick={toggleOpen}>{r.name}</button></td>
        <td className="px-3 py-1.5"><div className="flex flex-wrap gap-1">{r.reasons.map((reason) => <Pill key={reason} tone={reason === "missing_sizes" ? "red" : "amber"}>{REASON_LABEL[reason]}</Pill>)}</div></td>
        <td className="px-3 py-1.5 text-right tabular-nums">{r.totalStock}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{r.coverDays ?? "—"}</td>
        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{total}</td>
      </tr>
      {isOpen && (
        <tr className="border-t bg-muted/30">
          {canBuy && <td />}
          <td colSpan={5} className="px-3 py-2">
            <div className="flex flex-wrap gap-3">
              {r.sizes.map((s) => (
                <label key={s.variantId} className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{s.title}{s.units <= 0 ? <span className="text-tone-red"> (out)</span> : ` (${s.units} in hand)`}</span>
                  <Input type="number" min={0} className="h-7 w-16" disabled={!canBuy} value={qty[s.variantId] ?? s.suggest} onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); setQty((q) => ({ ...q, [s.variantId]: v })) }} />
                </label>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
