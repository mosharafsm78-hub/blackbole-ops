import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * Stock check: the team counts the pairs really in hand; the fake (test) part is whatever the system shows beyond
 * that. `available` is never changed, so orders and the website behave as before; the target plan reads real pairs.
 */
const NOW = Date.parse("2026-11-10T06:00:00Z")
const DAY = 86400000
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW) })
afterEach(() => vi.useRealTimers())

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const adminUser = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const asAdmin = t.withIdentity({ subject: `${adminUser}|s1` })
  await asAdmin.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await asAdmin.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id as Id<"locations">
  const cx = (await asAdmin.query(api.team.listRoles, {})).find((r) => r.name === "Team CX")!
  const cxUser = await t.run((ctx) => ctx.db.insert("users", { email: "nuha@blackbole.com" }))
  await asAdmin.mutation(api.team.saveStaff, { email: "nuha@blackbole.com", name: "Nuha", roleId: cx._id, active: true })
  const asCx = t.withIdentity({ subject: `${cxUser}|s2` })
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { code: 1, name: "C", phone: "01711000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: NOW }))
  const addProduct = async (name: string, sizes: Record<string, number>, base: string) => {
    const productId = await t.run((ctx) => ctx.db.insert("products", { name, active: true, createdAt: NOW }))
    const variantIds: Id<"variants">[] = []
    for (const [size, qty] of Object.entries(sizes)) {
      const variantId = await t.run((ctx) => ctx.db.insert("variants", { productId, sku: `${base}-${size}`, title: size, weightKg: 0.4, price: 1000, purchasePrice: 500, active: true }))
      await t.run((ctx) => ctx.db.insert("stock", { variantId, locationId, available: qty, processing: 0, inTransit: 0, returning: 0, damaged: 0 }))
      variantIds.push(variantId)
    }
    return { productId, variantIds }
  }
  let inv = 7000
  const sell = (sku: string, qty: number, at: number) =>
    t.run((ctx) => ctx.db.insert("orders", {
      invoiceNo: ++inv, status: "delivered_paid", source: "Website", customerId, customerName: "C", phone: "01711000000", address: "House 1", locationId, deliveryType: "regular",
      items: [{ sku, name: sku, price: 1000, qty, discount: 0, weightKg: 0.4 }], subtotal: 1000 * qty, discount: 0, deliveryFee: 0, paidAmount: 0, total: 1000 * qty, due: 0, callCount: 0,
      createdByName: "Emon", createdAt: at - DAY, updatedAt: at, statusChangedAt: at, deliveredAt: at,
    }))
  const stockRow = (variantId: Id<"variants">) => t.run((ctx) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", variantId)).first())
  return { t, asAdmin, asCx, locationId, addProduct, sell, stockRow }
}

describe("counting real pairs", () => {
  it("turns the difference between system stock and the real count into fake (test) stock, without touching available", async () => {
    const { asAdmin, addProduct, stockRow, locationId } = await setup()
    const { variantIds } = await addProduct("Veyron", { "41": 10, "42": 20 }, "BB-VEY")
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: variantIds[0], locationId, real: 4 }, { variantId: variantIds[1], locationId, real: 20 }] })
    expect(await stockRow(variantIds[0])).toMatchObject({ available: 10, virtual: 6, countedBy: "Emon" })
    expect(await stockRow(variantIds[1])).toMatchObject({ available: 20, virtual: 0 })

    const page = await asAdmin.query(api.stockCheck.list, { filter: "all", cursor: null })
    expect(page!.products[0]).toMatchObject({ name: "Veyron", system: 30, fake: 6, real: 24, uncounted: false })
    expect(page!.products[0].lines.find((l) => l.title === "41")).toMatchObject({ available: 10, fake: 6, real: 4, counted: true })
  })

  it("refuses a count above the system stock, a fraction, or a negative", async () => {
    const { asAdmin, addProduct, locationId } = await setup()
    const { variantIds } = await addProduct("Veyron", { "41": 10 }, "BB-VEY")
    const one = (real: number) => asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: variantIds[0], locationId, real }] })
    await expect(one(11)).rejects.toThrow(/stock-in or an adjustment/)
    await expect(one(2.5)).rejects.toThrow(/whole number/)
    await expect(one(-1)).rejects.toThrow(/whole number/)
  })

  it("marks a whole product as test stock (nothing in hand) or all real, in one tap", async () => {
    const { asAdmin, addProduct, stockRow } = await setup()
    const { productId, variantIds } = await addProduct("Test Loafer", { "41": 10, "42": 5 }, "BB-TEST")
    await asAdmin.mutation(api.stockCheck.markProduct, { productId, mode: "test" })
    expect(await stockRow(variantIds[0])).toMatchObject({ available: 10, virtual: 10 })
    expect(await stockRow(variantIds[1])).toMatchObject({ available: 5, virtual: 5 })
    await asAdmin.mutation(api.stockCheck.markProduct, { productId, mode: "real" })
    expect(await stockRow(variantIds[0])).toMatchObject({ available: 10, virtual: 0 })
  })

  it("keeps a log of every change, and counts progress", async () => {
    const { t, asAdmin, addProduct, locationId } = await setup()
    const { variantIds } = await addProduct("Veyron", { "41": 10, "42": 20 }, "BB-VEY")
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: variantIds[0], locationId, real: 4 }] })
    const logs = await t.run((ctx) => ctx.db.query("stockLogs").collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ bucket: "virtual", change: 6, reason: "Stock check", byName: "Emon" })
    expect(await asAdmin.query(api.stockCheck.summary, {})).toEqual({ lines: 2, counted: 1, systemPairs: 30, realPairs: 24, fakePairs: 6 })
  })

  it("a stock-in turns fake pairs real by itself; a sale of a fake-only product never makes real stock negative", async () => {
    const { t, asAdmin, addProduct, locationId } = await setup()
    const { variantIds } = await addProduct("Test Loafer", { "41": 10 }, "BB-TEST")
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: variantIds[0], locationId, real: 0 }] }) // 10 fake, 0 real
    const bump = (d: number) => t.run(async (ctx) => { const s = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", variantIds[0])).first(); await ctx.db.patch(s!._id, { available: s!.available + d }) })
    await bump(-3) // 3 ordered on fake stock
    let p = (await asAdmin.query(api.stockCheck.list, { filter: "all", cursor: null }))!.products[0]
    expect(p).toMatchObject({ system: 7, fake: 7, real: 0 })
    await bump(+5) // the supplier delivers 5 (stock-in raises available)
    p = (await asAdmin.query(api.stockCheck.list, { filter: "all", cursor: null }))!.products[0]
    expect(p.real).toBe(2) // 5 arrived, 3 of them already owed to customers
  })

  it("filters to products not yet counted, or test stock only, and only people who may adjust stock can count", async () => {
    const { asAdmin, asCx, addProduct, locationId } = await setup()
    const a = await addProduct("Counted", { "41": 10 }, "BB-A")
    await addProduct("Not counted", { "41": 10 }, "BB-B")
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: a.variantIds[0], locationId, real: 3 }] })
    expect((await asAdmin.query(api.stockCheck.list, { filter: "uncounted", cursor: null }))!.products.map((p) => p.name)).toEqual(["Not counted"])
    expect((await asAdmin.query(api.stockCheck.list, { filter: "test", cursor: null }))!.products.map((p) => p.name)).toEqual(["Counted"])
    await expect(asCx.mutation(api.stockCheck.saveCounts, { items: [{ variantId: a.variantIds[0], locationId, real: 1 }] })).rejects.toThrow()
  })
})

describe("the target plan reads real stock only", () => {
  it("plans from real pairs, lists test-only products, and says how much stock is counted", async () => {
    const { asAdmin, addProduct, sell, locationId } = await setup()
    const hero = await addProduct("Hero Sandal", { "41": 100 }, "BB-HERO")
    const test = await addProduct("Test Loafer", { "41": 50 }, "BB-TEST")
    await sell("BB-HERO-41", 60, NOW - 20 * DAY)
    await sell("BB-TEST-41", 20, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 200000 })
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: hero.variantIds[0], locationId, real: 30 }] })
    await asAdmin.mutation(api.stockCheck.markProduct, { productId: test.productId, mode: "test" })

    const p = await asAdmin.action(api.targets.progress, {})
    const rows = Object.fromEntries(p.products!.map((r) => [r.key, r]))
    expect(rows["BB-HERO"].stockUnits).toBe(30) // not 100
    expect(rows["BB-HERO"].monthUnits).toBeLessThanOrEqual(30)
    expect(rows["BB-TEST"]).toBeUndefined() // nothing in hand → no pairs planned
    expect(p.tests).toEqual([{ key: "BB-TEST", name: "Test Loafer", fake: 50 }])
    expect(p.stockCheck).toEqual({ lines: 2, counted: 2 })
    expect(p.productInfo!.gap).toBeGreaterThan(0) // 30 real pairs can't carry ৳2 lakh
  })
})
