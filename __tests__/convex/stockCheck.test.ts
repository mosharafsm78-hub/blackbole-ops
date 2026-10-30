import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { buySuggestion } from "../../convex/targetPlan"

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
    expect(p.tests).toEqual([
      { key: "BB-HERO", name: "Hero Sandal", fake: 70, real: 30, ordered7: 0, proven: false, buy: 0 },
      { key: "BB-TEST", name: "Test Loafer", fake: 50, real: 0, ordered7: 0, proven: false, buy: 0 },
    ])
    expect(p.stockCheck).toEqual({ lines: 2, counted: 2 })
    expect(p.productInfo!.gap).toBeGreaterThan(0) // 30 real pairs can't carry ৳2 lakh
  })
})

describe("adding test stock, and when it earns a purchase", () => {
  it("adds pairs to the system stock and marks them fake in one step, creating the stock line for a new size", async () => {
    const { t, asAdmin, locationId, stockRow } = await setup()
    const productId = await t.run((ctx) => ctx.db.insert("products", { name: "New Loafer", active: true, createdAt: NOW }))
    const variantId = await t.run((ctx) => ctx.db.insert("variants", { productId, sku: "BB-NEW-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true }))

    // a size with no stock yet still shows a line at the home warehouse
    const before = (await asAdmin.query(api.stockCheck.list, { filter: "all", cursor: null }))!.products[0]
    expect(before.lines).toEqual([expect.objectContaining({ variantId, locationId, available: 0, real: 0 })])

    await asAdmin.mutation(api.stockCheck.addTestStock, { items: [{ variantId, locationId, qty: 20 }] })
    expect(await stockRow(variantId)).toMatchObject({ available: 20, virtual: 20, countedBy: "Emon" })
    await asAdmin.mutation(api.stockCheck.addTestStock, { items: [{ variantId, locationId, qty: 5 }] })
    expect(await stockRow(variantId)).toMatchObject({ available: 25, virtual: 25 })
    const logs = await t.run((ctx) => ctx.db.query("stockLogs").collect())
    expect(logs.map((l) => [l.reason, l.change])).toEqual([["Test stock added", 20], ["Test stock added", 5]])
    const after = (await asAdmin.query(api.stockCheck.list, { filter: "test", cursor: null }))!.products[0]
    expect(after).toMatchObject({ system: 25, fake: 25, real: 0 })
  })

  it("receiving real pairs replaces the test pairs first, so the website never shows real + fake together", async () => {
    const { t, asAdmin, locationId, stockRow } = await setup()
    const productId = await t.run((ctx) => ctx.db.insert("products", { name: "Runner", active: true, createdAt: NOW }))
    const variantId = await t.run((ctx) => ctx.db.insert("variants", { productId, sku: "BB-RUN-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true }))
    await asAdmin.mutation(api.stockCheck.addTestStock, { items: [{ variantId, locationId, qty: 5 }] })
    // 3 sold from the test pairs (stock goes down, the placeholder count stays)
    await t.run(async (ctx) => { const r = (await ctx.db.query("stock").collect())[0]; await ctx.db.patch(r._id, { available: 2 }) })
    await asAdmin.mutation(api.catalog.receiveStock, { locationId, updateCost: false, items: [{ variantId, qty: 20, unitCost: 700 }] })
    // 20 real arrive: 5 replace the placeholders (3 of which were already sold), so 17 are free to sell and none is fake
    expect(await stockRow(variantId)).toMatchObject({ available: 17, virtual: 0 })
    const line = (await asAdmin.query(api.stockCheck.list, { filter: "all", cursor: null }))!.products.find((p) => p.name === "Runner")!
    expect(line).toMatchObject({ system: 17, fake: 0, real: 17 })
  })

  it("a search finds a brand-new product with no stock, even on the 'not counted' tab", async () => {
    const { t, asAdmin } = await setup()
    const productId = await t.run((ctx) => ctx.db.insert("products", { name: "Test product", active: true, createdAt: NOW }))
    await t.run((ctx) => ctx.db.insert("variants", { productId, sku: "BB-TESTP-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true }))
    expect((await asAdmin.query(api.stockCheck.list, { filter: "uncounted", cursor: null }))!.products).toHaveLength(0) // browsing: empty products stay out of the way
    const found = await asAdmin.query(api.stockCheck.list, { filter: "uncounted", search: "test", cursor: null })
    expect(found!.products.map((p) => p.name)).toEqual(["Test product"])
    expect(found!.products[0].lines[0]).toMatchObject({ title: "41", available: 0 })
  })

  it("rejects bad quantities and people who may not adjust stock", async () => {
    const { t, asAdmin, asCx, locationId } = await setup()
    const productId = await t.run((ctx) => ctx.db.insert("products", { name: "P", active: true, createdAt: NOW }))
    const variantId = await t.run((ctx) => ctx.db.insert("variants", { productId, sku: "BB-P-41", title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: true }))
    for (const qty of [0, -3, 2.5]) await expect(asAdmin.mutation(api.stockCheck.addTestStock, { items: [{ variantId, locationId, qty }] })).rejects.toThrow(/whole number above zero/)
    await expect(asCx.mutation(api.stockCheck.addTestStock, { items: [{ variantId, locationId, qty: 5 }] })).rejects.toThrow()
  })

  it("says buy once a week's orders prove demand, sized for three weeks minus what is in hand", async () => {
    const { t, asAdmin, addProduct, sell, locationId } = await setup()
    const { productId, variantIds } = await addProduct("Test Loafer", { "41": 40 }, "BB-TEST")
    await addProduct("Quiet Test", { "41": 40 }, "BB-QUIET")
    await asAdmin.mutation(api.stockCheck.markProduct, { productId, mode: "test" })
    const quiet = (await t.run((ctx) => ctx.db.query("products").collect())).find((p) => p.name === "Quiet Test")!
    await asAdmin.mutation(api.stockCheck.markProduct, { productId: quiet._id, mode: "test" })
    await sell("BB-TEST-41", 8, NOW - 2 * DAY) // 8 pairs ordered this week → demand proven
    await sell("BB-QUIET-41", 2, NOW - 3 * DAY) // only 2 → keep testing
    await sell("BB-TEST-41", 6, NOW - 10 * DAY) // older than a week: not counted in ordered7
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const test = p.tests.find((x) => x.key === "BB-TEST")!
    expect(test).toMatchObject({ ordered7: 8, proven: true, buy: 24, real: 0 }) // 8 × 3 weeks
    expect(p.tests.find((x) => x.key === "BB-QUIET")).toMatchObject({ ordered7: 2, proven: false, buy: 0 })
    expect(p.tests[0].key).toBe("BB-TEST") // proven ones first
    void variantIds; void locationId
  })
})

describe("buy suggestion maths", () => {
  it("needs 5 pairs ordered in a week; buys three weeks at that pace, less what is in hand", () => {
    expect(buySuggestion({ ordered7: 4, real: 0 })).toEqual({ proven: false, buy: 0 })
    expect(buySuggestion({ ordered7: 10, real: 0 })).toEqual({ proven: true, buy: 30 })
    expect(buySuggestion({ ordered7: 10, real: 12 })).toEqual({ proven: true, buy: 18 })
    expect(buySuggestion({ ordered7: 10, real: 50 })).toEqual({ proven: true, buy: 0 })
  })
})

describe("the plan follows the counts as they are entered", () => {
  it("re-plans when a count moves a few pairs between products, even if total stock barely changes", async () => {
    const { t, asAdmin, addProduct, sell, locationId } = await setup()
    const a = await addProduct("Model A", { "41": 500 }, "BB-A") // big pile elsewhere keeps the total large
    await addProduct("Model B", { "41": 40 }, "BB-B")
    await sell("BB-A-41", 30, NOW - 20 * DAY)
    await sell("BB-B-41", 30, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })
    const first = await asAdmin.action(api.targets.progress, {})
    const planA = first.products!.find((r) => r.key === "BB-A")!.monthUnits

    // The team finds only 440 of A's 500 are real: total stock moves 60 of 540 → 11%, but even a 1-pair change must count.
    await asAdmin.mutation(api.stockCheck.saveCounts, { items: [{ variantId: a.variantIds[0], locationId, real: 495 }] })
    vi.setSystemTime(NOW + 11 * 60000) // past the 10-minute data cache
    const second = await asAdmin.action(api.targets.progress, {})
    expect(second.products!.find((r) => r.key === "BB-A")!.stockUnits).toBe(495)
    const saved = await t.run((ctx) => ctx.db.query("revenueTargets").first())
    expect(saved!.plan.check).toBe("1:5") // one line counted, 5 test pairs
    void planA
  })
})
