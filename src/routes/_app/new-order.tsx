import { useEffect, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES, PAYMENT_METHODS, hasPerm, moveKey, normalizePhone } from "@/convex/rules"
import { Guard, useMe } from "@/components/app-shell"
import { PageHeader, TagPill } from "@/components/bits"
import {
  CartEditor, PathaoAddress, ProductSearch, addToCart, suggestFee, useGeneralSettings, useTotals, type CartLine, type Place,
} from "@/components/order-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errMsg, invoice, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/new-order")({
  component: () => (
    <Guard perm="orders.create">
      <NewOrder />
    </Guard>
  ),
})

function NewOrder() {
  const me = useMe()
  const navigate = useNavigate()
  const create = useMutation(api.orders.create)
  const locations = useQuery(api.team.listLocations)
  const settings = useGeneralSettings()

  const [phone, setPhone] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [address, setAddress] = useState("")
  const [place, setPlace] = useState<Place>({})
  const [source, setSource] = useState("Facebook")
  const [deliveryType, setDeliveryType] = useState("regular")
  const [locationId, setLocationId] = useState<Id<"locations"> | undefined>()
  const [note, setNote] = useState("")
  const [cart, setCart] = useState<CartLine[]>([])
  const [discount, setDiscount] = useState(0)
  const [fee, setFee] = useState(0)
  const [feeTouched, setFeeTouched] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState("Cash On Delivery")
  const [advanceMode, setAdvanceMode] = useState<"none" | "delivery" | "full" | "custom">("none")
  const [customAdvance, setCustomAdvance] = useState(0)
  const [advanceMethod, setAdvanceMethod] = useState("bKash")
  const [advanceRef, setAdvanceRef] = useState("")
  const [busy, setBusy] = useState(false)

  const normalized = normalizePhone(phone)
  const validPhone = /^01\d{9}$/.test(normalized)
  const existing = useQuery(api.customers.byPhone, validPhone ? { phone: normalized } : "skip")

  useEffect(() => {
    if (!locationId && locations?.length) setLocationId((locations.find((l) => l.isDefault && l.active) ?? locations[0])._id)
  }, [locations, locationId])

  useEffect(() => {
    if (existing) {
      if (!name) setName(existing.name)
      if (!address && existing.address) setAddress(existing.address)
      if (!email && existing.email) setEmail(existing.email)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?._id])

  useEffect(() => {
    if (feeTouched) return
    setFee(deliveryType === "pickup" ? 0 : suggestFee(place.cityName, settings))
  }, [place.cityName, deliveryType, settings, feeTouched])

  const full = useTotals(cart, discount, fee, 0).total
  const advance = advanceMode === "delivery" ? fee : advanceMode === "full" ? full : advanceMode === "custom" ? Math.min(customAdvance, full) : 0
  const t = useTotals(cart, discount, fee, advance)
  const canApprove = hasPerm(me.perms, moveKey("pending", "approved"))

  const submit = async (approve: boolean) => {
    if (!validPhone) return toast.error("Enter a valid 11-digit phone number (01XXXXXXXXX)")
    if (!name.trim() || !address.trim()) return toast.error("Name and address are required")
    if (cart.length === 0) return toast.error("Add at least one product")
    if (!locationId) return toast.error("Choose a warehouse")
    if (approve && deliveryType !== "pickup" && (!place.pathaoCityId || !place.pathaoZoneId)) {
      return toast.error("Pick the Pathao city and zone before approving")
    }
    setBusy(true)
    try {
      const res = await create({
        source, customerName: name, phone: normalized, email: email || undefined, address, ...place,
        locationId, deliveryType,
        items: cart.map((c) => ({ variantId: c.variantId, qty: c.qty, price: c.price, discount: c.discount })),
        discount, deliveryFee: fee, advanceAmount: advance, advanceMethod, advanceReference: advanceRef || undefined,
        advanceKind: advanceMode === "none" ? undefined : advanceMode, paymentMethod, customerNote: note || undefined, approve,
      })
      toast.success(`Order ${invoice(res.invoiceNo)} created`)
      navigate({ to: "/order", search: { id: res.orderId } })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title="Create order" sub="Phone first — we'll fill in a returning customer's details." />
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr]">
        {/* Customer + delivery */}
        <section className="space-y-4 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Customer</h2>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" autoFocus />
            {existing && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-2.5 py-2 text-xs">
                <TagPill tag={existing.tag} />
                <span>{existing.orderCount} orders · {existing.deliveredCount} delivered · {existing.returnedCount} returned · {existing.cancelledCount} cancelled</span>
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Email <span className="font-normal text-muted-foreground">(optional)</span></Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Address</Label><Textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} placeholder="House, road, area" /></div>
          {deliveryType !== "pickup" && <PathaoAddress value={place} onChange={setPlace} />}
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
                <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{locations?.filter((l) => l.active).map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5"><Label>Note for courier / team</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call before delivery" /></div>
        </section>

        {/* Products */}
        <section className="flex h-[640px] flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Products</h2>
          <div className="min-h-0 flex-1">
            <ProductSearch locationId={locationId} onAdd={(l) => setCart((c) => addToCart(c, l))} />
          </div>
        </section>

        {/* Cart */}
        <section className="space-y-4 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Cart ({cart.reduce((s, c) => s + c.qty, 0)})</h2>
          <CartEditor cart={cart} onChange={setCart} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Order discount</Label><Input type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value) || 0)} /></div>
            <div className="space-y-1.5"><Label>Delivery fee</Label><Input type="number" value={fee} onChange={(e) => { setFee(Number(e.target.value) || 0); setFeeTouched(true) }} /></div>
            <div className="col-span-2 space-y-1.5">
              <Label>Payment type</Label>
              <Select value={paymentMethod} onValueChange={(m) => {
                setPaymentMethod(m)
                if (m === "Cash On Delivery") { if (advanceMode === "full") setAdvanceMode("none") }
                else { setAdvanceMode("full"); setAdvanceMethod(m) }
              }}>
                <SelectTrigger className="w-full" data-testid="payment-type"><SelectValue /></SelectTrigger>
                <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Advance received</Label>
              <div className="grid grid-cols-4 gap-1">
                {([["none", "None"], ["delivery", "Delivery charge"], ["full", "Full payment"], ["custom", "Custom"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setAdvanceMode(k)}
                    className={`rounded-md border px-1.5 py-1.5 text-xs ${advanceMode === k ? "border-foreground bg-foreground text-background" : "hover:bg-accent"}`}>{l}</button>
                ))}
              </div>
            </div>
            {advanceMode === "custom" && (
              <div className="col-span-2 space-y-1.5"><Label>Advance amount</Label><Input type="number" value={customAdvance} onChange={(e) => setCustomAdvance(Number(e.target.value) || 0)} /></div>
            )}
            {advance > 0 && (
              <>
                <div className="space-y-1.5">
                  <Label>Advance paid via</Label>
                  <Select value={advanceMethod} onValueChange={setAdvanceMethod}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{PAYMENT_METHODS.filter((m) => m !== "Cash On Delivery").map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5"><Label>Transaction ID</Label><Input value={advanceRef} onChange={(e) => setAdvanceRef(e.target.value)} placeholder="e.g. 9JK3LM2X" /></div>
              </>
            )}
          </div>
          <dl className="space-y-1 rounded-md bg-muted/60 p-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{taka(t.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Discounts</dt><dd className="tabular-nums">−{taka(t.itemDiscount + discount)}</dd></div>
            <div className="flex justify-between"><dt>Delivery</dt><dd className="tabular-nums">{taka(fee)}</dd></div>
            <div className="flex justify-between"><dt>Advance{advanceMode === "delivery" ? " (delivery charge)" : advanceMode === "full" ? " (full)" : ""}</dt><dd className="tabular-nums">−{taka(advance)}</dd></div>
            <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>{t.due === 0 ? "Fully paid — collect nothing" : "Collect (COD)"}</dt><dd className="tabular-nums">{taka(t.due)}</dd></div>
          </dl>
          <div className="flex flex-col gap-2">
            {canApprove && <Button disabled={busy} onClick={() => submit(true)}>Create & approve</Button>}
            <Button variant="outline" disabled={busy} onClick={() => submit(false)}>Create as Pending</Button>
          </div>
        </section>
      </div>
    </div>
  )
}
