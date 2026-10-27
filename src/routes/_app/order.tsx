import { useEffect, useState } from "react"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { ArrowRight, ChevronLeft, ChevronRight, Link2, Lock, Pencil, PhoneCall, Printer, Repeat, Shuffle, Truck } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES, PAYMENT_METHODS, STATUS_LABEL, TRANSITIONS, type OrderStatus } from "@/convex/rules"
import { Guard, useCan, Perm } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, Pill, StatusPill, TagPill } from "@/components/bits"
import {
  CallDialog, CartEditor, EXCHANGE_REASONS, PathaoAddress, ProductSearch, StatusDialog, addToCart, type CartLine, type Place, CourierHistory, PathaoTracking } from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { STATUS_TONE, TONE_CLASS, dateTime, errMsg, invoice, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { whTone } from "@/lib/warehouse"

export const Route = createFileRoute("/_app/order")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => (
    <Guard perm="orders.view">
      <OrderPage />
    </Guard>
  ),
})

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card shadow-xs">
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className="px-4 pb-4 pt-2">{children}</div>
    </section>
  )
}

const TILE_TONE: Record<string, string> = {
  blue: "border-t-tone-blue", green: "border-t-tone-green", amber: "border-t-tone-amber", violet: "border-t-tone-violet", red: "border-t-tone-red", gray: "border-t-tone-gray",
}
function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone: string }) {
  return (
    <div className={cn("rounded-xl border border-t-[3px] bg-card px-4 py-3", TILE_TONE[tone])}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

const isDelivered = (s: OrderStatus) => s === "delivered_due" || s === "delivered_paid"
const STEPS: { label: string; statuses: OrderStatus[] }[] = [
  { label: "Pending", statuses: ["pending", "on_hold"] },
  { label: "Approved", statuses: ["approved"] },
  { label: "Processing", statuses: ["processing", "pre_order", "pre_order_bd"] },
  { label: "Ready to ship", statuses: ["ready_to_ship"] },
  { label: "In transit", statuses: ["in_transit"] },
  { label: "Delivered", statuses: ["delivered_due", "delivered_paid"] },
]
/** Where the order is in the normal journey. Returns and cancellations show as a coloured note instead. */
function Progress({ status }: { status: OrderStatus }) {
  const off = status === "cancelled" ? { text: "This order was cancelled", cls: "bg-tone-gray-bg text-tone-gray" }
    : ["pending_returned", "returned", "damaged"].includes(status) ? { text: status === "pending_returned" ? "Coming back from the customer (return on the way)" : status === "damaged" ? "Returned damaged" : "Returned and received back", cls: "bg-tone-red-bg text-tone-red" }
    : null
  if (off) return <div className={cn("mx-5 my-3 rounded-lg px-3 py-2 text-sm font-medium", off.cls)}>{off.text}</div>
  const at = STEPS.findIndex((s) => s.statuses.includes(status))
  return (
    <ol className="flex items-center gap-1 overflow-x-auto px-5 py-4" data-testid="order-progress">
      {STEPS.map((s, i) => {
        const done = i < at, now = i === at
        return (
          <li key={s.label} className="flex min-w-fit flex-1 items-center gap-1">
            <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
              done ? "bg-tone-green text-white" : now ? "bg-foreground text-background ring-4 ring-foreground/10" : "bg-muted text-muted-foreground")}>
              {done ? "✓" : i + 1}
            </span>
            <span className={cn("whitespace-nowrap text-xs", now ? "font-semibold" : done ? "text-foreground" : "text-muted-foreground")}>
              {s.label}{now && status === "on_hold" ? " · on hold" : ""}{now && status === "delivered_paid" ? " · paid" : ""}
            </span>
            {i < STEPS.length - 1 && <span className={cn("mx-1 h-0.5 min-w-4 flex-1 rounded-full", i < at ? "bg-tone-green" : "bg-muted")} />}
          </li>
        )
      })}
    </ol>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  )
}

function OrderPage() {
  const { id } = Route.useSearch()
  const router = useRouter()
  const can = useCan()
  const data = useQuery(api.orders.get, id ? { id: id as Id<"orders"> } : "skip")
  const addNote = useMutation(api.orders.addNote)
  const retryBook = useAction(api.pathao.retryBook)
  const cancelParcel = useAction(api.pathao.cancelParcel)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [initialStatus, setInitialStatus] = useState<OrderStatus | undefined>()
  const [callOpen, setCallOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [exchangeOpen, setExchangeOpen] = useState(false)
  const [note, setNote] = useState("")
  const [filter, setFilter] = useState<"all" | "call" | "note" | "log">("all")
  const [booking, setBooking] = useState(false)

  if (!id) return <Empty title="No order selected" />
  if (data === undefined || data === null) return <Loading />
  if (data.missing) return <Empty title="Order not found" />
  const { order: o, events, payments, customer, history, next } = data
  const status = o.status as OrderStatus
  const events2 = events.filter((e) => filter === "all" || e.type === filter || (filter === "log" && e.type === "payment"))
  const editable = ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd"].includes(status) && !o.consignmentId && can("orders.edit")
  const canBook = o.courier === "pathao" && !o.consignmentId && ["approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship", "in_transit"].includes(status) && can("courier.book")
  // Pathao only lets a parcel be cancelled before the rider picks it up
  const PICKED = /picked|transit|sorting|hub|delivery|delivered|return|hold|paid|cancel/i
  const canCancelParcel = !!o.consignmentId && o.courier === "pathao" && /^DB/i.test(o.consignmentId) && !PICKED.test(o.courierStatus ?? "") && can("courier.book")

  const itemCount = o.items.reduce((s, i) => s + i.qty, 0)
  const itemDiscount = o.items.reduce((s, i) => s + i.discount, 0)
  const area = [o.areaName, o.zoneName, o.cityName].filter(Boolean).join(", ")
  const shippedNoParcel = o.courier !== "pickup" && !o.consignmentId && ["in_transit", "delivered_due", "delivered_paid", "pending_returned", "returned"].includes(status)
  const canExchange = ["delivered_due", "delivered_paid", "pending_returned", "returned", "damaged"].includes(status) && can("orders.create")
  const paymentType = o.paymentMethod ?? (o.paidAmount >= o.total && o.total > 0 ? "Paid" : o.paidAmount > 0 ? "Partly paid" : "Cash on delivery")

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      {/* ===== Header ===== */}
      <section className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
          <button type="button" onClick={() => router.history.back()} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" />Orders</button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" disabled={!data.newerId} asChild={!!data.newerId} aria-label="Newer order" title="Newer order">
              {data.newerId ? <Link to="/order" search={{ id: data.newerId }}><ChevronLeft className="size-4" /></Link> : <span><ChevronLeft className="size-4" /></span>}
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={!data.olderId} asChild={!!data.olderId} aria-label="Older order" title="Older order">
              {data.olderId ? <Link to="/order" search={{ id: data.olderId }}><ChevronRight className="size-4" /></Link> : <span><ChevronRight className="size-4" /></span>}
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setCallOpen(true)}><PhoneCall className="size-4" /> Log call</Button>
            {editable ? <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}><Pencil className="size-4" /> Edit</Button>
              : !can("orders.edit") && <Perm perm="orders.edit"><Button variant="outline" size="sm"><Pencil className="size-4" /> Edit</Button></Perm>}
            <Perm perm="orders.print">
              <Button variant="outline" size="sm" onClick={() => window.open(`/print?ids=${o._id}`, "_blank")}><Printer className="size-4" /> Invoice</Button>
            </Perm>
            {canExchange && (
              <Button variant="outline" size="sm" onClick={() => setExchangeOpen(true)}><Repeat className="size-4" /> Request exchange</Button>
            )}
            <Button size="sm" disabled={next.length === 0} onClick={() => { setInitialStatus(undefined); setStatusOpen(true) }}>
              <Shuffle className="size-4" /> Change status
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-1 px-5 pb-1 pt-2">
          <h1 className="text-2xl font-semibold tracking-tight">{o.invoiceCode ?? invoice(o.invoiceNo)}</h1>
          <StatusPill status={o.status} />
          {o.preOrder && <Pill tone="pink">Pre-order product{o.preOrderFrom === "bangladesh" ? " · Bangladesh" : o.preOrderFrom === "china" ? " · China" : ""}</Pill>}
          <span className="pb-0.5 text-sm text-muted-foreground">
            {o.source}{o.externalName ? ` ${o.externalName}` : ""} · {dateTime(o.createdAt)} · by {o.createdByName}
          </span>
        </div>
        {o.reason && <div className="mx-5 mt-2 rounded-md bg-tone-amber-bg px-3 py-1.5 text-sm text-tone-amber">Reason: {o.reason}</div>}

        <Progress status={status} />

        {/* Move to: every allowed next step; moves this person isn't allowed are shown locked */}
        {TRANSITIONS[status].length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3 text-sm">
            <span className="mr-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground sm:w-auto">Move to</span>
            {TRANSITIONS[status].map((s) => {
              const tone = STATUS_TONE[s] ?? "gray"
              return next.includes(s) ? (
                <button key={s} type="button" onClick={() => { setInitialStatus(s); setStatusOpen(true) }} data-testid={`move-${s}`}
                  className={cn("inline-flex items-center gap-1.5 rounded-lg border-2 px-3.5 py-2 text-sm font-semibold shadow-xs transition hover:-translate-y-0.5 hover:shadow-md active:translate-y-0", TONE_CLASS[tone], "border-current/25")}>
                  <ArrowRight className="size-3.5" />{STATUS_LABEL[s]}
                </button>
              ) : (
                <span key={s} title="Locked for you — ask your admin" className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border-2 border-dashed px-3.5 py-2 text-sm font-medium text-muted-foreground opacity-60">
                  <Lock className="size-3.5" />{STATUS_LABEL[s]}
                </span>
              )
            })}
          </div>
        )}
      </section>

      {/* ===== Money at a glance ===== */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Order total" value={taka(o.total)} hint={`${itemCount} item${itemCount === 1 ? "" : "s"} · delivery ${taka(o.deliveryFee)}`} tone="blue" />
        <Tile label="Paid" value={taka(o.paidAmount)} hint={payments.length ? `${payments.length} payment${payments.length === 1 ? "" : "s"}` : "Nothing paid yet"} tone="green" />
        <Tile label={isDelivered(status) ? "Still due" : "Collect on delivery"} value={taka(o.due)} hint={paymentType} tone={o.due > 0 ? "amber" : "green"} />
        {o.courier !== "pickup" && o.consignmentId && isDelivered(status) ? (
          <Tile
            label="Pathao payment"
            value={o.courierPaid ? <span className="text-tone-green">Paid to us</span> : <span className="text-tone-amber">Not paid yet</span>}
            hint={o.courierPaid
              ? `${o.courierPayout !== undefined ? `${taka(o.courierPayout)} received` : "Received"}${o.courierPaidAt ? ` · ${dateTime(o.courierPaidAt)}` : ""}${o.courierInvoiceId ? ` · Inv ${o.courierInvoiceId}` : ""}`
              : `Pathao will pay${o.courierCollected ? ` ${taka(o.courierCollected - (o.courierCost ?? 0))}` : ""} in its next invoice`}
            tone={o.courierPaid ? "green" : "amber"}
          />
        ) : (
          <Tile
            label="Courier"
            value={o.courier === "pickup" ? "Store pickup" : o.consignmentId ? <span className="text-base">{o.consignmentId}</span> : "Not booked"}
            hint={o.courier === "pickup" ? "Customer collects" : o.courierStatus ? `Pathao: ${o.courierStatus.replace(/[_-]+/g, " ")}` : o.courierError ? "Booking failed — see Delivery" : shippedNoParcel ? "Shipped, but not linked to a Pathao parcel" : o.consignmentId ? "Sent to Pathao" : "Not sent to Pathao yet"}
            tone={o.courierError || shippedNoParcel ? "red" : o.consignmentId ? "violet" : "gray"}
          />
        )}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-12">
        {/* ===== Main column ===== */}
        <div className="space-y-4 lg:col-span-8">
          <Card title={`Products · ${itemCount}`}>
            <div className="divide-y">
              {o.items.map((i, k) => (
                <div key={k} className="flex items-center gap-3 py-3 first:pt-0">
                  {i.imageUrl ? <img src={i.imageUrl} alt="" className="size-14 shrink-0 rounded-lg border object-cover" /> : <div className="size-14 shrink-0 rounded-lg bg-muted" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{i.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {i.attrs && <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{i.attrs}</span>}
                      <span className="font-mono">{i.sku}</span>
                    </div>
                    {!i.variantId && <div className="mt-0.5 text-xs text-tone-red">Not linked to a product — stock not tracked</div>}
                  </div>
                  <div className="text-right text-sm tabular-nums">
                    <div className="text-muted-foreground">{taka(i.price)} × {i.qty}</div>
                    {i.discount ? <div className="text-xs text-tone-green">−{taka(i.discount)}</div> : null}
                  </div>
                  <div className="w-24 text-right font-semibold tabular-nums">{taka(i.price * i.qty - i.discount)}</div>
                </div>
              ))}
            </div>
            <dl className="ml-auto mt-3 max-w-sm space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular-nums">{taka(o.subtotal)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd className="tabular-nums">−{taka(itemDiscount + o.discount)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Delivery fee</dt><dd className="tabular-nums">{taka(o.deliveryFee)}</dd></div>
              <div className="flex justify-between border-t pt-1.5 font-semibold"><dt>Total</dt><dd className="tabular-nums">{taka(o.total)}</dd></div>
              <div className="flex justify-between text-tone-green"><dt>Paid</dt><dd className="tabular-nums">−{taka(o.paidAmount)}</dd></div>
              <div className="flex justify-between text-base font-semibold"><dt>Due</dt><dd className={cn("tabular-nums", o.due > 0 && "text-tone-amber")}>{taka(o.due)}</dd></div>
            </dl>
          </Card>

          <Card title="Payments" action={<Perm perm="orders.payments"><Button size="xs" variant="outline" onClick={() => setPayOpen(true)}>Add payment</Button></Perm>}>
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments yet. Due {taka(o.due)} will be collected on delivery.</p>
            ) : (
              <div className="divide-y text-sm">
                {payments.map((p) => (
                  <div key={p._id} className="flex items-center justify-between gap-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-tone-green-bg px-2 py-0.5 text-xs font-semibold text-tone-green">{p.method}</span>
                      <span>{p.reference ? <span className="font-mono text-xs">{p.reference}</span> : null} <span className="text-xs text-muted-foreground">{p.byName} · {dateTime(p.at)}</span></span>
                    </div>
                    <span className="font-semibold tabular-nums">{taka(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {o.consignmentId && o.courier === "pathao" && <PathaoTracking orderId={o._id} consignmentId={o.consignmentId} />}
          {shippedNoParcel && <FindParcel orderId={o._id} phone={o.phone} />}
          {o.courier === "pathao" && (o.consignmentId || o.isExchange || o.exchangeOfId) && <ParcelGroup orderId={o._id} auto={!!(o.isExchange || o.exchangeOfId)} />}

          <Card title="Timeline">
            <form
              className="mb-3 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!note.trim()) return
                await addNote({ id: o._id, text: note })
                setNote("")
              }}
            >
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write an internal note for the team…" />
              <Button type="submit" size="sm">Add note</Button>
            </form>
            <div className="mb-4 flex gap-1">
              {(["all", "call", "note", "log"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-full px-3 py-1 text-xs font-medium", filter === f ? "bg-foreground text-background" : "bg-muted hover:bg-accent")}>
                  {f === "all" ? `All (${events.length})` : f === "call" ? "Calls" : f === "note" ? "Notes" : "Activity"}
                </button>
              ))}
            </div>
            <ol className="relative space-y-4 border-l pl-5">
              {events2.map((e) => (
                <li key={e._id} className="relative">
                  <span className={cn("absolute -left-[26px] top-1 size-3 rounded-full border-2 border-card",
                    e.type === "call" ? (e.outcome === "Confirmed" ? "bg-tone-green" : "bg-tone-amber") : e.type === "note" ? "bg-tone-violet" : e.type === "payment" ? "bg-tone-green" : "bg-muted-foreground/40")} />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {e.type === "call" && <Pill tone={e.outcome === "Confirmed" ? "green" : "amber"}>Call{e.outcome ? ` · ${e.outcome}` : ""}</Pill>}
                    {e.type === "note" && <Pill tone="violet">Note</Pill>}
                    {e.type === "payment" && <Pill tone="green">Payment</Pill>}
                    <span className="text-xs text-muted-foreground">{e.byName} · {dateTime(e.at)}</span>
                  </div>
                  <div className={cn("mt-1 text-sm", e.type === "note" && "rounded-md bg-tone-violet-bg/50 px-2.5 py-1.5")}>{e.text}</div>
                </li>
              ))}
              {events2.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
            </ol>
          </Card>
        </div>

        {/* ===== Side column ===== */}
        <div className="space-y-4 lg:col-span-4">
          <Card title="Customer" action={customer && <Link to="/customer" search={{ id: customer._id }} className="text-xs font-medium text-tone-blue hover:underline">Profile →</Link>}>
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tone-blue-bg text-sm font-semibold text-tone-blue">
                {o.customerName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{o.customerName}</span>
                  {customer && <TagPill tag={customer.tag} />}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">{o.phone}</span>
                  <ContactButtons phone={o.phone} onCall={() => setTimeout(() => setCallOpen(true), 400)} />
                </div>
                {o.email && <div className="mt-1 truncate text-sm text-muted-foreground">{o.email}</div>}
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Delivery address</div>
              <div className="mt-1">{o.address}</div>
              <div className={cn("mt-0.5 text-xs", area ? "text-muted-foreground" : "text-tone-amber")}>{area || "Pathao area not set"}</div>
            </div>
          </Card>

          <Card title="Can we trust this order?">
            {customer && <div className="text-xs font-semibold">With BlackBole</div>}
            {customer && <CustomerRatio s={data.customerStats} />}
            <CourierHistory phone={o.phone} />
          </Card>

          <Card
            title="Delivery"
            action={canBook ? (
              <Button
                size="xs" variant="outline" disabled={booking} data-testid="push-pathao"
                onClick={async () => {
                  setBooking(true)
                  try { await retryBook({ orderId: o._id }); toast.success("Sent to Pathao") } catch (e) { toast.error(errMsg(e)) } finally { setBooking(false) }
                }}
              >
                <Truck className="size-3.5" /> {booking ? "Sending…" : o.courierError ? "Try again" : "Push to Pathao"}
              </Button>
            ) : canCancelParcel ? (
              <Button
                size="xs" variant={confirmCancel ? "destructive" : "outline"} disabled={booking} data-testid="cancel-pathao"
                onClick={async () => {
                  if (!confirmCancel) { setConfirmCancel(true); setTimeout(() => setConfirmCancel(false), 5000); return }
                  setBooking(true)
                  try { await cancelParcel({ orderId: o._id }); toast.success("Parcel cancelled on Pathao") } catch (e) { toast.error(errMsg(e)) } finally { setBooking(false); setConfirmCancel(false) }
                }}
              >
                {booking ? "Cancelling…" : confirmCancel ? "Click again to cancel on Pathao" : "Cancel on Pathao"}
              </Button>
            ) : null}
          >
            {o.courier === "pickup" ? (
              <p className="text-sm text-muted-foreground">Customer picks up from the store.</p>
            ) : (
              <>
                <Row k="Courier" v="Pathao" />
                <Row k="Pathao" v={o.consignmentId
                  ? <span className="font-medium text-tone-blue">Sent · <span className="font-mono text-xs">{o.consignmentId}</span></span>
                  : o.courierError ? <span className="font-medium text-tone-red">Booking failed</span>
                  : <span className="text-muted-foreground">Not sent to Pathao yet</span>} />
                {o.courierStatus && <Row k="Pathao status" v={o.courierStatus} />}
                {o.courierFee !== undefined && <Row k="Courier charge" v={taka(o.courierCost ?? o.courierFee)} />}
                {o.courierCollected !== undefined && <Row k="Pathao collected" v={taka(o.courierCollected)} />}
                {o.consignmentId && <Row k="Pathao paid us" v={o.courierPaid ? <span className="text-tone-green">Yes{o.courierPayout !== undefined ? ` · ${taka(o.courierPayout)}` : ""}</span> : <span className="text-tone-amber">Not yet</span>} />}
                {o.courierInvoiceId && <Row k="Pathao invoice" v={<span className="font-mono text-xs">{o.courierInvoiceId}</span>} />}
                {o.courierLinkedBy && <Row k="Linked" v={o.courierLinkedBy === "manual" ? "By hand" : "Same order no. on Pathao"} />}
                {o.courierError && <div className="mt-2 rounded-md bg-tone-red-bg p-2 text-sm text-tone-red">{o.courierError}</div>}
                {!o.consignmentId && !o.courierError && (
                  <p className="mt-2 text-xs text-muted-foreground">Sent to Pathao automatically at the step chosen in Settings (In Transit, like Nuport), or press “Push to Pathao”.</p>
                )}
              </>
            )}
            <div className="mt-2 border-t pt-2">
              <Row k="Delivery type" v={o.deliveryType === "pickup" ? "Store pickup" : o.deliveryType === "express" ? "Express" : "Regular"} />
              <Row k="Warehouse" v={data.locationName ? <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold", whTone(data.locationName))}>{data.locationName}</span> : "—"} />
              {o.shippingDate && <Row k="Shipped" v={dateTime(o.shippingDate)} />}
            </div>
          </Card>

          <Card title="Order details">
            <Row k="Source" v={<>{o.source}{o.externalName ? ` · ${o.externalName}` : ""}</>} />
            <Row k="Created" v={dateTime(o.createdAt)} />
            <Row k="Created by" v={o.createdByName} />
            <Row k="Payment type" v={paymentType} />
            <Row k="Calls" v={`${o.callCount}${o.lastCallOutcome ? ` · ${o.lastCallOutcome}` : ""}`} />
            {o.followUpAt && <Row k="Call again" v={new Date(o.followUpAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} />}
            {o.customerNote && <div className="mt-2 rounded-md bg-tone-amber-bg p-2 text-sm text-tone-amber">Customer note: {o.customerNote}</div>}
          </Card>

          {history.length > 0 && (
            <Card title={`Other orders · ${history.length}`}>
              <div className="-my-1 divide-y">
                {history.map((h) => (
                  <Link key={h._id} to="/order" search={{ id: h._id }} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-tone-blue">
                    <span><span className="font-medium">{h.invoiceCode ?? invoice(h.invoiceNo)}</span> <span className="text-xs text-muted-foreground">· {taka(h.total)}</span></span>
                    <StatusPill status={h.status} />
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      <StatusDialog ids={[o._id]} options={next as OrderStatus[]} initial={initialStatus} open={statusOpen} onOpenChange={setStatusOpen} label={o.invoiceCode ?? invoice(o.invoiceNo)} from={status} confirmOnly={!!initialStatus} />
      <CallDialog
        orderId={o._id} open={callOpen} onOpenChange={setCallOpen}
        onConfirmed={() => {
          if ((next as string[]).includes("approved")) { setInitialStatus("approved"); setStatusOpen(true) }
        }}
      />
      <PaymentDialog orderId={o._id} due={o.due} deliveryFee={o.deliveryFee} consignmentId={o.consignmentId} open={payOpen} onOpenChange={setPayOpen} />
      {editOpen && <EditDialog order={o} onClose={() => setEditOpen(false)} />}
      {exchangeOpen && <ExchangeDialog order={o} onClose={() => setExchangeOpen(false)} />}
    </div>
  )
}

function PaymentDialog({ orderId, due, deliveryFee, consignmentId, open, onOpenChange }: { orderId: Id<"orders">; due: number; deliveryFee: number; consignmentId?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const add = useMutation(api.orders.addPayment)
  const [amount, setAmount] = useState(due)
  const [method, setMethod] = useState("bKash")
  const [ref, setRef] = useState("")
  useEffect(() => { if (open) setAmount(due) }, [open, due])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add payment</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex gap-1.5 sm:col-span-2">
            <Button type="button" size="xs" variant="outline" onClick={() => setAmount(Math.min(deliveryFee, due))}>Delivery charge ({taka(Math.min(deliveryFee, due))})</Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setAmount(due)}>Full due ({taka(due)})</Button>
          </div>
          <div className="space-y-1.5"><Label>Amount</Label><Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Transaction ID / reference</Label><Input value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <p className="text-xs text-muted-foreground sm:col-span-2">Collect (COD) after this payment: {taka(Math.max(0, due - amount))}
            {consignmentId ? " — already booked with the courier, so also update the COD amount in the courier's panel." : ""}</p>
        </div>
        <DialogFooter>
          <Button onClick={async () => {
            try { await add({ id: orderId, amount, method, reference: ref || undefined }); toast.success("Payment added"); onOpenChange(false); setRef("") } catch (e) { toast.error(errMsg(e)) }
          }}>Save payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({ order, onClose }: { order: Doc<"orders">; onClose: () => void }) {
  const update = useMutation(api.orders.update)
  const locations = useQuery(api.team.listLocations)
  const [name, setName] = useState(order.customerName)
  const [phone, setPhone] = useState(order.phone)
  const [email, setEmail] = useState(order.email ?? "")
  const [address, setAddress] = useState(order.address)
  const [place, setPlace] = useState<Place>({
    cityName: order.cityName, pathaoCityId: order.pathaoCityId, pathaoZoneId: order.pathaoZoneId,
    pathaoAreaId: order.pathaoAreaId, zoneName: order.zoneName, areaName: order.areaName,
  })
  const [source, setSource] = useState(order.source)
  const [deliveryType, setDeliveryType] = useState(order.deliveryType)
  const [locationId, setLocationId] = useState(order.locationId)
  const [note, setNote] = useState(order.customerNote ?? "")
  const [discount, setDiscount] = useState(order.discount)
  const [fee, setFee] = useState(order.deliveryFee)
  const unmatched = order.items.filter((i) => !i.variantId)
  const [keep, setKeep] = useState<string[]>(unmatched.map((i) => i.sku))
  const [cart, setCart] = useState<CartLine[]>(
    order.items.filter((i) => i.variantId).map((i) => ({
      variantId: i.variantId!, sku: i.sku, name: i.name, title: i.attrs ?? "", imageUrl: i.imageUrl,
      price: i.price, qty: i.qty, discount: i.discount, available: Number.POSITIVE_INFINITY,
    })),
  )
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>Edit {invoice(order.invoiceNo)}</DialogTitle></DialogHeader>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Address</Label><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
            {deliveryType !== "pickup" && <PathaoAddress value={place} onChange={setPlace} address={address} />}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{ORDER_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Delivery</Label>
                <Select value={deliveryType} onValueChange={setDeliveryType}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular">Regular</SelectItem>
                    <SelectItem value="express">Express</SelectItem>
                    <SelectItem value="pickup">Store pickup</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Warehouse</Label>
                <Select value={locationId} onValueChange={(v) => setLocationId(v as Id<"locations">)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{locations?.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5"><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Order discount</Label><Input type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value) || 0)} /></div>
              <div className="space-y-1.5"><Label>Delivery fee</Label><Input type="number" value={fee} onChange={(e) => setFee(Number(e.target.value) || 0)} /></div>
            </div>
          </div>
          <div className="space-y-3">
            {unmatched.length > 0 && (
              <div className="rounded-md border border-dashed p-3 text-sm">
                <div className="mb-2 font-medium">Lines not linked to a product</div>
                {unmatched.map((i) => (
                  <label key={i.sku} className="flex items-center gap-2 py-0.5">
                    <Checkbox checked={keep.includes(i.sku)} onCheckedChange={(v) => setKeep(v ? [...keep, i.sku] : keep.filter((x) => x !== i.sku))} />
                    {i.qty} × {i.name} ({i.sku}) — keep
                  </label>
                ))}
                <p className="mt-1 text-xs text-muted-foreground">Untick and add the right product below so stock is tracked.</p>
              </div>
            )}
            <CartEditor cart={cart} onChange={setCart} />
            <div className="h-72"><ProductSearch locationId={locationId} onAdd={(l) => setCart((c) => addToCart(c, l))} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await update({
                  id: order._id, customerName: name, phone, email: email || undefined, address, ...place,
                  locationId, deliveryType, source,
                  items: cart.map((c) => ({ variantId: c.variantId, qty: c.qty, price: c.price, discount: c.discount })),
                  keepUnmatched: keep, discount, deliveryFee: fee, customerNote: note || undefined,
                })
                toast.success("Order updated")
                onClose()
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/** One-click exchange: pick the reason + replacement item(s) against the already-delivered order, and it creates
 *  the linked exchange order in one shot (same backend action that used to have no button wired to it). */
function ExchangeDialog({ order, onClose }: { order: Doc<"orders">; onClose: () => void }) {
  const router = useRouter()
  const createExchange = useMutation(api.orders.createExchange)
  const [reason, setReason] = useState("")
  const [note, setNote] = useState("")
  const [fee, setFee] = useState(0)
  const [cart, setCart] = useState<CartLine[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!reason.trim()) { toast.error("Pick (or type) a reason"); return }
    if (cart.length === 0) { toast.error("Add the replacement item"); return }
    setBusy(true)
    try {
      const res = await createExchange({
        id: order._id,
        items: cart.map((c) => ({ variantId: c.variantId, qty: c.qty, price: c.price, discount: c.discount })),
        deliveryFee: fee,
        note: [reason.trim(), note.trim()].filter(Boolean).join(" — "),
      })
      toast.success(`Exchange order ${invoice(res.invoiceNo)} created and linked`)
      onClose()
      void router.navigate({ to: "/order", search: { id: res.orderId } })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Request exchange for {order.invoiceCode ?? invoice(order.invoiceNo)}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Reason <span className="font-normal text-tone-red">(required)</span></Label>
            <div className="flex flex-wrap gap-1.5">
              {EXCHANGE_REASONS.map((p) => (
                <button key={p} type="button" onClick={() => setReason(p)} className={cn("rounded-md border px-2 py-1 text-xs", reason === p ? "bg-accent" : "hover:bg-accent")}>{p}</button>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" />
          </div>
          <div className="space-y-1.5"><Label>Note to fulfillment (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. customer wants size 42 instead of 43" /></div>
          <div className="space-y-2">
            <Label>Replacement item{cart.length !== 1 ? "s" : ""}</Label>
            <CartEditor cart={cart} onChange={setCart} />
            <div className="h-64"><ProductSearch locationId={order.locationId} onAdd={(l) => setCart((c) => addToCart(c, l))} /></div>
          </div>
          <div className="space-y-1.5 sm:w-48"><Label>Delivery fee</Label><Input type="number" value={fee} onChange={(e) => setFee(Number(e.target.value) || 0)} /></div>
          <p className="text-xs text-muted-foreground">Creates a linked exchange order and routes it like every other exchange — the courier gets told to collect the old item when it's booked.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>Create exchange order</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CustomerRatio({ s }: { s: { orders: number; delivered: number; returned: number; cancelled: number; open: number; successRate: number | null } }) {
  const boxes: [string, number, string][] = [
    ["Orders", s.orders, "bg-tone-blue-bg text-tone-blue"],
    ["Delivered", s.delivered, "bg-tone-green-bg text-tone-green"],
    ["Returned", s.returned, "bg-tone-red-bg text-tone-red"],
    ["Cancelled", s.cancelled, "bg-tone-gray-bg text-tone-gray"],
  ]
  const rate = s.successRate
  const tone = rate === null ? "text-muted-foreground" : rate >= 80 ? "text-tone-green" : rate >= 50 ? "text-tone-amber" : "text-tone-red"
  return (
    <div className="mt-2" data-testid="customer-ratio">
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        {boxes.map(([k, v, c]) => (
          <div key={k} className={`rounded-md py-1.5 ${c}`}><div className="text-base font-semibold tabular-nums">{v}</div>{k}</div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{s.open > 0 ? `${s.open} open now` : "No other open orders"}</span>
        <span className={`font-semibold ${tone}`}>{rate === null ? "First delivery — no history yet" : `${rate}% delivery success`}</span>
      </div>
      {rate !== null && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-tone-red-bg"><div className="h-full rounded-full bg-tone-green" style={{ width: `${rate}%` }} /></div>
      )}
    </div>
  )
}


/** For orders shipped outside this app (e.g. booked on Pathao under another order number): pick the right Pathao parcel. */
function FindParcel({ orderId, phone }: { orderId: Id<"orders">; phone: string }) {
  const find = useAction(api.pathao.parcelsForOrder)
  const link = useMutation(api.pathao.linkParcel)
  const [rows, setRows] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState("")
  const search = async () => {
    setBusy(true)
    try { setRows(await find({ orderId })) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  const doLink = async (cid: string) => {
    try { await link({ orderId, consignmentId: cid }); toast.success(`Linked to ${cid}`) } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <section className="rounded-xl border-2 border-dashed border-tone-amber/60 bg-tone-amber-bg/30 p-4" data-testid="find-parcel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">This order isn't linked to a Pathao parcel</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">It was probably booked on Pathao under another order number (for example an exchange). Find the parcel by the customer's phone and link it — then tracking and Pathao payments show here.</p>
        </div>
        <Button size="sm" onClick={search} disabled={busy}><Link2 className="size-4" /> {busy ? "Searching…" : `Find parcels for ${phone}`}</Button>
      </div>
      {rows && (
        rows.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Pathao has no parcels for this phone in the last 90 days.</p> : (
          <div className="mt-3 divide-y rounded-lg border bg-card">
            {rows.map((r) => (
              <div key={r.cid} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <span className="font-mono font-semibold">{r.cid}</span>
                <span className="text-muted-foreground">{r.mid ?? "—"}{r.type ? ` · ${r.type}` : ""}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">{r.status}</span>
                <span className="tabular-nums">{taka(r.amount)}</span>
                {r.createdAt && <span className="text-xs text-muted-foreground">{dateTime(r.createdAt)}</span>}
                <span className="ml-auto">{r.usedBy ? <span className="text-xs text-muted-foreground">Linked to {r.usedBy}</span> : <Button size="xs" variant="outline" onClick={() => doLink(r.cid)}>Link this parcel</Button>}</span>
              </div>
            ))}
          </div>
        )
      )}
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) void doLink(manual) }}>
        <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="…or paste a consignment ID (e.g. DB241026VTAQZ3)" className="h-8 bg-card" />
        <Button type="submit" size="sm" variant="outline" disabled={!manual.trim()}>Link</Button>
      </form>
    </section>
  )
}


/** All Pathao parcels for this order and its exchange: Delivery (DB…), Exchange delivery (EB…), Return to you (RE…). */
function ParcelGroup({ orderId, auto }: { orderId: Id<"orders">; auto: boolean }) {
  const load = useAction(api.pathao.parcelGroup)
  const [data, setData] = useState<{ parcels: any[]; linked: boolean; candidates: { id: Id<"orders">; label: string }[] } | null>(null)
  const markExchange = useMutation(api.pathao.setExchangeOf)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try { const r = await load({ orderId }); setData(r); if (r.linked) toast.success("Exchange parcels linked to the exchange order") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  useEffect(() => { if (auto) void run() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, auto])
  const tone = (k: string) => k.startsWith("Exchange") ? "bg-tone-violet-bg text-tone-violet" : k.startsWith("Return") ? "bg-tone-orange-bg text-tone-orange" : "bg-tone-blue-bg text-tone-blue"
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="parcel-group">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">All Pathao parcels for this order</h2>
          <p className="text-xs text-muted-foreground">Delivery, exchange delivery and the return of the old item — as Pathao shows them for this order number.</p>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={busy}><Truck className="size-4" /> {busy ? "Checking Pathao…" : data ? "Refresh" : "Show all parcels"}</Button>
      </div>
      {data && data.candidates.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed p-3 text-xs">
          <div className="font-medium">Is this order an exchange? Link it to the customer's earlier order — then the exchange and return parcels Pathao made under that order number show and track here.</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.candidates.map((c) => (
              <Button key={c.id} size="xs" variant="outline" onClick={async () => {
                try { await markExchange({ id: orderId, originalId: c.id }); toast.success(`Marked as exchange of ${c.label}`); await run() } catch (e) { toast.error(errMsg(e)) }
              }}>Exchange of {c.label}</Button>
            ))}
          </div>
        </div>
      )}
      {data && (data.parcels.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Pathao has no parcels under this order number.</p> : (
        <div className="mt-3 divide-y rounded-lg border">
          {data.parcels.map((p) => (
            <div key={p.cid} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", tone(p.kind))}>{p.kind}</span>
              <span className="font-mono font-semibold">{p.cid}</span>
              <span className="text-xs text-muted-foreground">{p.mid}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">{p.status ?? "—"}</span>
              <span className="text-xs tabular-nums">COD {taka(p.cod)}{p.charge ? ` · charge ${taka(p.charge)}` : ""}</span>
              {p.billing && <span className="text-xs text-muted-foreground">{p.billing}</span>}
              {p.updatedAt && <span className="text-xs text-muted-foreground">updated {dateTime(p.updatedAt)}</span>}
              <span className="ml-auto text-xs">{p.usedBy ? <>in Ops: <b>{p.usedBy}</b></> : <span className="text-muted-foreground">not linked in Ops</span>}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}
