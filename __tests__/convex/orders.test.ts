import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  const locations = await as.query(api.team.listLocations, {})
  const locationId = locations.find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [
      { sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-HSS-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ],
  })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  return { t, as, userId, locationId, v41 }
}

async function stockOf(t: ReturnType<typeof makeT>, variantId: Id<"variants">, locationId: Id<"locations">) {
  return await t.run((ctx) =>
    ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", variantId).eq("locationId", locationId)).unique(),
  )
}

const baseOrder = (locationId: Id<"locations">, variantId: Id<"variants">) => ({
  source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
  locationId, deliveryType: "pickup", items: [{ variantId, qty: 2, price: 1480, discount: 0 }],
  discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
})

describe("first run", () => {
  it("makes the first user Super Admin and creates roles + warehouses", async () => {
    const { as } = await setup()
    const me = await as.query(api.team.me, {})
    expect(me).toMatchObject({ kind: "ok", roleName: "Super Admin" })
    const roles = await as.query(api.team.listRoles, {})
    expect(roles.map((r) => r.name)).toEqual(["Super Admin", "Sales & Marketing", "Procurement & Sourcing", "Team CX", "Fulfillment", "Asst. O. of Fulfillment & Inventory"])
  })

  it("blocks a second stranger", async () => {
    const { t } = await setup()
    const other = await t.run((ctx) => ctx.db.insert("users", { email: "random@gmail.com" }))
    const as2 = t.withIdentity({ subject: `${other}|s2` })
    expect(await as2.mutation(api.team.claim, { name: "Injamam" })).toBe("waiting")
    expect(await as2.query(api.team.me, {})).toMatchObject({ kind: "waiting", name: "Injamam" })
    await expect(as2.mutation(api.orders.create, baseOrder("x" as any, "y" as any))).rejects.toThrow()
  })

  it("admin approves a sign-up with a role, then can switch single permissions off for that person", async () => {
    const { t, as, locationId, v41 } = await setup()
    const other = await t.run((ctx) => ctx.db.insert("users", { email: "injamam@blackbole.com" }))
    const as2 = t.withIdentity({ subject: `${other}|s2` })
    await as2.mutation(api.team.claim, { name: "Injamam" })
    const [req] = await as.query(api.team.listRequests, {})
    const cx = (await as.query(api.team.listRoles, {})).find((r) => r.name === "Team CX")!
    await as.mutation(api.team.approveRequest, { id: req._id, name: "Injamam", roleId: cx._id })
    expect(await as2.query(api.team.me, {})).toMatchObject({ kind: "ok", roleName: "Team CX" })
    // allowed by the role…
    await as2.mutation(api.orders.create, baseOrder(locationId, v41._id))
    // …until the admin switches it off for this person only
    const staff = (await as.query(api.team.listStaff, {})).find((s) => s.email === "injamam@blackbole.com")!
    await as.mutation(api.team.setStaffPerms, { id: staff._id, extraPerms: [], deniedPerms: ["orders.create"] })
    await expect(as2.mutation(api.orders.create, baseOrder(locationId, v41._id))).rejects.toThrow()
  })
})

describe("order lifecycle", () => {
  it("moves stock through every bucket and back", async () => {
    const { t, as, locationId, v41 } = await setup()
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 10 })

    const created = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const orderId = created.orderId as Id<"orders">
    expect(created.invoiceNo).toBe(20001)
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 10, processing: 0 })

    const move = async (to: any) => {
      const r = await as.mutation(api.orders.changeStatus, { ids: [orderId], to })
      expect(r.errors).toEqual([])
    }
    await move("approved")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 8, processing: 2 })
    await move("processing")
    await move("ready_to_ship")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 8, processing: 2 })
    await move("in_transit")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ processing: 0, inTransit: 2 })
    await move("delivered_due")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 8, inTransit: 0 })

    let order = (await t.run((ctx) => ctx.db.get(orderId)))!
    let customer = (await t.run((ctx) => ctx.db.get(order.customerId)))!
    expect(customer).toMatchObject({ phone: "01711000000", deliveredCount: 1, tag: "REGULAR", totalSpent: 2960 })

    await move("delivered_paid")
    order = (await t.run((ctx) => ctx.db.get(orderId)))!
    expect(order).toMatchObject({ paidAmount: 2960, due: 0 })

    await move("pending_returned")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 8, returning: 2 })
    await move("returned")
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 10, returning: 0 })
    customer = (await t.run((ctx) => ctx.db.get(order.customerId)))!
    expect(customer).toMatchObject({ deliveredCount: 0, returnedCount: 1 })

    const counts = await as.query(api.orders.counts, {})
    expect(counts).toMatchObject({ flagged: 1, pending: 0, delivered: 0, all: 1 })
  })

  it("rejects moves the state machine does not allow", async () => {
    const { as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const r = await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "delivered_paid" })
    expect(r.done).toBe(0)
    expect(r.errors[0]).toMatch(/can't move/)
  })

  it("cancelling an approved order puts stock back", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), approve: true })
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 8, processing: 2 })
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "cancelled", reason: "Customer cancelled" })
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 10, processing: 0 })
  })

  it("lets a Pathao order reach Ready To Ship without city/zone", async () => {
    const { t, as, locationId, v41 } = await setup()
    await t.run((ctx) => ctx.db.insert("deliveryPartners", { code: 2001, name: "Pathao", provider: "pathao", locationId, active: true, createdAt: Date.now() }))
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), deliveryType: "regular" })
    expect((await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })).done).toBe(1)
    // Pathao now detects city/zone from the address, so Ready To Ship is allowed without them
    const r = await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "ready_to_ship" })
    expect(r.done).toBe(1)
  })

  it("sends to Pathao at In Transit by default (like Nuport), not at Ready To Ship", async () => {
    const { t, as, locationId, v41 } = await setup()
    await t.run((ctx) => ctx.db.insert("deliveryPartners", { code: 2001, name: "Pathao", provider: "pathao", locationId, active: true, createdAt: Date.now() }))
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), deliveryType: "regular", approve: true })
    const booking = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))
      .filter((f: any) => f.name.includes("bookOrder") && f.args[0]?.orderId === orderId).length
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "processing" })
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "ready_to_ship" })
    expect(await booking()).toBe(0)
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "in_transit" })
    expect(await booking()).toBe(1)
  })

  it("editing an approved order re-reserves the new quantity", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), approve: true })
    await as.mutation(api.orders.update, {
      id: orderId, customerName: "Test Customer", phone: "01711000000", address: "House 1, Road 2, Lalmatia",
      locationId, deliveryType: "pickup", source: "Facebook",
      items: [{ variantId: v41._id, qty: 5, price: 1400, discount: 100 }], keepUnmatched: [], discount: 0, deliveryFee: 0,
    })
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 5, processing: 5 })
    const order = (await t.run((ctx) => ctx.db.get(orderId)))!
    expect(order).toMatchObject({ total: 6900, due: 6900 })
  })

  it("logs calls and advance payments", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), deliveryFee: 130, advanceAmount: 200 })
    await as.mutation(api.orders.logCall, { id: orderId, outcome: "No answer" })
    await as.mutation(api.orders.logCall, { id: orderId, outcome: "Confirmed", note: "Size 41 ok" })
    const order = (await t.run((ctx) => ctx.db.get(orderId)))!
    expect(order).toMatchObject({ callCount: 2, lastCallOutcome: "Confirmed", total: 3090, paidAmount: 200, due: 2890 })
  })
})

describe("permissions", () => {
  it("customer care can approve but cannot ship", async () => {
    const { t, as, locationId, v41 } = await setup()
    const roles = await as.query(api.team.listRoles, {})
    const cx = roles.find((r) => r.name === "Team CX")!
    const cxUser = await t.run((ctx) => ctx.db.insert("users", { email: "cx@blackbole.com" }))
    await as.mutation(api.team.saveStaff, { email: "cx@blackbole.com", name: "Rumon", roleId: cx._id, active: true })
    const asCx = t.withIdentity({ subject: `${cxUser}|s3` })
    expect(await asCx.query(api.team.me, {})).toMatchObject({ kind: "ok", roleName: "Team CX" })

    const { orderId } = await asCx.mutation(api.orders.create, baseOrder(locationId, v41._id))
    expect((await asCx.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })).done).toBe(1)
    const r = await asCx.mutation(api.orders.changeStatus, { ids: [orderId], to: "processing" })
    expect(r.done).toBe(0)
    await expect(asCx.mutation(api.catalog.receiveStock, { locationId, updateCost: false, items: [{ variantId: v41._id, qty: 1, unitCost: 0 }] })).rejects.toThrow()
  })
})

describe("shopify ingest", () => {
  it("creates an order, matches SKUs, flags unknown ones, and ignores duplicates", async () => {
    const { t, locationId, v41 } = await setup()
    const payload = {
      source: "Website", externalId: "555", externalName: "#1001", customerName: "Web Buyer", phone: "01811000000",
      address: "Mirpur 12, Dhaka", cityName: "Dhaka",
      items: [
        { variantId: v41._id, sku: "BB-HSS-41", name: "Harbor", price: 1480, qty: 1, discount: 0, weightKg: 0.4 },
        { sku: "UNKNOWN-1", name: "Mystery", price: 500, qty: 1, discount: 0, weightKg: 0.2 },
      ],
      unmatchedSkus: ["UNKNOWN-1"], discount: 0, deliveryFee: 90, paid: 0, paidMethod: "Online",
    }
    const first = await t.mutation(internal.orders.ingest, payload)
    expect(first.skipped).toBe(false)
    const again = await t.mutation(internal.orders.ingest, payload)
    expect(again).toMatchObject({ skipped: true, invoiceNo: first.invoiceNo })
    const order = (await t.run((ctx) => ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", "555")).unique()))!
    expect(order).toMatchObject({ status: "pending", total: 2070, locationId })
    const events = await t.run((ctx) => ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", order._id)).collect())
    expect(events.some((e) => e.text.includes("UNKNOWN-1"))).toBe(true)
  })
})

describe("order search box", () => {
  it("finds an order by phone and invoice from any tab, and the plain list stays per tab", async () => {
    const { as, locationId, v41 } = await setup()
    const { orderId: id, invoiceNo } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const byPhone = await as.query(api.orders.list, { tab: "all", search: "01711000000", limit: 50 })
    expect(byPhone!.rows.map((r) => r._id)).toEqual([id])
    const byInvoice = await as.query(api.orders.list, { tab: "delivered", search: String(invoiceNo), limit: 50 })
    expect(byInvoice!.rows.map((r) => r._id)).toEqual([id])
    const none = await as.query(api.orders.list, { tab: "all", search: "01799999999", limit: 50 })
    expect(none!.rows).toEqual([])
    const pending = await as.query(api.orders.list, { tab: "pending", limit: 50 })
    expect(pending!.rows.map((r) => r._id)).toContain(id)
    const delivered = await as.query(api.orders.list, { tab: "delivered", limit: 50 })
    expect(delivered!.rows).toEqual([])
  })
})

describe("Pathao money sync", () => {
  it("links a parcel by order number, then marks Pathao payout from the invoice", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId, invoiceNo } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), deliveryType: "regular" })
    await t.run((ctx) => ctx.db.patch(orderId, { status: "in_transit" }))
    // a pending order with the same number on Pathao must NOT be linked
    const r0 = await t.mutation(internal.pathao.applyParcels, { rows: [{ cid: "DB241026TEST01", mid: `BB-${invoiceNo}`, billing: "Unpaid", fee: 110, type: "Delivery", phone: "01811999999" }] }) // phone differs: not linked
    const r1 = await t.mutation(internal.pathao.applyParcels, { rows: [{ cid: "DB241026TEST01", mid: `BB-${invoiceNo}`, billing: "Unpaid", fee: 110, type: "Delivery", phone: "+8801711000000" }] })
    expect(r0).toEqual({ linked: 0, updated: 0 })
    expect(r1).toEqual({ linked: 1, updated: 1 })
    let o = await t.run((ctx) => ctx.db.get(orderId))
    expect(o).toMatchObject({ consignmentId: "DB241026TEST01", courier: "pathao", courierLinkedBy: "order no", courierCost: 110 })
    expect((o as any).courierPaid).toBeUndefined()
    const toPaid = await t.mutation(internal.pathao.applyInvoice, {
      inv: { invoiceId: "241026TESTINV", createdAt: Date.now(), collected: 2960, deliveryFee: 110, codFee: 29.6, discount: 15, totalFee: 124.6, receivable: 2835.4, status: "paid" },
      lines: [{ cid: "DB241026TEST01", type: "delivery", collected: 2960, payout: 2835.4, fee: 124.6 }],
    })
    expect(toPaid.map((x) => x.id)).toEqual([orderId])
    o = await t.run((ctx) => ctx.db.get(orderId))
    expect(o).toMatchObject({ courierPaid: true, courierInvoiceId: "241026TESTINV", courierCollected: 2960, courierPayout: 2835.4 })
    // running the same invoice again changes nothing
    const again = await t.mutation(internal.pathao.applyInvoice, {
      inv: { invoiceId: "241026TESTINV", createdAt: Date.now(), collected: 2960, deliveryFee: 110, codFee: 29.6, discount: 15, totalFee: 124.6, receivable: 2835.4, status: "paid" },
      lines: [{ cid: "DB241026TEST01", type: "delivery", collected: 2960, payout: 2835.4, fee: 124.6 }],
    })
    expect(again.length).toBe(1)
    const events = await t.run((ctx) => ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect())
    expect(events.filter((e) => e.text.startsWith("Pathao paid us")).length).toBe(1)
  })
})

describe("same phone, more than one open order", () => {
  it("counts and filters double orders like Nuport, and marks each row", async () => {
    const { as, locationId, v41 } = await setup()
    await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await as.mutation(api.orders.create, baseOrder(locationId, v41._id)) // same phone again
    await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), phone: "01811222333" })
    expect(await as.query(api.orders.sameNumberCount, { tab: "pending" })).toBe(2)
    const dup: any = await as.query(api.orders.list, { tab: "pending", flag: "duplicate", limit: 50 })
    expect(dup.rows).toHaveLength(2)
    expect(dup.rows.every((r: any) => r.dupes === 1)).toBe(true)
    const all: any = await as.query(api.orders.list, { tab: "pending", limit: 50 })
    expect(all.rows.find((r: any) => r.phone === "01811222333").dupes).toBe(0)
    expect(await as.query(api.orders.sameNumberCount, { tab: "delivered" })).toBeNull()
  })
})

describe("exchange warehouses", () => {
  it("orders from an exchange warehouse are never sent to Pathao, even at In Transit", async () => {
    const { t, as, locationId, v41 } = await setup()
    await t.run((ctx) => ctx.db.insert("deliveryPartners", { code: 2001, name: "Pathao Ctg", provider: "pathao", locationId, active: true, createdAt: Date.now() }))
    await t.mutation(internal.team.addExchangeWarehouses, {})
    const ex = (await as.query(api.team.listLocations, {})).find((l: any) => l.name === "Blackbole CTG Exchange")!
    expect(ex.noCourier).toBe(true)
    await as.mutation(api.catalog.receiveStock, { locationId: ex._id, updateCost: false, items: [{ variantId: v41._id, qty: 5, unitCost: 500 }] })
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(ex._id, v41._id), deliveryType: "regular", approve: true })
    let o: any = await t.run((ctx) => ctx.db.get(orderId))
    expect(o).toMatchObject({ courier: "manual", isExchange: true })
    for (const st of ["processing", "ready_to_ship", "in_transit"]) await as.mutation(api.orders.changeStatus, { ids: [orderId], to: st as any })
    const booked = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f: any) => f.name.includes("bookOrder") && f.args[0]?.orderId === orderId)
    expect(booked).toHaveLength(0)
    const r = await as.action(api.pathao.pushMany, { ids: [orderId] })
    expect(r.skipped[0]).toMatch(/exchange warehouse/)
    // an exchange made from a normal order goes to the exchange warehouse
    const orig = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), deliveryType: "regular" })
    const exo = await as.mutation(api.orders.createExchange, { id: orig.orderId, items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }], deliveryFee: 0 })
    o = await t.run((ctx) => ctx.db.get(exo.orderId))
    expect(o.locationId).toBe(ex._id)
    expect(o.courier).toBe("manual")
  })
})

describe("sub-tabs", () => {
  it("Delivered splits into Payment Due / Collected with their own counts", async () => {
    const { t, as, locationId, v41 } = await setup()
    const a = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const b = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    for (const [id, to] of [[a.orderId, "delivered_due"], [b.orderId, "delivered_paid"]] as const) {
      for (const st of ["approved", "processing", "ready_to_ship", "in_transit", "delivered_due"]) await as.mutation(api.orders.changeStatus, { ids: [id], to: st as any })
      if (to === "delivered_paid") await as.mutation(api.orders.changeStatus, { ids: [id], to })
    }
    const c: any = await as.query(api.orders.counts, {})
    expect(c).toMatchObject({ delivered: 2, "st:delivered_due": 1, "st:delivered_paid": 1 })
    const due: any = await as.query(api.orders.list, { tab: "delivered", status: "delivered_due", limit: 50 })
    expect(due.rows.map((r: any) => r._id)).toEqual([a.orderId])
    void t
  })
})

describe("abandoned carts", () => {
  const cart = (v41: Id<"variants">, over: Record<string, unknown> = {}) => ({
    checkoutId: "900001", token: "tok1", customerName: "Cart Buyer", phone: "+8801812345678", address: "Road 5, Dhanmondi", cityName: "Dhaka",
    items: [{ variantId: v41, sku: "BB-HSS-41", name: "Harbor Shore Sandal - Black", attrs: "41", price: 1480, qty: 1, discount: 0, weightKg: 0.4 }],
    subtotal: 1480, discount: 0, deliveryFee: 90, total: 1570, recoveryUrl: "https://blackbole.com/x/recover",
    shopCreatedAt: Date.now() - 3600000, shopUpdatedAt: Date.now() - 3600000, completed: false, ...over,
  })

  it("lists carts left for 15+ minutes; a website order closes them", async () => {
    const { t, as, v41 } = await setup()
    await t.mutation(internal.checkouts.upsertFromShopify, cart(v41._id))
    await t.mutation(internal.checkouts.upsertFromShopify, cart(v41._id, { checkoutId: "900002", token: "tok2", shopUpdatedAt: Date.now() - 60000 })) // still paying
    let rows: any = await as.query(api.checkouts.list, { tab: "new" })
    expect(rows.map((r: any) => r.checkoutId)).toEqual(["900001"])
    expect(rows[0].phone).toBe("01812345678")
    await t.mutation(internal.checkouts.markOrdered, { token: "tok1", externalId: "shopify-1" })
    rows = await as.query(api.checkouts.list, { tab: "new" })
    expect(rows).toHaveLength(0)
    expect(await as.query(api.checkouts.list, { tab: "ordered" })).toHaveLength(1)
  })

  it("call log moves it to follow-up; confirming makes an Approved order and reserves stock", async () => {
    const { t, as, locationId, v41 } = await setup()
    await t.mutation(internal.checkouts.upsertFromShopify, cart(v41._id))
    const [c]: any = await as.query(api.checkouts.list, { tab: "new" })
    await as.mutation(api.checkouts.logCall, { id: c._id, outcome: "Will order later", followUpAt: Date.now() - 1000 })
    expect(await as.query(api.checkouts.list, { tab: "new" })).toHaveLength(0)
    expect(await as.query(api.checkouts.counts, {})).toMatchObject({ new: 0, followup: 1, followupDue: 1 })
    const r = await as.mutation(api.checkouts.convert, { id: c._id, customerName: "Cart Buyer", phone: "01812345678", address: "Road 5, Dhanmondi", deliveryFee: 90, status: "approved" })
    const o: any = await t.run((ctx) => ctx.db.get(r.orderId))
    expect(o).toMatchObject({ status: "approved", total: 1570, externalName: "Abandoned cart" })
    expect(await stockOf(t, v41._id, locationId)).toMatchObject({ available: 9, processing: 1 })
    expect(await as.query(api.checkouts.counts, {})).toMatchObject({ followup: 0, recovered30d: 1, recoveredValue30d: 1570 })
    await expect(as.mutation(api.checkouts.convert, { id: c._id, customerName: "x", phone: "01812345678", address: "y", deliveryFee: 90, status: "approved" })).rejects.toThrow()
  })
})

describe("call log follow-up", () => {
  it("'Will confirm later' sets a follow-up time; a later confirmed call clears it", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const at = Date.now() + 60000 // a minute from now: still "today" whatever time the test runs
    await as.mutation(api.orders.logCall, { id: orderId, outcome: "Will confirm later", note: "after salary", followUpAt: at })
    let o: any = await t.run((ctx) => ctx.db.get(orderId))
    expect(o).toMatchObject({ callCount: 1, lastCallOutcome: "Will confirm later", followUpAt: at })
    const due = await as.query(api.orders.list, { tab: "pending", flag: "followUp", limit: 50 } as any)
    expect(JSON.stringify(due)).toContain(orderId)
    await as.mutation(api.orders.logCall, { id: orderId, outcome: "Confirmed" })
    o = await t.run((ctx) => ctx.db.get(orderId))
    expect(o.callCount).toBe(2)
    expect(o.followUpAt).toBeUndefined()
  })
})

describe("Nuport status sync", () => {
  it("gives our orders Nuport's invoice numbers and moves our-only orders out of the way", async () => {
    const { t, as, locationId, v41 } = await setup()
    const a = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const b = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const d = await as.mutation(api.orders.create, baseOrder(locationId, v41._id)) // only in our app
    await t.run(async (ctx) => {
      await ctx.db.patch(a.orderId, { externalName: "#40001" })
      await ctx.db.patch(b.orderId, { externalName: "#40002" })
    })
    const X = a.invoiceNo
    const res = await as.action(api.migrate.nuportSyncNow, { rows: [
      { inv: `BB-${X + 2}`, shopify: "40001", phone: null, cid: null, status: "keep", nuport: "Delivered" },
      { inv: `BB-${X + 3}`, shopify: "40002", phone: null, cid: null, status: "approved", nuport: "Approved" },
    ] })
    expect(res).toMatchObject({ renumbered: 2, changed: 1 })
    const [oa, ob, od] = await t.run(async (ctx) => [await ctx.db.get(a.orderId), await ctx.db.get(b.orderId), await ctx.db.get(d.orderId)]) as any[]
    expect(oa.invoiceNo).toBe(X + 2)
    expect(ob.invoiceNo).toBe(X + 3)
    expect(ob.status).toBe("approved")
    expect(od.invoiceNo).toBe(X + 4) // was X+2, which now belongs to Nuport's order
    const next = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    expect(next.invoiceNo).toBe(X + 5)
  })

  it("makes our status the same as Nuport's (by Shopify no or invoice+phone), quietly and without booking", async () => {
    const { t, as, locationId, v41 } = await setup()
    const a = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const b = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await t.run((ctx) => ctx.db.patch(a.orderId, { externalName: "#29999" }))
    const res = await as.action(api.migrate.nuportSyncNow, { rows: [
      { inv: "BB-99999", shopify: "29999", phone: null, cid: "DB241026AAAA11", status: "in_transit", nuport: "In-Transit" },
      { inv: `BB-${b.invoiceNo}`, shopify: null, phone: "+8801711000000", cid: null, status: "cancelled", nuport: "Cancelled" },
      { inv: "BB-1", shopify: null, phone: "01700000000", cid: null, status: "approved", nuport: "Approved" },
    ] })
    expect(res).toMatchObject({ received: 3, changed: 2, linked: 1, unmatched: ["BB-1"] })
    // same invoice number but a different Shopify order / phone must NOT match
    const c = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await t.run((ctx) => ctx.db.patch(c.orderId, { externalName: "#30001" }))
    const wrong = await as.action(api.migrate.nuportSyncNow, { rows: [
      { inv: `BB-${c.invoiceNo}`, shopify: "30555", phone: null, cid: null, status: "cancelled", nuport: "Cancelled" },
      { inv: `BB-${c.invoiceNo}`, shopify: null, phone: "01799999999", cid: "RB241026RRRR11", status: "returned", nuport: "Returned" },
    ] })
    expect(wrong).toMatchObject({ changed: 0, linked: 0 })
    expect((await t.run((ctx) => ctx.db.get(c.orderId)) as any)!.status).toBe("pending")
    const oa = await t.run((ctx) => ctx.db.get(a.orderId))
    const ob = await t.run((ctx) => ctx.db.get(b.orderId))
    expect(oa).toMatchObject({ status: "in_transit", consignmentId: "DB241026AAAA11" })
    expect((ob as any)!.status).toBe("cancelled")
    // running again changes nothing
    const again = await as.action(api.migrate.nuportSyncNow, { rows: [{ inv: "BB-99999", shopify: "29999", phone: null, cid: "DB241026AAAA11", status: "in_transit", nuport: "In-Transit" }] })
    expect(again).toMatchObject({ changed: 0, alreadySame: 1 })
    const counts = await as.query(api.orders.counts, {})
    expect(counts!.in_transit).toBe(1)
    expect(counts!.cancelled).toBe(1)
  })
})

describe("pre-order", () => {
  it("approving an order with a PO- product sends it to Pre-Order, then it can go on to Processing", async () => {
    const { t, as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "Retro Chunky Sole Sneaker", active: true,
      variants: [{ sku: "PO-RCS-BR-41", title: "41", weightKg: 0.5, price: 2490, purchasePrice: 900, active: true }],
    })
    const po = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "PO-RCS-BR-41")).unique()))!
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, po._id))
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.preOrder).toBe(true)
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("pre_order")
    const counts = await as.query(api.orders.counts, {})
    expect(counts!.pre_order).toBe(1)
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "processing" })
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("processing")
  })

  it("a product switched to pre-order counts too; normal products still go to Approved", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("approved")
    await t.run(async (ctx) => { await ctx.db.patch(v41.productId, { preOrder: true }) })
    const { orderId: o2 } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await as.mutation(api.orders.changeStatus, { ids: [o2], to: "approved" })
    expect((await t.run((ctx) => ctx.db.get(o2 as Id<"orders">)))!.status).toBe("pre_order")
    // one-time back-fill moves the earlier Approved one too
    const r = await t.mutation(internal.orders.markPreOrders, {})
    expect(r.moved).toBe(1)
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("pre_order")
  })
})

describe("shopify pre-order advance", () => {
  it("reads the full price from the line notes", async () => {
    const { preOrderFullPrice } = await import("../../convex/shopify")
    expect(preOrderFullPrice({ price: "1584.00", quantity: 1, properties: [{ name: "Pre-order", value: "Arrives in 15–20 days" }, { name: "Full price", value: "Tk 3,168" }, { name: "Due on delivery", value: "Tk 1,584" }] })).toBe(3168)
    expect(preOrderFullPrice({ price: "1451", quantity: 1, properties: [{ name: "Due on delivery", value: "Tk 1,451" }] })).toBe(2902)
    expect(preOrderFullPrice({ price: "1480", quantity: 1, properties: [] })).toBeNull()
  })
})

describe("pre-order origin", () => {
  it("a Bangladesh pre-order product goes to the Bangladesh sub-tab", async () => {
    const { t, as, locationId, v41 } = await setup()
    await t.run(async (ctx) => { await ctx.db.patch(v41.productId, { preOrder: true, preOrderFrom: "bangladesh" }) })
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("pre_order_bd")
    const c = await as.query(api.orders.counts, {})
    expect(c!.pre_order).toBe(1)
    expect(c!["st:pre_order_bd"]).toBe(1)
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "pre_order" })
    expect((await t.run((ctx) => ctx.db.get(orderId as Id<"orders">)))!.status).toBe("pre_order")
  })
})

describe("product search (new order)", () => {
  it("finds by SKU start, by name words, and by SKU middle", async () => {
    const { as } = await setup()
    expect((await as.query(api.catalog.searchVariants, { q: "bb-hss" })).map((r) => r.sku).sort()).toEqual(["BB-HSS-41", "BB-HSS-42"])
    expect((await as.query(api.catalog.searchVariants, { q: "harbor 42" })).map((r) => r.sku)).toEqual(["BB-HSS-42"])
    expect((await as.query(api.catalog.searchVariants, { q: "hss-41" })).map((r) => r.sku)).toEqual(["BB-HSS-41"])
    const r = await as.query(api.catalog.searchVariants, { q: "BB-HSS-41" })
    expect(r[0].available).toBe(10)
  })
})

describe("product search does not show loose matches", () => {
  it("a SKU piece does not list other products whose name starts with the same letters", async () => {
    const { as } = await setup()
    await as.mutation(api.catalog.saveProduct, { name: "Brinkley Breeze Sandal", active: true, variants: [{ sku: "BB-SAN-CDS-42", title: "42", weightKg: 0.4, price: 1980, purchasePrice: 700, active: true }] })
    expect((await as.query(api.catalog.searchVariants, { q: "HSS-BR" })).map((r) => r.sku)).toEqual([])
    expect((await as.query(api.catalog.searchVariants, { q: "brinkley" })).map((r) => r.sku)).toEqual(["BB-SAN-CDS-42"])
  })
})

describe("daily scoreboard", () => {
  it("gives the same dashboard numbers as counting every order, through creates, status moves, edits, payments, cancels and deletes", async () => {
    const { t, as, locationId, v41 } = await setup()
    const ids: any[] = []
    for (let i = 0; i < 6; i++) ids.push((await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), source: i % 2 ? "Website" : "Facebook" })).orderId)
    await as.mutation(api.orders.changeStatus, { ids: ids.slice(0, 4), to: "approved" })
    await as.mutation(api.orders.changeStatus, { ids: ids.slice(0, 3), to: "in_transit" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[0]], to: "delivered_due" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[1]], to: "delivered_paid" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[2]], to: "pending_returned" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[4]], to: "cancelled" })
    await as.mutation(api.orders.softDelete, { ids: [ids[5]] } as any).catch(() => {})
    const from = Date.now() - 2 * 86400000, to = Date.now() + 86400000
    const old = await t.query(internal.dashboard.statsData, { from, to }).catch(() => null)
    const rows = await t.query(internal.stats.days, { fromDay: "2000-01-01", toDay: "2100-01-01" })
    const { statsFromDays } = await import("../../convex/stats")
    const neu = statsFromDays(rows, from, to)
    // statsData needs a signed-in user; run it as the admin through t.run instead
    const scan = await t.run(async (ctx) => {
      const orders = (await ctx.db.query("orders").collect()).filter((o) => !o.deletedAt)
      const live = orders.filter((o) => o.status !== "cancelled")
      const byStatus: Record<string, number> = {}
      for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
      return { byStatus, totalOrders: live.length, totalSales: live.reduce((s, o) => s + o.total, 0), due: live.filter((o) => o.status === "delivered_due").reduce((s, o) => s + o.due, 0) }
    })
    expect(old === null || old.totalOrders === neu.totalOrders).toBe(true)
    expect(neu.byStatus).toEqual(scan.byStatus)
    expect(neu.totalOrders).toBe(scan.totalOrders)
    expect(neu.totalSales).toBe(scan.totalSales)
    expect(neu.dueCollect).toBe(scan.due)
    expect(neu.topItems[0].qty).toBe(scan.totalOrders * 2)
    // a from-scratch rebuild gives the very same rows
    await t.mutation(internal.stats.backfill, {})
    const rebuilt = await t.query(internal.stats.days, { fromDay: "2000-01-01", toDay: "2100-01-01" })
    expect(statsFromDays(rebuilt, from, to)).toEqual(neu)
    expect(await t.query(internal.stats.ready, {})).toBe(true)
  })
})

describe("shopify cart line notes", () => {
  it("never crashes on carts whose notes come as an object or are missing", async () => {
    const { preOrderFullPrice } = await import("../../convex/shopify")
    expect(preOrderFullPrice({ price: "1584", quantity: 1, properties: { "Full price": "Tk 3,168" } })).toBe(3168)
    expect(preOrderFullPrice({ price: "1584", quantity: 1, properties: {} })).toBeNull()
    expect(preOrderFullPrice({ price: "1584", quantity: 1, properties: null })).toBeNull()
    expect(preOrderFullPrice({ price: "1584", quantity: 1 })).toBeNull()
  })
})

describe("COD form leads", () => {
  it("saves the number typed in the COD popup, updates it, and closes it when the order comes in", async () => {
    const { t, as, locationId, v41 } = await setup()
    const lead = { phone: "01711999888", name: "Rahim", address: "", zone: "outside", items: [{ id: 1, sku: "BB-HSS-41", qty: 1, price: 1480, title: "Harbor Shore", variant: "41" }] }
    expect(await t.mutation(internal.checkouts.codLead, lead)).toBe("added")
    let c: any = await t.run((ctx) => ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", "codform:01711999888")).first())
    expect(c).toMatchObject({ kind: "codform", phone: "01711999888", status: "open", total: 1610, customerName: "Rahim" })
    expect(c.items[0].variantId).toBe(v41._id)
    await t.run(async (ctx) => { await ctx.db.patch(c._id, { shopUpdatedAt: Date.now() - 60000 }) })
    expect(await t.mutation(internal.checkouts.codLead, { ...lead, address: "House 5, Road 2, Agrabad, Chattogram" })).toBe("updated")
    expect(await t.mutation(internal.checkouts.codLead, { ...lead, phone: "123" })).toBe("bad phone")
    // popup gives only name + "EU 42": still matched to our product
    expect(await t.mutation(internal.checkouts.codLead, { ...lead, phone: "01811222333", items: [{ qty: 1, price: 1480, title: "Harbor Shore Sandal - Black", variant: "EU 42" }] })).toBe("added")
    const c2: any = await t.run((ctx) => ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", "codform:01811222333")).first())
    expect(c2.items[0].sku).toBe("BB-HSS-42")
    // the customer orders: the lead closes and new typing within 2 hours is ignored
    const { orderId } = await as.mutation(api.orders.create, { ...baseOrder(locationId, v41._id), phone: "01711999888" })
    c = await t.run((ctx) => ctx.db.get(c._id))
    expect(c.status).toBe("ordered")
    expect(c.orderId).toBe(orderId)
    expect(await t.mutation(internal.checkouts.codLead, lead)).toBe("already ordered")
  })
})
