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
    expect(await as2.mutation(api.team.claim, {})).toBe("noAccess")
    expect(await as2.query(api.team.me, {})).toMatchObject({ kind: "noAccess" })
    await expect(as2.mutation(api.orders.create, baseOrder("x" as any, "y" as any))).rejects.toThrow()
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
