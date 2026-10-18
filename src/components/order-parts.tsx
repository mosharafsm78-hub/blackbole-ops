import { useEffect, useMemo, useRef, useState } from "react"
import { useAction, useMutation, useQuery } from "convex/react"
import { Check, ChevronsUpDown, Minus, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CALL_OUTCOMES, STATUS_LABEL, type OrderStatus } from "@/convex/rules"
import { StatusPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

// ---------------- Searchable select ----------------
export function SearchSelect({
  value, options, placeholder, onChange, disabled, loading,
}: {
  value?: number
  options: { id: number; name: string }[]
  placeholder: string
  onChange: (o: { id: number; name: string } | null) => void
  disabled?: boolean
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" disabled={disabled} className="w-full justify-between font-normal">
          <span className={cn("truncate", !current && "text-muted-foreground")}>
            {loading ? "Loading…" : current?.name ?? placeholder}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.id} value={`${o.name} ${o.id}`} onSelect={() => { onChange(o); setOpen(false) }}>
                  <Check className={cn("size-4", o.id === value ? "opacity-100" : "opacity-0")} />
                  {o.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------------- Pathao city / zone / area ----------------
export type Place = {
  cityName?: string
  pathaoCityId?: number
  pathaoZoneId?: number
  pathaoAreaId?: number
  zoneName?: string
  areaName?: string
}

function usePlaces(kind: "city" | "zone" | "area", parentId?: number) {
  const load = useAction(api.pathao.places)
  const [list, setList] = useState<{ id: number; name: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (kind !== "city" && !parentId) { setList([]); return }
    let alive = true
    setLoading(true)
    load({ kind, parentId: parentId ?? 0 })
      .then((r) => { if (alive) { setList(r); setError(null) } })
      .catch((e) => { if (alive) setError(errMsg(e)) })
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [kind, parentId, load])
  return { list, loading, error }
}

export function PathaoAddress({ value, onChange, address }: { value: Place; onChange: (p: Place) => void; address?: string }) {
  const cities = usePlaces("city")
  const zones = usePlaces("zone", value.pathaoCityId)
  const areas = usePlaces("area", value.pathaoZoneId)
  const parse = useAction(api.pathao.parseAddress)
  const [detecting, setDetecting] = useState(false)
  const [auto, setAuto] = useState<"idle" | "found" | "none">("idle")
  const manual = useRef(!!value.pathaoCityId)
  const latest = useRef(value)
  latest.current = value
  // Like Pathao/Nuport: read the typed address and fill city, zone and area automatically.
  useEffect(() => {
    const text = (address ?? "").trim()
    if (manual.current || text.length < 8 || cities.error) return
    const t = setTimeout(async () => {
      setDetecting(true)
      try {
        const p = await parse({ address: text })
        if (manual.current) return
        if (p) {
          onChange({ ...latest.current, pathaoCityId: p.cityId, cityName: p.cityName, pathaoZoneId: p.zoneId, zoneName: p.zoneName, pathaoAreaId: p.areaId, areaName: p.areaName })
          setAuto("found")
        } else setAuto("none")
      } catch { setAuto("none") } finally { setDetecting(false) }
    }, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])
  const pick = (p: Place) => { manual.current = true; setAuto("idle"); onChange(p) }
  if (cities.error) {
    return (
      <div className="space-y-1.5">
        <Label>City</Label>
        <Input value={value.cityName ?? ""} onChange={(e) => onChange({ ...value, cityName: e.target.value })} placeholder="e.g. Dhaka" />
        <p className="text-xs text-muted-foreground">Connect Pathao in Settings to pick city, zone and area for courier booking.</p>
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label>City</Label>
        <SearchSelect
          value={value.pathaoCityId} options={cities.list} loading={cities.loading} placeholder="Select city"
          onChange={(o) => pick({ ...value, pathaoCityId: o?.id, cityName: o?.name, pathaoZoneId: undefined, zoneName: undefined, pathaoAreaId: undefined, areaName: undefined })}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Zone</Label>
        <SearchSelect
          value={value.pathaoZoneId} options={zones.list} loading={zones.loading} disabled={!value.pathaoCityId} placeholder="Select zone"
          onChange={(o) => pick({ ...value, pathaoZoneId: o?.id, zoneName: o?.name, pathaoAreaId: undefined, areaName: undefined })}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Area <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <SearchSelect
          value={value.pathaoAreaId} options={areas.list} loading={areas.loading} disabled={!value.pathaoZoneId} placeholder="Select area"
          onChange={(o) => pick({ ...value, pathaoAreaId: o?.id, areaName: o?.name })}
        />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-3" data-testid="pathao-detect">
        {detecting ? "Detecting city / zone from the address…"
          : auto === "found" ? "✓ Filled automatically from the address (Pathao). Change it if needed."
          : auto === "none" ? "Couldn't detect from the address. Pick city and zone, or Pathao will detect it when booking."
          : "City, zone and area fill in automatically when you type the address."}
      </p>
    </div>
  )
}

// ---------------- Product search + cart ----------------
export type CartLine = {
  variantId: Id<"variants">
  sku: string
  name: string
  title: string
  imageUrl?: string
  price: number
  qty: number
  discount: number
  available: number
  purchasePrice?: number
}

export function ProductSearch({ locationId, onAdd }: { locationId?: Id<"locations">; onAdd: (l: CartLine) => void }) {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200)
    return () => clearTimeout(t)
  }, [q])
  const results = useQuery(api.catalog.searchVariants, { q: debounced, locationId })
  return (
    <div className="flex h-full flex-col gap-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product name or SKU" />
      <div className="min-h-0 flex-1 divide-y overflow-auto rounded-md border bg-card">
        {results === undefined && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
        {results?.length === 0 && <div className="p-4 text-sm text-muted-foreground">No products found. Add products first.</div>}
        {results?.map((r) => (
          <div key={r._id} className="flex items-center gap-3 p-2.5">
            {r.imageUrl ? (
              <img src={r.imageUrl} alt="" className="size-10 rounded object-cover" />
            ) : (
              <div className="size-10 rounded bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.productName} <span className="text-muted-foreground">· {r.title}</span></div>
              <div className="text-xs text-muted-foreground">
                {r.sku} · {taka(r.price)} ·{" "}
                <span className={r.available > 0 ? "text-tone-green" : "text-tone-red"}>{r.available} in stock</span>
              </div>
            </div>
            <Button
              size="sm" variant="outline"
              onClick={() => onAdd({ variantId: r._id, sku: r.sku, name: r.productName, title: r.title, imageUrl: r.imageUrl, price: r.price, qty: 1, discount: 0, available: r.available, purchasePrice: r.purchasePrice })}
            >
              <Plus className="size-4" /> Add
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function addToCart(cart: CartLine[], line: CartLine): CartLine[] {
  const i = cart.findIndex((c) => c.variantId === line.variantId)
  if (i === -1) return [...cart, line]
  return cart.map((c, j) => (j === i ? { ...c, qty: c.qty + 1 } : c))
}

export function CartEditor({ cart, onChange }: { cart: CartLine[]; onChange: (c: CartLine[]) => void }) {
  const set = (i: number, patch: Partial<CartLine>) => onChange(cart.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  if (cart.length === 0) return <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Cart is empty</div>
  return (
    <div className="divide-y rounded-md border bg-card">
      {cart.map((c, i) => (
        <div key={c.variantId} className="space-y-2 p-2.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{c.name}</div>
              <div className="text-xs text-muted-foreground">{c.title} · {c.sku}</div>
              {c.qty > c.available && <div className="text-xs font-medium text-tone-red">Only {c.available} in stock</div>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => onChange(cart.filter((_, j) => j !== i))} aria-label="Remove">
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center rounded-md border">
              <button type="button" className="px-2 py-1.5" onClick={() => set(i, { qty: Math.max(1, c.qty - 1) })}><Minus className="size-3" /></button>
              <span className="w-8 text-center text-sm tabular-nums">{c.qty}</span>
              <button type="button" className="px-2 py-1.5" onClick={() => set(i, { qty: c.qty + 1 })}><Plus className="size-3" /></button>
            </div>
            <label className="flex items-center gap-1">Price
              <Input type="number" className="h-8 w-24" value={c.price} onChange={(e) => set(i, { price: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex items-center gap-1">Discount
              <Input type="number" className="h-8 w-20" value={c.discount} onChange={(e) => set(i, { discount: Number(e.target.value) || 0 })} />
            </label>
            <span className="ml-auto text-sm font-semibold tabular-nums">{taka(c.price * c.qty - c.discount)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------- Call log dialog ----------------
export function CallDialog({
  orderId, open, onOpenChange, onConfirmed,
}: { orderId: Id<"orders">; open: boolean; onOpenChange: (o: boolean) => void; onConfirmed?: () => void }) {
  const logCall = useMutation(api.orders.logCall)
  const [outcome, setOutcome] = useState(CALL_OUTCOMES[0])
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Log customer call</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {CALL_OUTCOMES.map((o) => (
              <button
                key={o} type="button" onClick={() => setOutcome(o)}
                className={cn("rounded-full border px-3 py-1.5 text-sm", outcome === o ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}
              >
                {o}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>Note</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the customer say?" />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await logCall({ id: orderId, outcome, note })
                toast.success("Call logged")
                onOpenChange(false)
                setNote("")
                if (outcome === "Confirmed") onConfirmed?.()
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Status change dialog ----------------
export const NEEDS_REASON: OrderStatus[] = ["cancelled", "on_hold", "pending_returned", "returned", "damaged"]
export const CANCEL_REASONS = ["Customer cancelled", "Fake / prank order", "Duplicate order", "Out of stock", "Unreachable after 3 calls", "Price issue", "Other"]
export const HOLD_REASONS = ["Customer asked to wait", "Stock not ready", "Advance payment pending", "Address unclear", "Other"]

export function StatusDialog({
  ids, options, open, onOpenChange, initial, onDone, label, from, confirmOnly,
}: {
  ids: Id<"orders">[]
  options: OrderStatus[]
  open: boolean
  onOpenChange: (o: boolean) => void
  initial?: OrderStatus
  onDone?: () => void
  /** e.g. "BB-11625" — shown in the confirmation */
  label?: string
  from?: OrderStatus
  /** Only confirm the chosen move (no list of other statuses) */
  confirmOnly?: boolean
}) {
  const change = useMutation(api.orders.changeStatus)
  const [to, setTo] = useState<OrderStatus | undefined>(initial)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setTo(initial ?? options[0]); setReason("") } }, [open, initial, options])
  const presets = to === "cancelled" ? CANCEL_REASONS : to === "on_hold" ? HOLD_REASONS : []
  const needReason = !!to && NEEDS_REASON.includes(to)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirmOnly && to ? `Move ${label ?? "this order"} to ${STATUS_LABEL[to]}?` : `Change status${ids.length > 1 ? ` of ${ids.length} orders` : ""}`}</DialogTitle>
        </DialogHeader>
        {confirmOnly && to && (
          <div className="flex items-center gap-2 rounded-md bg-muted/60 p-3 text-sm" data-testid="confirm-move">
            {from && <StatusPill status={from} />}<span className="text-muted-foreground">→</span><StatusPill status={to} />
            {to === "cancelled" && <span className="ml-auto text-xs text-tone-red">Stock goes back to available</span>}
          </div>
        )}
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">There's no move you're allowed to make from here.</p>
        ) : (
          <div className="space-y-4">
            <div className={cn("flex flex-wrap gap-2", confirmOnly && "hidden")}>
              {options.map((o) => (
                <button
                  key={o} type="button" onClick={() => setTo(o)}
                  className={cn("rounded-full border px-3 py-1.5 text-sm", to === o ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}
                >
                  {STATUS_LABEL[o]}
                </button>
              ))}
            </div>
            {!needReason && (
              <div className="space-y-1.5">
                <Label>Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Confirmed on call" />
              </div>
            )}
            {needReason && (
              <div className="space-y-2">
                <Label>Reason <span className="font-normal text-tone-red">(required)</span></Label>
                {presets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((p) => (
                      <button key={p} type="button" onClick={() => setReason(p)} className={cn("rounded-md border px-2 py-1 text-xs", reason === p ? "bg-accent" : "hover:bg-accent")}>{p}</button>
                    ))}
                  </div>
                )}
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" />
              </div>
            )}
            {to === "ready_to_ship" && <p className="text-xs text-muted-foreground">Orders going to Pathao are booked automatically when they reach Ready To Ship.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={busy || !to || (needReason && !reason.trim())}
            onClick={async () => {
              if (!to) return
              setBusy(true)
              try {
                const res = await change({ ids, to, reason: reason.trim() || undefined })
                if (res.done) toast.success(`${res.done} order${res.done > 1 ? "s" : ""} moved to ${STATUS_LABEL[to]}`)
                res.errors.slice(0, 4).forEach((e) => toast.error(e))
                onOpenChange(false)
                onDone?.()
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
            data-testid="confirm-status"
          >
            {busy ? "Moving…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function useGeneralSettings() {
  return useQuery(api.settings.general)
}

export function suggestFee(cityName: string | undefined, s?: { feeInsideDhaka: number; feeOutsideDhaka: number } | null) {
  if (!s) return 0
  return /dhaka/i.test(cityName ?? "") ? s.feeInsideDhaka : s.feeOutsideDhaka
}

export function useTotals(cart: CartLine[], discount: number, deliveryFee: number, paid: number) {
  return useMemo(() => {
    const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0)
    const itemDiscount = cart.reduce((s, c) => s + c.discount, 0)
    const total = Math.max(0, subtotal - itemDiscount - discount + deliveryFee)
    return { subtotal, itemDiscount, total, due: Math.max(0, total - paid) }
  }, [cart, discount, deliveryFee, paid])
}
