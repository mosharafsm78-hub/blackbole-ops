import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { AlertTriangle, ChevronDown, Lock, Download, Printer, RefreshCw, Shuffle, Truck } from "lucide-react"
import { useAction } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES, STATUS_LABEL, STATUS_TABS, TRANSITIONS, hasPerm, moveKey, type OrderStatus } from "@/convex/rules"
import { Guard, useMe, Perm } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, PageHeader, Pill, StatusPill } from "@/components/bits"
import { NEEDS_REASON, StatusDialog } from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TAB_TONE, TONE_CLASS, TONE_SOLID, dateTime, errMsg, invoice, startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

type Search = { tab: string; q?: string; source?: string; range?: string; flag?: string; wh?: string; st?: string }

export const Route = createFileRoute("/_app/orders")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: typeof s.tab === "string" ? s.tab : "pending",
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    source: typeof s.source === "string" && s.source ? s.source : undefined,
    range: typeof s.range === "string" && s.range ? s.range : undefined,
    flag: typeof s.flag === "string" && s.flag ? s.flag : undefined,
    wh: typeof s.wh === "string" && s.wh ? s.wh : undefined,
    st: typeof s.st === "string" && s.st ? s.st : undefined,
  }),
  component: () => (
    <Guard perm="orders.view">
      <OrdersPage />
    </Guard>
  ),
})

const RANGES: Record<string, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" }
const SUB_LABEL: Record<string, string> = {
  delivered_due: "Payment Due", delivered_paid: "Payment Collected",
  pending_returned: "Pending Returned", returned: "Returned", damaged: "Damaged",
}
const FLAGS: Record<string, string> = {
  nocall: "Not called yet", unprinted: "Invoice not printed", duplicate: "Same phone, other open orders", courierError: "Courier booking failed",
  followUp: "Follow-up due (call again)",
}

function rangeFrom(r?: string) {
  if (r === "today") return startOfDayBD()
  if (r === "7d") return startOfDayBD() - 6 * 86400000
  if (r === "30d") return startOfDayBD() - 29 * 86400000
  return undefined
}

function OrdersPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const me = useMe()
  const [limit, setLimit] = useState(100)
  const [selected, setSelected] = useState<Set<Id<"orders">>>(new Set())
  const [statusOpen, setStatusOpen] = useState(false)
  const syncNow = useAction(api.pathao.syncNow)
  const counts = useQuery(api.orders.counts)
  const sameNumber = useQuery(api.orders.sameNumberCount, { tab: search.tab })
  const [syncing, setSyncing] = useState(false)
  const pushMany = useAction(api.pathao.pushMany)
  const checkDue = useAction(api.pathao.checkDueNow)
  const [checkingDue, setCheckingDue] = useState(false)
  const [pushing, setPushing] = useState(false)
  const data = useQuery(api.orders.list, {
    tab: search.tab, search: search.q, source: search.source, from: rangeFrom(search.range), flag: search.flag, location: search.wh, status: search.st, limit,
  })
  const locations = useQuery(api.team.listLocations, {})
  const whTone = (id: string) => {
    const i = (locations ?? []).findIndex((l) => l._id === id)
    return ["bg-tone-blue/10 text-tone-blue", "bg-tone-violet/10 text-tone-violet", "bg-tone-teal/10 text-tone-teal", "bg-tone-orange/10 text-tone-orange", "bg-tone-pink/10 text-tone-pink"][Math.max(0, i) % 5]
  }
  const rows = data?.rows ?? []

  const set = (patch: Partial<Search>) => {
    setSelected(new Set())
    navigate({ search: (s: Search) => ({ ...s, ...patch }) })
  }

  const selectedRows = rows.filter((r) => selected.has(r._id))
  const moveOptions = useMemo(() => {
    if (selectedRows.length === 0) return []
    const statuses: OrderStatus[] = [...new Set<OrderStatus>(selectedRows.map((r) => r.status as OrderStatus))]
    let opts = TRANSITIONS[statuses[0]]
    for (const s of statuses.slice(1)) opts = opts.filter((o) => TRANSITIONS[s].includes(o))
    return opts.filter((o) => statuses.every((s) => hasPerm(me.perms, moveKey(s, o))))
  }, [selectedRows, me.perms])

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r._id))

  const exportCsv = () => {
    const list = selectedRows.length ? selectedRows : rows
    const head = ["Invoice", "Status", "Source", "Shopify", "Created", "Customer", "Phone", "Address", "City", "Zone", "Items", "Total", "Paid", "Due", "Delivery fee", "Consignment", "Courier status", "Calls", "Warehouse"]
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const lines = list.map((o) => [
      o.invoiceCode ?? invoice(o.invoiceNo), o.status, o.source, o.externalName, dateTime(o.createdAt), o.customerName, o.phone, o.address,
      o.cityName, o.zoneName, o.items.map((i) => `${i.sku} x${i.qty}`).join("; "), o.total, o.paidAmount, o.due, o.deliveryFee,
      o.consignmentId, o.courierStatus, o.callCount, (o as any).locationName ?? "",
    ].map(esc).join(","))
    const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `orders-${search.tab}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div>
      <PageHeader title="Orders" sub={search.q ? `Search results for “${search.q}”` : undefined}>
        <Button
          variant="outline" size="sm" disabled={syncing}
          title="Asks Pathao for the latest status of every parcel that is shipped, delivered-due or returning, and moves those orders (e.g. In Transit → Delivered). Also runs by itself every 30 minutes."
          onClick={async () => {
            setSyncing(true)
            const id = toast.loading("Checking every shipped parcel with Pathao…")
            try {
              const r = await syncNow({})
              if (r.errors?.length) console.warn("Pathao sync could not read:", r.errors)
              const msg = r.moved
                ? `${r.moved} order${r.moved > 1 ? "s" : ""} updated from Pathao: ${r.changes.slice(0, 8).join(", ")}${r.changes.length > 8 ? "…" : ""}`
                : `All ${r.checked - r.failed} parcels already up to date with Pathao`
              toast.success(msg, { id, duration: 10000, description: r.failed ? `${r.failed} parcel(s) could not be read — tried again in 30 min` : `Checked ${r.checked} parcels` })
            } catch (e) { toast.error(errMsg(e), { id }) } finally { setSyncing(false) }
          }}
        >
          <RefreshCw className={cn("size-4", syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync Pathao"}
        </Button>
        <Perm perm="orders.create"><Button size="sm" asChild><Link to="/new-order">Create order</Link></Button></Perm>
      </PageHeader>

      {/* Status tabs */}
      <div className="mb-4 flex gap-2 overflow-x-auto rounded-xl border bg-card p-2">
        {[{ key: "all", label: "All" }, ...STATUS_TABS].map((t) => {
          const tone = TAB_TONE[t.key] ?? "gray"
          const active = search.tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => set({ tab: t.key, st: undefined })}
              data-testid={`tab-${t.key}`}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg border border-transparent px-3.5 py-2 text-sm font-semibold transition",
                active ? cn(TONE_SOLID[tone], "shadow-sm") : cn(TONE_CLASS[tone], "hover:border-current/30 hover:brightness-95"),
              )}
            >
              {t.label}
              <span className={cn("min-w-6 rounded-md px-1.5 py-0.5 text-center text-xs tabular-nums", active ? "bg-white/25" : "bg-background/70")}>
                {counts?.[t.key] ?? "·"}
              </span>
            </button>
          )
        })}
      </div>

      {/* Sub-tabs like Nuport: Delivered → Payment Due / Collected, Flagged → Pending Returned / Returned / Damaged */}
      {(() => {
        const tab = STATUS_TABS.find((t) => t.key === search.tab)
        if (!tab || tab.statuses.length < 2) return null
        const subs = [{ k: undefined as string | undefined, label: "All" }, ...tab.statuses.map((st) => ({ k: st as string | undefined, label: SUB_LABEL[st] ?? STATUS_LABEL[st] }))]
        return (
          <div className="-mt-2 mb-4 flex flex-wrap gap-2" data-testid="sub-tabs">
            {subs.map((x) => {
              const active = search.st === x.k
              const n = x.k ? counts?.[`st:${x.k}`] : counts?.[tab.key]
              return (
                <button
                  key={x.k ?? "all"} type="button" onClick={() => set({ st: x.k })} data-testid={`sub-${x.k ?? "all"}`}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium", active ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-accent")}
                >
                  {x.label}
                  <span className={cn("rounded px-1.5 text-xs tabular-nums", active ? "bg-white/25" : "bg-muted")}>{n ?? "·"}</span>
                </button>
              )
            })}
            {search.st === "delivered_due" && (
              <Button
                size="sm" variant="outline" className="ml-auto" disabled={checkingDue} data-testid="check-due"
                title="Asks Pathao about every Payment Due order. Paid ones move to Payment Collected. Also runs by itself every 30 minutes."
                onClick={async () => {
                  setCheckingDue(true)
                  const tid = toast.loading("Checking every Payment Due order with Pathao…")
                  try {
                    const r = await checkDue({})
                    const msg = r.paid.length || r.returned.length
                      ? `${r.paid.length} paid by Pathao → Payment Collected${r.returned.length ? `, ${r.returned.length} returning` : ""}`
                      : `All ${r.checked - r.failed} checked — Pathao has not paid these yet`
                    toast.success(msg, { id: tid, duration: 12000, description: [r.paid.length ? `Paid: ${r.paid.join(", ")}` : "", r.returned.length ? `Returning: ${r.returned.join(", ")}` : "", r.failed ? `${r.failed} could not be read` : ""].filter(Boolean).join("\n") || undefined })
                  } catch (e) { toast.error(errMsg(e), { id: tid }) } finally { setCheckingDue(false) }
                }}
              >
                <RefreshCw className={cn("size-4", checkingDue && "animate-spin")} /> {checkingDue ? "Checking…" : "Check with Pathao"}
              </Button>
            )}
          </div>
        )
      })()}

      {/* Filters + bulk actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={search.source ?? "any"} onValueChange={(v) => set({ source: v === "any" ? undefined : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">All sources</SelectItem>
            {ORDER_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={search.range ?? "any"} onValueChange={(v) => set({ range: v === "any" ? undefined : v })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue placeholder="Date" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any date</SelectItem>
            {Object.entries(RANGES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={search.flag ?? "any"} onValueChange={(v) => set({ flag: v === "any" ? undefined : v })}>
          <SelectTrigger size="sm" className="w-56"><SelectValue placeholder="Quick filter" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">No quick filter</SelectItem>
            {Object.entries(FLAGS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        {locations && locations.length > 1 && (
          <Select value={search.wh ?? "any"} onValueChange={(v) => set({ wh: v === "any" ? undefined : v })}>
            <SelectTrigger size="sm" className="w-44" data-testid="wh-filter"><SelectValue placeholder="Warehouse" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">All warehouses</SelectItem>
              {locations.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {typeof sameNumber === "number" && (
          <Button
            size="sm" variant="outline" data-testid="same-number"
            className={cn("gap-2", search.flag === "duplicate" && "border-tone-orange bg-tone-orange/10")}
            onClick={() => set({ flag: search.flag === "duplicate" ? undefined : "duplicate" })}
            title="Orders where the same phone number has more than one open order"
          >
            <AlertTriangle className="size-4 text-tone-orange" /> Multiple orders, same number
            <span className={cn("rounded px-1.5 text-xs font-semibold tabular-nums", sameNumber > 0 ? "bg-tone-orange text-white" : "bg-muted text-muted-foreground")}>{sameNumber}</span>
          </Button>
        )}
        {(search.q || search.source || search.range || search.flag || search.wh) && (
          <Button variant="ghost" size="sm" onClick={() => set({ q: undefined, source: undefined, range: undefined, flag: undefined, wh: undefined })}>Clear</Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && <span className="text-sm text-muted-foreground">{selected.size} selected</span>}
          <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={() => setStatusOpen(true)}>
            <Shuffle className="size-4" /> Change status
          </Button>
          <Perm perm="courier.book">
            <Button
              size="sm" variant="outline" disabled={selected.size === 0 || pushing} data-testid="bulk-push-pathao"
              title="Send the selected orders to Pathao now"
              onClick={async () => {
                setPushing(true)
                const tid = toast.loading(`Sending ${selected.size} order(s) to Pathao…`)
                try {
                  const r = await pushMany({ ids: [...selected] })
                  const lines = [
                    r.booked.length ? `Sent: ${r.booked.join(", ")}` : "",
                    r.failed.length ? `Failed: ${r.failed.join(" · ")}` : "",
                    r.skipped.length ? `Skipped: ${r.skipped.join(", ")}` : "",
                  ].filter(Boolean).join("\n")
                  const fn = r.failed.length ? toast.error : toast.success
                  fn(`${r.booked.length} sent to Pathao${r.failed.length ? `, ${r.failed.length} failed` : ""}`, { id: tid, description: lines, duration: 12000 })
                  setSelected(new Set())
                } catch (e) { toast.error(errMsg(e), { id: tid }) } finally { setPushing(false) }
              }}
            >
              <Truck className="size-4" /> {pushing ? "Sending…" : "Push to Pathao"}
            </Button>
          </Perm>
          <Perm perm="orders.print">
            <Button
              size="sm" variant="outline" disabled={selected.size === 0}
              onClick={() => window.open(`/print?ids=${[...selected].join(",")}`, "_blank")}
            >
              <Printer className="size-4" /> Print invoices
            </Button>
          </Perm>
          <Perm perm="orders.export">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="size-4" /> Export CSV
            </Button>
          </Perm>
        </div>
      </div>

      {data === undefined || data === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="No orders here">
          {search.tab === "pending" && !search.q ? "New Shopify orders land in Pending. You can also create an order by hand." : "Try another tab or clear the filters."}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-10 p-3">
                  <Checkbox
                    checked={allChecked}
                    onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r._id)) : new Set())}
                    aria-label="Select all"
                  />
                </th>
                <th className="p-3 font-medium">Invoice</th>
                <th className="p-3 font-medium">Customer</th>
                <th className="p-3 font-medium">Warehouse</th>
                <th className="p-3 font-medium">Products</th>
                <th className="p-3 font-medium">Payment</th>
                <th className="p-3 font-medium">Courier</th>
                <th className="p-3 font-medium">Calls</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((o) => (
                <tr key={o._id} className={cn("align-top hover:bg-muted/30", (o as any).dupes > 0 && "bg-tone-orange/5", selected.has(o._id) && "bg-accent/50")}>
                  <td className="p-3">
                    <Checkbox
                      checked={selected.has(o._id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(o._id); else next.delete(o._id)
                        setSelected(next)
                      }}
                      aria-label={`Select ${o.invoiceCode ?? invoice(o.invoiceNo)}`}
                    />
                  </td>
                  <td className="p-3">
                    <Link to="/order" search={{ id: o._id }} className="font-semibold text-tone-blue hover:underline">
                      {o.invoiceCode ?? invoice(o.invoiceNo)}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Pill tone="gray">{o.source}</Pill>
                      {o.externalName && <span className="text-xs text-muted-foreground">{o.externalName}</span>}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{dateTime(o.createdAt)}</div>
                    {(o.lastNote || (o.reason && NEEDS_REASON.includes(o.status as OrderStatus))) && (
                      <div className="mt-1 max-w-52 rounded bg-tone-amber-bg px-1.5 py-0.5 text-[11px] text-foreground" data-testid="row-note">
                        📝 {o.lastNote ?? o.reason}{o.lastNoteBy ? <span className="text-muted-foreground"> — {o.lastNoteBy}</span> : null}
                      </div>
                    )}
                    {o.printedAt && <div className="text-[11px] text-muted-foreground">Printed</div>}
                  </td>
                  <td className="max-w-64 p-3">
                    <div className="font-medium">{o.customerName}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">{o.phone}</span>
                      <ContactButtons phone={o.phone} />
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{o.address}</div>
                    {(o.cityName || o.zoneName) && <div className="text-xs">{[o.zoneName, o.cityName].filter(Boolean).join(", ")}</div>}
                    {(o as any).dupes > 0 && (
                      <button
                        type="button" onClick={() => set({ q: o.phone, flag: undefined })} title="Show all orders from this number"
                        className="mt-1 inline-flex items-center gap-1 rounded-md bg-tone-orange/15 px-1.5 py-0.5 text-xs font-semibold text-tone-orange hover:bg-tone-orange/25"
                      >
                        <AlertTriangle className="size-3" /> {(o as any).dupes} more open order{(o as any).dupes > 1 ? "s" : ""} from this number
                      </button>
                    )}
                  </td>
                  <td className="p-3 text-xs" data-testid="wh-cell">
                    {(o as any).locationName ? (
                      <span className={cn("inline-flex whitespace-nowrap rounded-md px-1.5 py-0.5 font-semibold", whTone(o.locationId))}>{(o as any).locationName}</span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="max-w-56 p-3 text-xs">
                    {o.items.map((i, k) => (
                      <div key={k} className={cn(!i.variantId && "text-tone-red")}>
                        {i.qty} × {i.name}{i.attrs ? ` · ${i.attrs}` : ""}
                      </div>
                    ))}
                  </td>
                  <td className="whitespace-nowrap p-3 text-xs">
                    <div>Total <span className="font-semibold">{taka(o.total)}</span></div>
                    {o.paidAmount > 0 && <div className="text-tone-green">Paid {taka(o.paidAmount)}</div>}
                    <div>Due <span className="font-semibold">{taka(o.due)}</span></div>
                    <div className="text-muted-foreground">Delivery {taka(o.deliveryFee)}</div>
                    <div className="mt-0.5 text-muted-foreground">{o.due === 0 && o.paidAmount > 0 ? `Paid · ${o.paymentMethod ?? ""}` : o.paidAmount > 0 ? `COD + advance` : (o.paymentMethod ?? "Cash On Delivery")}</div>
                  </td>
                  <td className="p-3 text-xs">
                    {o.courier === "pickup" ? (
                      <span className="text-muted-foreground">Store pickup</span>
                    ) : o.consignmentId ? (
                      <>
                        <div className="inline-flex rounded bg-tone-blue/10 px-1.5 py-0.5 font-semibold text-tone-blue">Sent to Pathao</div>
                        <div className="mt-0.5 font-mono">{o.consignmentId}</div>
                        <div className="text-muted-foreground">{o.courierStatus}</div>
                      </>
                    ) : o.courierError ? (
                      <>
                        <div className="inline-flex rounded bg-tone-red/10 px-1.5 py-0.5 font-semibold text-tone-red">Pathao booking failed</div>
                        <div className="mt-0.5 max-w-40 text-tone-red">{o.courierError}</div>
                      </>
                    ) : (
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-muted-foreground">Not sent to Pathao</span>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    <div className="tabular-nums">{o.callCount}</div>
                    {o.lastCallOutcome && <div className="text-muted-foreground">{o.lastCallOutcome}</div>}
                    {o.followUpAt && (
                      <div className={cn("whitespace-nowrap font-medium", o.followUpAt <= Date.now() ? "text-tone-red" : "text-tone-amber")}>
                        Call again {new Date(o.followUpAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                      </div>
                    )}
                  </td>
                  <td className="p-3"><RowStatus id={o._id} status={o.status as OrderStatus} perms={me.perms} label={o.invoiceCode ?? invoice(o.invoiceNo)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.hasMore && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 100)}>Load more</Button>
            </div>
          )}
        </div>
      )}

      <StatusDialog
        ids={[...selected]}
        options={moveOptions}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        onDone={() => setSelected(new Set())}
      />
    </div>
  )
}

/** Status pill with a menu of the moves this user may make, plus "Add note". Moves that need a reason open the note dialog. */
function RowStatus({ id, status, perms, label }: { id: Id<"orders">; status: OrderStatus; perms: string[]; label: string }) {
  const change = useMutation(api.orders.changeStatus)
  const addNote = useMutation(api.orders.addNote)
  const [dialogTo, setDialogTo] = useState<OrderStatus | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const options = TRANSITIONS[status].filter((t) => hasPerm(perms, moveKey(status, t)))
  const lockedMoves = TRANSITIONS[status].filter((t) => !hasPerm(perms, moveKey(status, t)))
  // Every move asks for confirmation first (note optional; required for cancel / hold / returns).
  const move = (to: OrderStatus) => setDialogTo(to)
  return (
    <>
      <StatusPill status={status} />
      <div className="mt-1.5 flex max-w-60 flex-wrap items-center gap-1" data-testid="row-moves">
        {options.length > 0 && <span className="w-full text-[10px] uppercase tracking-wide text-muted-foreground">Move to</span>}
        {options.slice(0, 4).map((t) => (
          <button key={t} type="button" disabled={busy} onClick={() => move(t)} title={`Move to ${STATUS_LABEL[t]}${NEEDS_REASON.includes(t) ? " (asks for a note)" : ""}`}
            className="rounded-full border bg-background px-0.5 py-0.5 transition hover:border-foreground/40 hover:shadow-sm disabled:opacity-50">
            <StatusPill status={t} />
          </button>
        ))}
        {options.length > 4 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <button type="button" className="inline-flex items-center gap-0.5 rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-foreground/40" data-testid="row-more">
                More <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {options.slice(4).map((t) => (
                <DropdownMenuItem key={t} onSelect={() => move(t)}>{STATUS_LABEL[t]}{NEEDS_REASON.includes(t) ? " …" : ""}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {lockedMoves.length > 0 && (
          <span title={`Locked for you: ${lockedMoves.map((t) => STATUS_LABEL[t]).join(", ")}. Ask your admin.`} className="inline-flex cursor-not-allowed items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground/70" data-testid="row-locked">
            <Lock className="size-3" />{lockedMoves.length}
          </span>
        )}
        <button type="button" onClick={() => { setNote(""); setNoteOpen(true) }} className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground" data-testid="row-add-note">
          + Note
        </button>
      </div>
      <StatusDialog
        ids={[id]}
        options={options}
        initial={dialogTo ?? undefined}
        label={label}
        from={status}
        confirmOnly
        open={!!dialogTo}
        onOpenChange={(o) => { if (!o) setDialogTo(null) }}
        onDone={() => setDialogTo(null)}
      />
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add note</DialogTitle></DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customer will receive after 5pm" autoFocus />
          <DialogFooter>
            <Button disabled={!note.trim()} onClick={async () => {
              try { await addNote({ id, text: note }); toast.success("Note added"); setNoteOpen(false) } catch (e) { toast.error(errMsg(e)) }
            }}>Save note</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
