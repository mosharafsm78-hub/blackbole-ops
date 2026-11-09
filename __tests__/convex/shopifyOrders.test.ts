import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"
import { planSync } from "../../convex/shopifyOrders"

const shop = (o: any = {}) => ({ cancelled: false, financial: "PENDING", openFulfilmentOrders: 1, fulfilments: [], ...o })

describe("planSync", () => {
  it("fulfils at processing, nothing else", () => {
    expect(planSync("processing", shop())).toEqual({ fulfil: true, deliver: [], pay: false })
  })
  it("does nothing before processing or after a cancel", () => {
    expect(planSync("approved", shop())).toEqual({ fulfil: false, deliver: [], pay: false })
    expect(planSync("delivered_paid", shop({ cancelled: true }))).toEqual({ fulfil: false, deliver: [], pay: false })
  })
  it("delivered: marks existing fulfilments delivered, skips ones already delivered, no payment yet", () => {
    const r = planSync("delivered_due", shop({ openFulfilmentOrders: 0, fulfilments: [{ id: "a", status: "SUCCESS" }, { id: "b", status: "DELIVERED" }] }))
    expect(r).toEqual({ fulfil: false, deliver: ["a"], pay: false })
  })
  it("paid by Pathao: marks paid only when Shopify is not already paid", () => {
    expect(planSync("delivered_paid", shop({ openFulfilmentOrders: 0 })).pay).toBe(true)
    expect(planSync("delivered_paid", shop({ openFulfilmentOrders: 0, financial: "PAID" })).pay).toBe(false)
  })
})

describe("enqueue / backfill", () => {
  const mk = async (t: any, source: string, status: string, externalId?: string) =>
    t.run(async (ctx: any) => {
      const loc = (await ctx.db.query("locations").first())?._id ?? (await ctx.db.insert("locations", { name: "Dhaka", isDefault: true, active: true }))
      const cust = await ctx.db.insert("customers", { code: 1, name: "A", phone: "01700000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 1 })
      return ctx.db.insert("orders", { invoiceNo: Math.floor(Math.random() * 1e6), status, source, externalId, customerId: cust, customerName: "A", phone: "01700000000", address: "x", locationId: loc, deliveryType: "regular", items: [], subtotal: 0, discount: 0, deliveryFee: 0, paidAmount: 0, total: 0, due: 0, callCount: 0, createdByName: "t", createdAt: Date.now(), updatedAt: Date.now(), statusChangedAt: Date.now() } as any)
    })

  it("queues website orders with a Shopify id only, and re-opens an existing row", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const web = await mk(t, "Website", "processing", "123")
    const manual = await mk(t, "Manual", "processing")
    expect(await t.mutation(internal.shopifyOrders.enqueue, { orderId: manual })).toBeNull()
    expect(await t.mutation(internal.shopifyOrders.enqueue, { orderId: web })).toBe(true)
    await t.mutation(internal.shopifyOrders.mark, { orderId: web })
    expect((await t.query(internal.shopifyOrders.due, {})).length).toBe(0)
    await t.mutation(internal.shopifyOrders.enqueue, { orderId: web })
    expect(await t.query(internal.shopifyOrders.due, {})).toEqual([web])
  })

  it("a failure is kept with its reason and retried later, and the team is told after the last try", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const web = await mk(t, "Website", "delivered_paid", "9")
    await t.mutation(internal.shopifyOrders.enqueue, { orderId: web })
    await t.mutation(internal.shopifyOrders.mark, { orderId: web, error: "Access denied" })
    expect(await t.query(internal.shopifyOrders.due, {})).toEqual([])
    const row = await t.run(async (ctx: any) => ctx.db.query("shopifyOrderSync").first())
    expect(row).toMatchObject({ tries: 1, done: false, lastError: "Access denied" })
    for (let i = 0; i < 7; i++) await t.mutation(internal.shopifyOrders.mark, { orderId: web, error: "Access denied" })
    const after = await t.run(async (ctx: any) => ({ row: await ctx.db.query("shopifyOrderSync").first(), n: (await ctx.db.query("notifications").collect()).length }))
    expect(after.row.done).toBe(true)
    expect(after.n).toBe(1)
  })

  it("backfill queues recent website orders once", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await mk(t, "Website", "in_transit", "1")
    await mk(t, "Website", "approved", "2")
    expect(await t.mutation(internal.shopifyOrders.backfill, {})).toEqual({ queued: 1 })
    expect(await t.mutation(internal.shopifyOrders.backfill, {})).toEqual({ queued: 0 })
  })
})

describe("purgePlaceholders", () => {
  it("removes only empty, inactive WEB- sizes of the named product", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx: any) => {
      const p = await ctx.db.insert("products", { name: "Brinkley Breeze Sandal for Men New", active: true, createdAt: 1 })
      const q = await ctx.db.insert("products", { name: "Other", active: true, createdAt: 1 })
      const mk = (productId: any, sku: string, active: boolean) => ctx.db.insert("variants", { productId, sku, title: sku, weightKg: 0.5, price: 1, purchasePrice: 0, active })
      await mk(p, "WEB-1", false); await mk(p, "WEB-2", true); await mk(p, "BB-REAL-39", false); await mk(q, "WEB-3", false)
    })
    expect(await t.mutation(internal.stockCheck.purgePlaceholders, { productMatch: "Brinkley Breeze Sandal for Men New" })).toEqual({ purged: 1, kept: 0 })
    const left = await t.run(async (ctx: any) => (await ctx.db.query("variants").collect()).map((x: any) => x.sku).sort())
    expect(left).toEqual(["BB-REAL-39", "WEB-2", "WEB-3"])
  })
})

describe("Pathao return undone", () => {
  const seed = async (t: any, byName: string) =>
    t.run(async (ctx: any) => {
      const loc = await ctx.db.insert("locations", { name: "Dhaka", isDefault: true, active: true })
      const cust = await ctx.db.insert("customers", { code: 1, name: "A", phone: "01700000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 1 } as any)
      const id = await ctx.db.insert("orders", { invoiceNo: 1, status: "pending_returned", source: "Manual", customerId: cust, customerName: "A", phone: "01700000000", address: "x", locationId: loc, deliveryType: "regular", items: [], subtotal: 0, discount: 0, deliveryFee: 0, paidAmount: 0, total: 0, due: 0, callCount: 0, createdByName: "t", createdAt: Date.now(), updatedAt: Date.now(), statusChangedAt: Date.now() } as any)
      await ctx.db.insert("orderEvents", { orderId: id, type: "log", text: "Status changed In Transit → Pending Return — Pathao: paid_return", byName, at: Date.now() })
      return id
    })
  it("puts it back to Delivered when Pathao itself moved it to Pending Return", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const id = await seed(t, "Pathao sync")
    expect(await t.mutation(internal.orders.systemStatus, { id, to: "delivered_due", note: "Pathao: delivered" })).toBe(true)
    expect((await t.run(async (ctx: any) => ctx.db.get(id))).status).toBe("delivered_due")
  })
  it("never undoes a return a person marked", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const id = await seed(t, "Rafi")
    expect(await t.mutation(internal.orders.systemStatus, { id, to: "delivered_due", note: "Pathao: delivered" })).toBe(false)
    expect((await t.run(async (ctx: any) => ctx.db.get(id))).status).toBe("pending_returned")
  })
})
