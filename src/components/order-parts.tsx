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

// ---------- Courier history (Pathao network-wide record for this phone) ----------
type CourierHist = { processed: number; delivered: number; returned: number; successRate: number | null; rating: string | null; message: string | null; at: number }

export function CourierHistory({ phone, compact }: { phone: string; compact?: boolean }) {
  const run = useAction(api.pathao.customerHistory)
  const [data, setData] = useState<CourierHist | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (fresh = false) => {
    setBusy(true); setError(null)
    try {
      const r = await run({ phone, fresh })
      if ("error" in r) { setError(r.error); setData(null) } else setData(r)
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  useEffect(() => {
    setData(null); setError(null)
    if (/^01\d{9}$/.test(phone)) void load()
  }, [phone]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!/^01\d{9}$/.test(phone)) return null
  const rate = data?.successRate ?? null
  const level = !data ? null : data.processed === 0 ? "new" : rate === null ? "new" : rate >= 90 ? "excellent" : rate >= 75 ? "good" : rate >= 50 ? "average" : "risky"
  const LEVEL: Record<string, { label: string; text: string; bar: string; filled: number; note: string }> = {
    excellent: { label: "Excellent", text: "text-tone-green", bar: "bg-tone-green", filled: 4, note: "This customer seems to have a very clean track record." },
    good: { label: "Good", text: "text-tone-teal", bar: "bg-tone-teal", filled: 3, note: "Mostly receives parcels — a few returns." },
    average: { label: "Average", text: "text-tone-amber", bar: "bg-tone-amber", filled: 2, note: "Returns quite often — confirm by phone before shipping." },
    risky: { label: "Risky", text: "text-tone-red", bar: "bg-tone-red", filled: 1, note: "Returns most parcels — take an advance or confirm carefully." },
    new: { label: "New customer", text: "text-muted-foreground", bar: "bg-muted-foreground/40", filled: 0, note: "No parcels with any Pathao merchant yet." },
  }
  const lv = level ? LEVEL[level] : null
  return (
    <div className={cn("rounded-lg border bg-card", compact ? "p-2.5" : "mt-3 p-3")} data-testid="courier-history">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">Courier history <span className="font-normal text-muted-foreground">· Pathao, all merchants</span></span>
        <button type="button" onClick={() => load(true)} disabled={busy} title="Check again" className="inline-flex size-6 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent disabled:opacity-50">
          <svg viewBox="0 0 24 24" className={cn("size-3.5", busy && "animate-spin")} fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
        </button>
      </div>
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : !data ? <p className="text-xs text-muted-foreground">Checking Pathao…</p> : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-md bg-muted px-2.5 py-1">Processed <b className="tabular-nums">{data.processed}</b></span>
            <span className="inline-flex items-center gap-2 rounded-md bg-tone-green-bg px-2.5 py-1 text-tone-green">Delivered <b className="tabular-nums">{data.delivered}</b></span>
            <span className="inline-flex items-center gap-2 rounded-md bg-tone-orange-bg px-2.5 py-1 text-tone-orange">Returned <b className="tabular-nums">{data.returned}</b></span>
          </div>
          {lv && (
            <div className="mt-2.5 border-t pt-2.5">
              <div className="flex items-center justify-between text-sm">
                <span>Customer rating: <span className={cn("font-semibold", lv.text)}>{data.rating || lv.label}</span></span>
                {rate !== null && <span className={cn("text-xs font-semibold", lv.text)}>{rate}% delivered</span>}
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {[0, 1, 2, 3].map((i) => <div key={i} className={cn("h-1.5 rounded-full", i < lv.filled ? lv.bar : "bg-muted")} />)}
              </div>
              <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs">{data.message || lv.note}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------- Pathao parcel tracking (timeline + costs, same as the Pathao merchant panel) ----------
type Track = {
  consignmentId: string; status: string | null; paymentStatus: string | null
  events: { stage: string | null; text: string; at: number | null }[]
  costs: { label: string; amount: number }[]; info: { label: string; value: string }[]
  trackingUrl: string | null; at: number
}
const PATHAO_STAGES = ["Accepted", "Picked", "In Transit", "Ready for Delivery", "Delivered"]
const stageKey = (s: string | null) => {
  const x = (s ?? "").toLowerCase().replace(/[_-]+/g, " ")
  if (/return/.test(x)) return "Returned"
  if (/deliver(ed|y)?\b/.test(x) && !/ready|for delivery|out/.test(x)) return "Delivered"
  if (/ready|out for|assigned for delivery/.test(x)) return "Ready for Delivery"
  if (/transit|dispatch|sorting/.test(x)) return "In Transit"
  if (/pick/.test(x)) return "Picked"
  if (/accept|request|pending|confirm/.test(x)) return "Accepted"
  if (/hold/.test(x)) return "On Hold"
  if (/cancel/.test(x)) return "Cancelled"
  return s ? s.replace(/\b\w/g, (m) => m.toUpperCase()) : "Update"
}
const when = (t: number | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "")

export function PathaoTracking({ orderId, consignmentId }: { orderId: Id<"orders">; consignmentId: string }) {
  const run = useAction(api.pathao.tracking)
  const [data, setData] = useState<Track | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState(false)
  const load = async (fresh = false) => {
    setBusy(true); setError(null)
    try { const r = await run({ orderId, fresh }); if ("error" in r) setError(r.error); else setData(r) } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [orderId, consignmentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // group events by stage (in the order they happened)
  const groups: { stage: string; events: Track["events"] }[] = []
  for (const e of data?.events ?? []) {
    const k = stageKey(e.stage ?? e.text)
    const last = groups[groups.length - 1]
    if (last && last.stage === k) last.events.push(e)
    else groups.push({ stage: k, events: [e] })
  }
  const reached = new Set(groups.map((g) => g.stage))
  const lastStage = groups[groups.length - 1]?.stage
  const pending = PATHAO_STAGES.filter((s) => !reached.has(s) && PATHAO_STAGES.indexOf(s) > PATHAO_STAGES.indexOf(lastStage ?? "Accepted") && !["Returned", "Cancelled"].includes(lastStage ?? ""))
  const shown = all ? groups : groups.slice(-3)

  return (
    <section className="rounded-xl border bg-card shadow-xs" data-testid="pathao-tracking">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-1 pt-3.5">
        <h2 className="text-sm font-semibold">Pathao tracking <span className="font-mono text-xs font-normal text-muted-foreground">#{consignmentId}</span></h2>
        <div className="flex items-center gap-2">
          {data?.status && <span className="rounded-full bg-tone-cyan-bg px-2 py-0.5 text-[11px] font-semibold text-tone-cyan">{data.status.replace(/[_-]+/g, " ")}</span>}
          {data?.paymentStatus && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold capitalize">{data.paymentStatus.replace(/[_-]+/g, " ")}</span>}
          {data?.trackingUrl && <a href={data.trackingUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-tone-blue hover:underline">Public link</a>}
          <button type="button" onClick={() => load(true)} disabled={busy} title="Check Pathao again" className="inline-flex size-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent disabled:opacity-50">
            <svg viewBox="0 0 24 24" className={cn("size-3.5", busy && "animate-spin")} fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
          </button>
        </div>
      </div>
      <div className="grid gap-5 px-4 pb-4 pt-2 md:grid-cols-5">
        <div className="md:col-span-3">
          {error ? <p className="text-sm text-muted-foreground">{error}</p> : !data ? <p className="text-sm text-muted-foreground">Loading Pathao timeline…</p> : groups.length === 0 ? <p className="text-sm text-muted-foreground">Pathao has no updates yet.</p> : (
            <>
              {groups.length > 3 && (
                <button type="button" onClick={() => setAll(!all)} className="mb-2 text-xs font-medium text-tone-blue hover:underline">{all ? "Show latest only" : `Show all ${groups.length} steps`}</button>
              )}
              <ol className="relative space-y-3">
                {shown.map((g, gi) => {
                  const bad = g.stage === "Returned" || g.stage === "Cancelled" || g.stage === "On Hold"
                  const isLast = gi === shown.length - 1 && pending.length === 0
                  return (
                    <li key={gi} className="relative pl-7">
                      {!isLast && <span className={cn("absolute left-[9px] top-5 h-[calc(100%+4px)] w-0.5", bad ? "bg-tone-red/40" : "bg-tone-green/50")} />}
                      <span className={cn("absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white", bad ? "bg-tone-red" : "bg-tone-green")}>✓</span>
                      <div className="text-sm font-semibold">{g.stage}</div>
                      <ul className="mt-1 space-y-1.5">
                        {g.events.map((e, i) => (
                          <li key={i} className="text-sm">
                            <div>{e.text}</div>
                            <div className="text-[11px] text-muted-foreground">{when(e.at)}</div>
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
                {pending.map((s, i) => (
                  <li key={s} className="relative pl-7">
                    {i < pending.length - 1 && <span className="absolute left-[9px] top-5 h-[calc(100%+4px)] w-0.5 bg-muted" />}
                    <span className="absolute left-0 top-0.5 size-5 rounded-full border-2 bg-card" />
                    <div className="text-sm text-muted-foreground">{s}</div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="space-y-3 md:col-span-2">
          {data && data.costs.length > 0 && (
            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pathao charges</div>
              {data.costs.map((c) => (
                <div key={c.label} className={cn("flex justify-between py-0.5", c.label === "Total cost" && "mt-1 border-t pt-1.5 font-semibold")}>
                  <span className={c.label === "Total cost" ? "" : "text-muted-foreground"}>{c.label}</span>
                  <span className={cn("tabular-nums", c.amount < 0 && "text-tone-green")}>{c.amount < 0 ? `−${taka(-c.amount)}` : taka(c.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {data && data.info.length > 0 && (
            <div className="text-sm">
              {data.info.map((r) => (
                <div key={r.label} className={cn("py-1", r.value.length > 40 ? "" : "flex justify-between gap-3")}>
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className={cn(r.value.length > 40 ? "mt-0.5 block text-xs" : "text-right font-medium")}>{r.value}</span>
                </div>
              ))}
            </div>
          )}
          {data && <div className="text-[11px] text-muted-foreground">Checked {when(data.at)} · updates every 10 min when you open the order</div>}
        </div>
      </div>
    </section>
  )
}
