import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { AlertTriangle, ChevronDown, Download, Printer, RefreshCw, Shuffle } from "lucide-react"
import { useAction } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES, STATUS_LABEL, STATUS_TABS, TRANSITIONS, hasPerm, moveKey, type OrderStatus } from "@/convex/rules"
import { Guard, useMe } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, PageHeader, Pill, StatusPill } from "@/components/bits"
import { NEEDS_REASON, StatusDialog } from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, invoice, startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

type Search = { tab: string; q?: string; source?: string; range?: string; flag?: string }

export const Route = createFileRoute("/_app/orders")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: typeof s.tab === "string" ? s.tab : "pending",
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    source: typeof s.source === "string" && s.source ? s.source : undefined,
    range: typeof s.range === "string" && s.range ? s.range : undefined,
    flag: typeof s.flag === "string" && s.flag ? s.flag : undefined,
  }),
  component: () => (
    <Guard perm="orders.view">
      <OrdersPage />
    </Guard>
  ),
})

const RANGES: Record<string, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" }
const FLAGS: Record<string, string> = {
  nocall: "Not called yet", unprinted: "Invoice not printed", duplicate: "Same phone, other open orders", courierError: "Courier booking failed",
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
  const data = useQuery(api.orders.list, {
    tab: search.tab, search: search.q, source: search.source, from: rangeFrom(search.range), flag: search.flag, limit,
  })
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
    const head = ["Invoice", "Status", "Source", "Shopify", "Created", "Customer", "Phone", "Address", "City", "Zone", "Items", "Total", "Paid", "Due", "Delivery fee", "Consignment", "Courier status", "Calls"]
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const lines = list.map((o) => [
      invoice(o.invoiceNo), o.status, o.source, o.externalName, dateTime(o.createdAt), o.customerName, o.phone, o.address,
      o.cityName, o.zoneName, o.items.map((i) => `${i.sku} x${i.qty}`).join("; "), o.total, o.paidAmount, o.due, o.deliveryFee,
      o.consignmentId, o.courierStatus, o.callCount,
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
          variant="outline" size="sm"
          onClick={async () => {
            try {
              const r = await syncNow({})
              toast.success(`Checked ${r.checked} parcels with Pathao, ${r.moved} updated`)
            } catch (e) { toast.error(errMsg(e)) }
          }}
        >
          <RefreshCw className="size-4" /> Sync Pathao
        </Button>
        {hasPerm(me.perms, "orders.create") && (
          <Button size="sm" asChild><Link to="/new-order">Create order</Link></Button>
        )}
      </PageHeader>

      {/* Status tabs */}
      <div className="mb-3 flex gap-1 overflow-x-auto rounded-lg border bg-card p-1">
        {[{ key: "all", label: "All" }, ...STATUS_TABS].map((t) => (
          <button
            key={t.key}
            onClick={() => set({ tab: t.key })}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent",
              search.tab === t.key && "bg-foreground text-background hover:bg-foreground",
            )}
          >
            {t.label}
            <span className={cn("rounded px-1.5 text-xs tabular-nums", search.tab === t.key ? "bg-background/20" : "bg-muted")}>
              {counts?.[t.key] ?? "·"}
            </span>
          </button>
        ))}
      </div>

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
        {(search.q || search.source || search.range || search.flag) && (
          <Button variant="ghost" size="sm" onClick={() => set({ q: undefined, source: undefined, range: undefined, flag: undefined })}>Clear</Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && <span className="text-sm text-muted-foreground">{selected.size} selected</span>}
          <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={() => setStatusOpen(true)}>
            <Shuffle className="size-4" /> Change status
          </Button>
          <Button
            size="sm" variant="outline" disabled={selected.size === 0 || !hasPerm(me.perms, "orders.print")}
            onClick={() => window.open(`/print?ids=${[...selected].join(",")}`, "_blank")}
          >
            <Printer className="size-4" /> Print invoices
          </Button>
          {hasPerm(me.perms, "orders.export") && (
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="size-4" /> Export CSV
            </Button>
          )}
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
                <th className="p-3 font-medium">Products</th>
                <th className="p-3 font-medium">Payment</th>
                <th className="p-3 font-medium">Courier</th>
                <th className="p-3 font-medium">Calls</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((o) => (
                <tr key={o._id} className={cn("align-top hover:bg-muted/30", selected.has(o._id) && "bg-accent/50")}>
                  <td className="p-3">
                    <Checkbox
                      checked={selected.has(o._id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(o._id); else next.delete(o._id)
                        setSelected(next)
                      }}
                      aria-label={`Select ${invoice(o.invoiceNo)}`}
                    />
                  </td>
                  <td className="p-3">
                    <Link to="/order" search={{ id: o._id }} className="font-semibold text-tone-blue hover:underline">
                      {invoice(o.invoiceNo)}
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
                      <div className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-tone-orange">
                        <AlertTriangle className="size-3" /> {(o as any).dupes} other open order{(o as any).dupes > 1 ? "s" : ""} from this number
                      </div>
                    )}
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
                        <div className="font-medium">Pathao {o.consignmentId}</div>
                        <div className="text-muted-foreground">{o.courierStatus}</div>
                      </>
                    ) : o.courierError ? (
                      <div className="max-w-40 text-tone-red">{o.courierError}</div>
                    ) : (
                      <span className="text-muted-foreground">Pathao · not booked</span>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    <div className="tabular-nums">{o.callCount}</div>
                    {o.lastCallOutcome && <div className="text-muted-foreground">{o.lastCallOutcome}</div>}
                  </td>
                  <td className="p-3"><RowStatus id={o._id} status={o.status as OrderStatus} perms={me.perms} /></td>
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
function RowStatus({ id, status, perms }: { id: Id<"orders">; status: OrderStatus; perms: string[] }) {
  const change = useMutation(api.orders.changeStatus)
  const addNote = useMutation(api.orders.addNote)
  const [dialogTo, setDialogTo] = useState<OrderStatus | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const options = TRANSITIONS[status].filter((t) => hasPerm(perms, moveKey(status, t)))
  const move = async (to: OrderStatus) => {
    if (NEEDS_REASON.includes(to)) { setDialogTo(to); return }
    setBusy(true)
    try {
      const r = await change({ ids: [id], to })
      if (r.errors.length) toast.error(r.errors[0])
      else toast.success(`Moved to ${STATUS_LABEL[to]}`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={busy}>
          <button type="button" className="inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2" aria-label="Change status" data-testid="row-status">
            <StatusPill status={status} />
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
          {options.length === 0 && <DropdownMenuItem disabled>No moves allowed</DropdownMenuItem>}
          {options.map((t) => (
            <DropdownMenuItem key={t} onSelect={() => move(t)}>
              {STATUS_LABEL[t]}{NEEDS_REASON.includes(t) ? " …" : ""}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { setNote(""); setNoteOpen(true) }}>Add note…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {options.length > 0 && (
        <div className="mt-1.5 flex max-w-56 flex-wrap gap-1" data-testid="row-moves">
          <span className="w-full text-[10px] uppercase tracking-wide text-muted-foreground">Move to</span>
          {options.slice(0, 4).map((t) => (
            <button key={t} type="button" disabled={busy} onClick={() => move(t)} title={`Move to ${STATUS_LABEL[t]}`}
              className="rounded-full border bg-background px-0.5 py-0.5 transition hover:border-foreground/40 hover:shadow-sm disabled:opacity-50">
              <StatusPill status={t} />
            </button>
          ))}
        </div>
      )}
      <StatusDialog
        ids={[id]}
        options={options}
        initial={dialogTo ?? undefined}
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
