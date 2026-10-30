import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { COMMITTED_STATUSES, RETURNING_STATUSES, STATUS_BUCKET } from "../../convex/rules"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** One product (sizes 41 and 42), stock in the default warehouse, and a second CTG warehouse. */
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "lead@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Lead" })).toBe("ok")
  const locations = await as.query(api.team.listLocations, {})
  const dhakaId = locations.find((l) => l.isDefault)!._id

  await as.mutation(api.team.saveLocation, { name: "BlackBole CTG", isDefault: false, active: true })
  const ctgId = (await as.query(api.team.listLocations, {})).find((l) => l.name === "BlackBole CTG")!._id

  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black",
    active: true,
    variants: [
      { sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-HSS-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ],
  })
  const variants = await t.run((ctx) => ctx.db.query("variants").collect())
  const v41 = variants.find((v) => v.sku === "BB-HSS-41")!
  const v42 = variants.find((v) => v.sku === "BB-HSS-42")!
  await as.mutation(api.catalog.receiveStock, {
    locationId: dhakaId,
    updateCost: true,
    items: [
      { variantId: v41._id, qty: 20, unitCost: 500 },
      { variantId: v42._id, qty: 5, unitCost: 500 },
    ],
  })
  const product = (await t.run((ctx) => ctx.db.query("products").collect()))[0]
  return { t, as, product, v41, v42, dhakaId, ctgId }
}

const detail = async (as: Awaited<ReturnType<typeof setup>>["as"], id: string) =>
  (await as.query(api.catalog.productDetail, { id }))!

const size = (d: Awaited<ReturnType<typeof detail>>, title: string) => d.variants.find((v) => v.title === title)!

/** Create an order for one variant and walk it to `to` through the real status machine, one legal hop at a
 *  time — the same path a CX agent takes, so the stock buckets move exactly as they do in production. */
async function orderTo(
  as: Awaited<ReturnType<typeof setup>>["as"],
  locationId: any,
  variantId: any,
  qty: number,
  to: string,
  phone = "01711000001",
) {
  const { orderId } = await as.mutation(api.orders.create, {
    source: "Facebook",
    customerName: "Test",
    phone,
    address: "House 1, Road 2, Lalmatia",
    locationId,
    deliveryType: "pickup",
    items: [{ variantId, qty, price: 1480, discount: 0 }],
    discount: 0,
    deliveryFee: 0,
    advanceAmount: 0,
    advanceMethod: "bKash",
    approve: false,
  })
  for (const hop of pathTo(to)) {
    const res = await as.mutation(api.orders.changeStatus, { ids: [orderId], to: hop as any })
    expect(res.errors).toEqual([])
  }
  return orderId
}

/** A legal route from `pending` to each status we test, following TRANSITIONS. */
function pathTo(to: string): string[] {
  const via: Record<string, string[]> = {
    pending: [],
    on_hold: ["on_hold"],
    approved: ["approved"],
    processing: ["approved", "processing"],
    ready_to_ship: ["approved", "ready_to_ship"],
    in_transit: ["approved", "in_transit"],
    delivered_paid: ["approved", "in_transit", "delivered_paid"],
    cancelled: ["cancelled"],
    pending_returned: ["approved", "in_transit", "pending_returned"],
    returned: ["approved", "in_transit", "returned"],
    damaged: ["approved", "in_transit", "pending_returned", "damaged"],
  }
  const p = via[to]
  if (!p) throw new Error(`no test path to ${to}`)
  return p
}

describe("status mapping — the Director's four metrics", () => {
  it("maps every committed status to a bucket that is NOT sold, and never to returning", () => {
    for (const s of COMMITTED_STATUSES) {
      expect(STATUS_BUCKET[s]).not.toBe("sold")
      expect(STATUS_BUCKET[s]).not.toBe("returning")
    }
  })

  it("counts only pending_returned as Returning, and never returned", () => {
    expect(RETURNING_STATUSES).toEqual(["pending_returned"])
    expect(RETURNING_STATUSES).not.toContain("returned")
    // A returned item has already rolled back into sellable stock — that is why it is excluded.
    expect(STATUS_BUCKET.returned).toBe("available")
    expect(STATUS_BUCKET.pending_returned).toBe("returning")
  })

  it("covers exactly the six statuses the Director listed, plus both pre-order origins", () => {
    expect([...COMMITTED_STATUSES].sort()).toEqual(
      ["approved", "on_hold", "pending", "pre_order", "pre_order_bd", "processing", "ready_to_ship"].sort(),
    )
  })
})

describe("product detail — Returning vs Returned", () => {
  it("counts a pending_returned order as Returning", async () => {
    const { as, product, v41, dhakaId } = await setup()
    await orderTo(as, dhakaId, v41._id, 3, "pending_returned")
    const d = await detail(as, product._id)
    expect(size(d, "41").metrics.returning).toBe(3)
  })

  it("does NOT count a returned order as Returning — it goes back to Available", async () => {
    const { as, product, v41, dhakaId } = await setup()
    const before = size(await detail(as, product._id), "41").metrics
    await orderTo(as, dhakaId, v41._id, 3, "returned")
    const after = size(await detail(as, product._id), "41").metrics
    // The pair of shoes is back on the shelf, not still on a courier van. The units left `available` when the
    // order was approved and came back when it was marked returned, so available is conserved.
    expect(after.returning).toBe(0)
    expect(after.available).toBe(before.available)
  })

  it("moves the same units from Returning to Available when the return lands", async () => {
    const { as, product, v41, dhakaId } = await setup()
    const orderId = await orderTo(as, dhakaId, v41._id, 2, "pending_returned")
    const mid = size(await detail(as, product._id), "41").metrics
    expect(mid.returning).toBe(2)
    // The two pairs are on the courier's van, so they are NOT on the shelf.
    expect(mid.available).toBe(18)

    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "returned" })
    const end = size(await detail(as, product._id), "41").metrics
    // Never both at once — that would double-count the same two pairs.
    expect(end.returning).toBe(0)
    expect(end.available).toBe(20)
  })

  it("keeps damaged units out of Returning", async () => {
    const { as, product, v41, dhakaId } = await setup()
    await orderTo(as, dhakaId, v41._id, 1, "damaged")
    const m = size(await detail(as, product._id), "41").metrics
    expect(m.returning).toBe(0)
  })
})

describe("product detail — Committed aggregate", () => {
  it("sums every committed status, including Pending and On Hold which sit in the available bucket", async () => {
    const { as, product, v41, dhakaId } = await setup()
    await orderTo(as, dhakaId, v41._id, 1, "pending", "01711000001")
    await orderTo(as, dhakaId, v41._id, 2, "on_hold", "01711000002")
    await orderTo(as, dhakaId, v41._id, 3, "approved", "01711000003")
    await orderTo(as, dhakaId, v41._id, 4, "processing", "01711000004")
    await orderTo(as, dhakaId, v41._id, 5, "ready_to_ship", "01711000005")
    const m = size(await detail(as, product._id), "41").metrics
    expect(m.committed).toBe(1 + 2 + 3 + 4 + 5)
  })

  it("excludes delivered, cancelled and returned orders", async () => {
    const { as, product, v41, dhakaId } = await setup()
    await orderTo(as, dhakaId, v41._id, 2, "pending", "01711000001")
    await orderTo(as, dhakaId, v41._id, 7, "delivered_paid", "01711000002")
    await orderTo(as, dhakaId, v41._id, 9, "cancelled", "01711000003")
    await orderTo(as, dhakaId, v41._id, 4, "returned", "01711000004")
    const m = size(await detail(as, product._id), "41").metrics
    expect(m.committed).toBe(2)
  })

  it("counts a legacy line item that carries only a SKU, with no variantId", async () => {
    const { t, as, product, v41, dhakaId } = await setup()
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        code: 9001, name: "Legacy", phone: "01711999999", tag: "NEW",
        orderCount: 1, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0,
        createdAt: Date.now(),
      }),
    )
    const now = Date.now()
    await t.run((ctx) =>
      ctx.db.insert("orders", {
        invoiceNo: 9001, status: "pending", source: "Facebook", customerId,
        customerName: "Legacy", phone: "01711999999", address: "Old address", locationId: dhakaId,
        deliveryType: "pickup",
        // The shape older records actually have: a SKU, no variantId.
        items: [{ sku: "BB-HSS-41", name: "Harbor Shore Sandal - Black", price: 1480, qty: 6, discount: 0, weightKg: 0.4 }],
        subtotal: 8880, discount: 0, deliveryFee: 0, paidAmount: 0, total: 8880, due: 8880,
        callCount: 0, createdByName: "Legacy", createdAt: now, updatedAt: now, statusChangedAt: now,
      }),
    )
    const m = size(await detail(as, product._id), "41").metrics
    expect(m.committed).toBe(6)
    expect(v41.sku).toBe("BB-HSS-41")
  })
})

describe("product detail — warehouse rows reconcile with the cards", () => {
  it("sums every warehouse row to the headline metric, for all four metrics", async () => {
    const { as, product, v41, dhakaId } = await setup()
    await orderTo(as, dhakaId, v41._id, 3, "pending", "01711000001")
    await orderTo(as, dhakaId, v41._id, 2, "in_transit", "01711000002")
    await orderTo(as, dhakaId, v41._id, 1, "pending_returned", "01711000003")

    const d = await detail(as, product._id)
    for (const v of d.variants) {
      const sum = v.warehouses.reduce(
        (s, w) => ({
          available: s.available + w.available,
          committed: s.committed + w.committed,
          inTransit: s.inTransit + w.inTransit,
          returning: s.returning + w.returning,
        }),
        { available: 0, committed: 0, inTransit: 0, returning: 0 },
      )
      expect(sum).toEqual(v.metrics)
    }
  })

  it("attributes committed units to the warehouse the order was placed from", async () => {
    const { as, product, v41, ctgId } = await setup()
    await orderTo(as, ctgId, v41._id, 4, "pending")
    const v = size(await detail(as, product._id), "41")
    const ctg = v.warehouses.find((w) => w.locationName === "BlackBole CTG")!
    expect(ctg.committed).toBe(4)
    expect(v.metrics.committed).toBe(4)
  })

  it("adds a warehouse row for committed units even when that warehouse holds no stock row", async () => {
    const { as, product, v41, ctgId } = await setup()
    // CTG has never received stock, so it has no `stock` row for this variant at all.
    await orderTo(as, ctgId, v41._id, 2, "pending")
    const v = size(await detail(as, product._id), "41")
    const ctg = v.warehouses.find((w) => w.locationName === "BlackBole CTG")!
    expect(ctg).toBeTruthy()
    expect(ctg.available).toBe(0)
    expect(ctg.committed).toBe(2)
  })

  it("reports all four metrics as zero for a size with no stock and no orders", async () => {
    const { as, product } = await setup()
    const v42 = size(await detail(as, product._id), "42")
    expect(v42.metrics).toEqual({ available: 5, committed: 0, inTransit: 0, returning: 0 })
    // Every active warehouse is still listed, at zero, so the table never reads as "unknown".
    expect(v42.warehouses.length).toBeGreaterThanOrEqual(2)
    expect(v42.warehouses.every((w) => w.committed === 0 && w.returning === 0)).toBe(true)
  })
})
