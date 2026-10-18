import { useEffect, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { ChevronLeft, ChevronRight, Pencil, PhoneCall, Printer, Shuffle, Truck } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES, PAYMENT_METHODS, type OrderStatus } from "@/convex/rules"
import { Guard, useCan } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, Pill, StatusPill, TagPill } from "@/components/bits"
import {
  CallDialog, CartEditor, PathaoAddress, ProductSearch, StatusDialog, addToCart, type CartLine, type Place,
} from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, invoice, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

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
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  )
}

function OrderPage() {
  const { id } = Route.useSearch()
  const can = useCan()
  const data = useQuery(api.orders.get, id ? { id: id as Id<"orders"> } : "skip")
  const addNote = useMutation(api.orders.addNote)
  const retryBook = useAction(api.pathao.retryBook)
  const [statusOpen, setStatusOpen] = useState(false)
  const [initialStatus, setInitialStatus] = useState<OrderStatus | undefined>()
  const [callOpen, setCallOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [note, setNote] = useState("")
  const [filter, setFilter] = useState<"all" | "call" | "note" | "log">("all")
  const [booking, setBooking] = useState(false)

  if (!id) return <Empty title="No order selected" />
  if (data === undefined || data === null) return <Loading />
  if (data.missing) return <Empty title="Order not found" />
  const { order: o, events, payments, customer, history, next } = data
  const status = o.status as OrderStatus
  const events2 = events.filter((e) => filter === "all" || e.type === filter || (filter === "log" && e.type === "payment"))
  const editable = ["pending", "on_hold", "approved", "processing"].includes(status) && !o.consignmentId && can("orders.edit")
  const canBook = o.courier === "pathao" && !o.consignmentId && ["ready_to_ship", "processing", "approved"].includes(status) && can("courier.book")

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/orders" search={{ tab: "all" }} className="text-sm text-muted-foreground hover:underline">Orders</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-xl font-semibold">{invoice(o.invoiceNo)}</h1>
        <StatusPill status={o.status} />
        {o.reason && <span className="text-sm text-muted-foreground">— {o.reason}</span>}
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" disabled={!data.newerId} asChild={!!data.newerId} aria-label="Newer order">
            {data.newerId ? <Link to="/order" search={{ id: data.newerId }}><ChevronLeft className="size-4" /></Link> : <span><ChevronLeft className="size-4" /></span>}
          </Button>
          <Button variant="outline" size="icon-sm" disabled={!data.olderId} asChild={!!data.olderId} aria-label="Older order">
            {data.olderId ? <Link to="/order" search={{ id: data.olderId }}><ChevronRight className="size-4" /></Link> : <span><ChevronRight className="size-4" /></span>}
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setCallOpen(true)}><PhoneCall className="size-4" /> Log call</Button>
          {editable && <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}><Pencil className="size-4" /> Edit</Button>}
          {can("orders.print") && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/print?ids=${o._id}`, "_blank")}><Printer className="size-4" /> Invoice</Button>
          )}
          <Button size="sm" disabled={next.length === 0} onClick={() => { setInitialStatus(undefined); setStatusOpen(true) }}>
            <Shuffle className="size-4" /> Change status
          </Button>
        </div>
      </div>

      {/* Quick actions for the common next step */}
      {next.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">Move to:</span>
          {next.slice(0, 5).map((s) => (
            <Button key={s} variant="secondary" size="xs" onClick={() => { setInitialStatus(s); setStatusOpen(true) }}>
              <StatusPill status={s} />
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Customer" action={customer && <Link to="/customer" search={{ id: customer._id }} className="text-xs text-tone-blue hover:underline">Profile</Link>}>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{o.customerName}</span>
            {customer && <TagPill tag={customer.tag} />}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="tabular-nums">{o.phone}</span>
            <ContactButtons phone={o.phone} onCall={() => setTimeout(() => setCallOpen(true), 400)} />
          </div>
          {o.email && <div className="mt-1 text-sm text-muted-foreground">{o.email}</div>}
          <div className="mt-3 text-sm">{o.address}</div>
          <div className="text-sm text-muted-foreground">{[o.areaName, o.zoneName, o.cityName].filter(Boolean).join(", ") || "Pathao area not set"}</div>
          {customer && (
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              {[["Orders", customer.orderCount], ["Delivered", customer.deliveredCount], ["Returned", customer.returnedCount], ["Cancelled", customer.cancelledCount]].map(([k, v]) => (
                <div key={k} className="rounded-md bg-muted py-1.5"><div className="text-base font-semibold">{v}</div>{k}</div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Order">
          <Row k="Source" v={<>{o.source}{o.externalName ? ` · ${o.externalName}` : ""}</>} />
          <Row k="Created" v={dateTime(o.createdAt)} />
          <Row k="Created by" v={o.createdByName} />
          <Row k="Warehouse" v={data.locationName} />
          <Row k="Delivery" v={o.deliveryType === "pickup" ? "Store pickup" : o.deliveryType === "express" ? "Express" : "Regular"} />
          {o.shippingDate && <Row k="Shipped" v={dateTime(o.shippingDate)} />}
          <Row k="Calls" v={`${o.callCount}${o.lastCallOutcome ? ` · ${o.lastCallOutcome}` : ""}`} />
          {o.customerNote && <div className="mt-2 rounded-md bg-tone-amber-bg p-2 text-sm text-tone-amber">Note: {o.customerNote}</div>}
        </Card>

        <Card
          title="Courier"
          action={canBook && (
            <Button
              size="xs" variant="outline" disabled={booking}
              onClick={async () => {
                setBooking(true)
                try { await retryBook({ orderId: o._id }); toast.success("Sent to Pathao") } catch (e) { toast.error(errMsg(e)) } finally { setBooking(false) }
              }}
            >
              <Truck className="size-3.5" /> {o.courierError ? "Retry booking" : "Book now"}
            </Button>
          )}
        >
          {o.courier === "pickup" ? (
            <p className="text-sm text-muted-foreground">Customer picks up from the store.</p>
          ) : (
            <>
              <Row k="Courier" v="Pathao" />
              <Row k="Consignment" v={o.consignmentId ?? "Not booked"} />
              {o.courierStatus && <Row k="Pathao status" v={o.courierStatus} />}
              {o.courierFee !== undefined && <Row k="Courier charge" v={taka(o.courierFee)} />}
              {o.courierError && <div className="mt-2 rounded-md bg-tone-red-bg p-2 text-sm text-tone-red">{o.courierError}</div>}
              {!o.consignmentId && !o.courierError && (
                <p className="mt-2 text-xs text-muted-foreground">Booked automatically when the order reaches Ready To Ship.</p>
              )}
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Products (${o.items.reduce((s, i) => s + i.qty, 0)})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="pb-2">Product</th><th className="pb-2">SKU</th><th className="pb-2 text-right">Price</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Discount</th><th className="pb-2 text-right">Total</th></tr>
                </thead>
                <tbody className="divide-y">
                  {o.items.map((i, k) => (
                    <tr key={k}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          {i.imageUrl ? <img src={i.imageUrl} alt="" className="size-9 rounded object-cover" /> : <div className="size-9 rounded bg-muted" />}
                          <div>
                            <div className="font-medium">{i.name}</div>
                            {i.attrs && <div className="text-xs text-muted-foreground">{i.attrs}</div>}
                            {!i.variantId && <div className="text-xs text-tone-red">Not linked to a product — stock not tracked</div>}
                          </div>
                        </div>
                      </td>
                      <td className="py-2 text-xs">{i.sku}</td>
                      <td className="py-2 text-right tabular-nums">{taka(i.price)}</td>
                      <td className="py-2 text-right tabular-nums">{i.qty}</td>
                      <td className="py-2 text-right tabular-nums">{i.discount ? `−${taka(i.discount)}` : "—"}</td>
                      <td className="py-2 text-right font-medium tabular-nums">{taka(i.price * i.qty - i.discount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ml-auto mt-3 max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{taka(o.subtotal)}</dd></div>
              <div className="flex justify-between"><dt>Discount</dt><dd className="tabular-nums">−{taka(o.items.reduce((s, i) => s + i.discount, 0) + o.discount)}</dd></div>
              <div className="flex justify-between"><dt>Delivery fee</dt><dd className="tabular-nums">{taka(o.deliveryFee)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular-nums">{taka(o.total)}</dd></div>
              <div className="flex justify-between text-tone-green"><dt>Paid</dt><dd className="tabular-nums">−{taka(o.paidAmount)}</dd></div>
              <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Due</dt><dd className="tabular-nums">{taka(o.due)}</dd></div>
            </dl>
          </Card>

          <Card title="Payments" action={can("orders.payments") && <Button size="xs" variant="outline" onClick={() => setPayOpen(true)}>Add payment</Button>}>
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments yet. Due {taka(o.due)} will be collected on delivery.</p>
            ) : (
              <div className="divide-y text-sm">
                {payments.map((p) => (
                  <div key={p._id} className="flex justify-between py-1.5">
                    <span>{p.method}{p.reference ? ` · ${p.reference}` : ""} <span className="text-muted-foreground">· {p.byName} · {dateTime(p.at)}</span></span>
                    <span className="font-medium tabular-nums">{taka(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

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
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add internal note…" />
            <Button type="submit" size="sm" variant="outline">Add</Button>
          </form>
          <div className="mb-3 flex gap-1">
            {(["all", "call", "note", "log"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={cn("rounded-md px-2 py-1 text-xs capitalize", filter === f ? "bg-foreground text-background" : "bg-muted")}>
                {f === "all" ? "All" : f === "call" ? "Calls" : f === "note" ? "Notes" : "Activity"}
              </button>
            ))}
          </div>
          <ol className="space-y-3">
            {events2.map((e) => (
              <li key={e._id} className="border-l-2 pl-3" style={{ borderColor: "hsl(var(--border))" }}>
                <div className="flex items-center gap-1.5">
                  {e.type === "call" && <Pill tone={e.outcome === "Confirmed" ? "green" : "amber"}>Call</Pill>}
                  {e.type === "note" && <Pill tone="violet">Note</Pill>}
                  {e.type === "payment" && <Pill tone="green">Payment</Pill>}
                  <span className="text-xs text-muted-foreground">{e.byName} · {dateTime(e.at)}</span>
                </div>
                <div className="mt-0.5 text-sm">{e.text}</div>
              </li>
            ))}
            {events2.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
          </ol>
          {history.length > 0 && (
            <div className="mt-5 border-t pt-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other orders from this customer</div>
              {history.map((h) => (
                <Link key={h._id} to="/order" search={{ id: h._id }} className="flex items-center justify-between py-1 text-sm hover:underline">
                  <span>{invoice(h.invoiceNo)} · {taka(h.total)}</span>
                  <StatusPill status={h.status} />
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      <StatusDialog ids={[o._id]} options={next as OrderStatus[]} initial={initialStatus} open={statusOpen} onOpenChange={setStatusOpen} />
      <CallDialog
        orderId={o._id} open={callOpen} onOpenChange={setCallOpen}
        onConfirmed={() => {
          if ((next as string[]).includes("approved")) { setInitialStatus("approved"); setStatusOpen(true) }
        }}
      />
      <PaymentDialog orderId={o._id} due={o.due} deliveryFee={o.deliveryFee} consignmentId={o.consignmentId} open={payOpen} onOpenChange={setPayOpen} />
      {editOpen && <EditDialog order={o} onClose={() => setEditOpen(false)} />}
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

