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
  const v42 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-42")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  return { t, as, locationId, v41, v42 }
}

const baseOrder = (locationId: Id<"locations">, variantId: Id<"variants">, qty = 1) => ({
  source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
  locationId, deliveryType: "pickup", items: [{ variantId, qty, price: 1480, discount: 0 }],
  discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
})

describe("hold with a customer-requested ship date", () => {
  it("sets an auto-approve date on hold, and clears it if the order is held again without one", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))

    const tomorrow = Date.now() + 2 * 86400000
    await as.mutation(api.orders.changeStatus, {
      ids: [orderId], to: "on_hold", reason: "Customer asked to ship on a date", autoApproveAt: tomorrow,
    })
    let order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order!.status).toBe("on_hold")
    expect(order!.autoApproveAt).toBe(tomorrow)

    // Re-recording the hold with a different reason and no date clears the stale schedule — a re-held order
    // can't silently keep an old promise to ship, same as the advance-payment fields.
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Stock not ready" })
    order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order!.autoApproveAt).toBeUndefined()
  })

  it("leaves it alone while on hold, fires the moment it's due, and never twice", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const future = Date.now() + 86400000
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Customer asked to ship on a date", autoApproveAt: future })

    // Not due yet — still on hold.
    await t.mutation(internal.orders.runAutoApprove, {})
    expect((await t.run((ctx) => ctx.db.get(orderId)))!.status).toBe("on_hold")

    // Move the clock by rewriting the stored date into the past (the sweep only reads the stored timestamp).
    await t.run((ctx) => ctx.db.patch(orderId, { autoApproveAt: Date.now() - 1000 }))
    await t.mutation(internal.orders.runAutoApprove, {})
    const approved = await t.run((ctx) => ctx.db.get(orderId))
    expect(approved!.status).toBe("approved")
    expect(approved!.autoApproveAt).toBeUndefined() // consumed, not left behind to refire

    // Running the sweep again is a no-op for this order — nothing left scheduled.
    await t.mutation(internal.orders.runAutoApprove, {})
    expect((await t.run((ctx) => ctx.db.get(orderId)))!.status).toBe("approved")
  })

  it("moving a held order to Approved by hand clears any scheduled auto-approve", async () => {
    const { t, as, locationId, v41 } = await setup()
    const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Customer asked to ship on a date", autoApproveAt: Date.now() + 86400000 })
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    expect((await t.run((ctx) => ctx.db.get(orderId)))!.autoApproveAt).toBeUndefined()
  })
})

describe("pick list", () => {
  it("sums picking qty per SKU across the selected orders and flags shortage against available stock", async () => {
    const { as, locationId, v41, v42 } = await setup() // v41 has 10 available, v42 has 0
    const o1 = await as.mutation(api.orders.create, baseOrder(locationId, v41._id, 3))
    const o2 = await as.mutation(api.orders.create, baseOrder(locationId, v41._id, 4))
    const o3 = await as.mutation(api.orders.create, baseOrder(locationId, v42._id, 2))

    const rows = (await as.query(api.orders.pickList, { ids: [o1.orderId, o2.orderId, o3.orderId] }))!
    const hss41 = rows.find((r) => r.sku === "BB-HSS-41")!
    expect(hss41.qty).toBe(7) // 3 + 4, summed into one pick line
    expect(hss41.availableQty).toBe(10)
    expect(hss41.shortageQty).toBe(0)

    const hss42 = rows.find((r) => r.sku === "BB-HSS-42")!
    expect(hss42.qty).toBe(2)
    expect(hss42.availableQty).toBe(0)
    expect(hss42.shortageQty).toBe(2) // nothing in stock — the exact "why hasn't this shipped" case
  })
})
