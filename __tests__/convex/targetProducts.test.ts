import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * Product-wise target: pairs per product come from sales history and stock, not typed in; the plan is saved so a
 * missed day carries over; ad spend is only visible to people with ads access; the Marketing lead earns KPI points
 * for pace / hitting the month, once per period.
 */

const NOW = Date.parse("2026-11-10T06:00:00Z") // 12:00 Dhaka, Nov 10
const DAY = 86400000

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

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
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { code: 1, name: "C", phone: "01711000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: NOW }),
  )

  const addProduct = async (name: string, stock: number | null, base: string, extra: { preOrder?: boolean; category?: string } = {}) => {
    const productId = await t.run((ctx) => ctx.db.insert("products", { name, active: true, createdAt: NOW, ...extra }))
    const variantId = await t.run((ctx) =>
      ctx.db.insert("variants", { productId, sku: `${base}-41`, title: "41", weightKg: 0.4, price: 1000, purchasePrice: 500, active: true }),
    )
    if (stock !== null) await t.run((ctx) => ctx.db.insert("stock", { variantId, locationId, available: stock, processing: 0, inTransit: 0, returning: 0, damaged: 0 }))
    return variantId
  }
  let inv = 5000
  const sell = (sku: string, name: string, qty: number, price: number, deliveredAt: number) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        invoiceNo: ++inv, status: "delivered_paid", source: "Website", customerId, customerName: "C", phone: "01711000000",
        address: "House 1", locationId, deliveryType: "regular",
        items: [{ sku, name, price, qty, discount: 0, weightKg: 0.4 }],
        subtotal: price * qty, discount: 0, deliveryFee: 0, paidAmount: 0, total: price * qty, due: 0, callCount: 0,
        createdByName: "Emon", createdAt: deliveredAt - DAY, updatedAt: deliveredAt, statusChangedAt: deliveredAt, deliveredAt,
      }),
    )
  return { t, asAdmin, asCx, addProduct, sell }
}

describe("product plan from sales and stock", () => {
  it("splits the target by what sells, never beyond stock, and moves the rest to products that have stock", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Hero Sandal", 10, "BB-HERO") // sells most but only 10 in stock
    await addProduct("Soft Slide", 500, "BB-SOFT")
    await addProduct("Dead Stock", 800, "BB-DEAD") // never sells → no target
    await sell("BB-HERO-41", "Hero Sandal", 60, 1000, NOW - 20 * DAY)
    await sell("BB-SOFT-41", "Soft Slide", 30, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const rows = Object.fromEntries(p.products!.map((r) => [r.key, r]))
    expect(rows["BB-HERO"].monthUnits).toBe(10)
    expect(rows["BB-HERO"].stockShort).toBe(0)
    expect(rows["BB-SOFT"].monthUnits).toBe(82)
    expect(rows["BB-DEAD"]).toMatchObject({ group: "dead", monthUnits: 8 }) // stock that never sells: a small share (8%)
    expect(rows["BB-HERO"].group).toBe("focus")
    expect(p.productInfo!.gap).toBe(0)
  })

  it("reports a stock gap when current stock cannot carry the target", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Hero Sandal", 10, "BB-HERO")
    await sell("BB-HERO-41", "Hero Sandal", 60, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products![0].monthUnits).toBe(10)
    expect(p.productInfo!.gap).toBe(90000)
  })

  it("saves the plan, so a missed day stays on the same product and tomorrow asks for more", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", null, "BB-SOFT", { preOrder: true, category: "Sandals" })
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 210000 })
    const first = await asAdmin.action(api.targets.progress, {})
    const row = first.products![0]
    expect(row.monthUnits).toBe(210)
    expect(row.todayTarget).toBe(Math.ceil(210 / 21)) // 21 days left incl. today → 10

    // Pre-order is planned per CATEGORY, not per SKU — there's no per-product ad for it, one category ad runs.
    const saved = await t.run((ctx) => ctx.db.query("revenueTargets").first())
    expect(saved!.plan.products["cat:Sandals"].units).toBe(210)

    // today only 2 sold → the plan is unchanged, but the days left carry the shortfall
    await sell("BB-SOFT-41", "Soft Slide", 2, 1000, NOW + 60000)
    vi.setSystemTime(NOW + 11 * 60000) // past the 10-minute data cache
    const second = await asAdmin.action(api.targets.progress, {})
    const r2 = second.products![0]
    expect(r2.monthUnits).toBe(210)
    expect(r2.todaySold).toBe(2)
    expect(r2.left).toBe(208)
    expect(r2.perDayAfterToday).toBe(Math.ceil(208 / 20))
  })

  it("a future-month target entered before starts existed begins today instead of waiting for the 1st", async () => {
    const { t, asAdmin } = await setup()
    await t.run((ctx) => ctx.db.insert("revenueTargets", { month: "2026-12", amount: 310000, setByName: "Emon", updatedAt: NOW }))
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.plan).toMatchObject({ start: "2026-11-10", started: true })
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.start).toBe("2026-11-10")
  })

  it("re-arranges the whole plan every new day from what is still missing and what is in stock now", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 210000 })
    await asAdmin.action(api.targets.progress, {})
    const day1 = (await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.plan.at
    vi.setSystemTime(NOW + 2 * 3600000) // same Dhaka day: the plan is kept
    await asAdmin.action(api.targets.progress, {})
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.plan.at).toBe(day1)
    vi.setSystemTime(NOW + DAY) // next day: re-made
    await asAdmin.action(api.targets.progress, {})
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.plan.at).toBe(NOW + DAY)
  })

  it("re-plans at once when stock is corrected, instead of waiting a week", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    const hero = await addProduct("Hero Sandal", 100, "BB-HERO") // the system says 100 pairs…
    await sell("BB-HERO-41", "Hero Sandal", 60, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 80000 })
    expect((await asAdmin.action(api.targets.progress, {})).products![0].monthUnits).toBe(80)

    // …a stock count finds only 20 are real
    await t.run(async (ctx) => { const s = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", hero)).first(); await ctx.db.patch(s!._id, { available: 20 }) })
    vi.setSystemTime(NOW + 11 * 60000) // past the 10-minute data cache, far inside the 7-day replan window
    const after = await asAdmin.action(api.targets.progress, {})
    expect(after.products![0].monthUnits).toBe(20)
    expect(after.productInfo!.gap).toBeGreaterThan(0) // the target can't be carried by what's really there
  })

  it("makes a fresh plan when the amount changes", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })
    await asAdmin.action(api.targets.progress, {})
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.plan).toBeDefined()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 200000 })
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").first()))!.plan).toBeUndefined()
  })

  it("a target set before its month begins starts today and runs to the end of that month", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-12", amount: 100000 })
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.month).toBe("2026-12")
    expect(p.plan).toMatchObject({ start: "2026-11-10", end: "2026-12-31", daysInMonth: 52, started: true, daysLeft: 52 })
    expect(p.plan!.today!.target).toBe(Math.ceil(100000 / 52))
    expect(p.products![0].todayTarget).toBe(Math.ceil(p.products![0].monthUnits / 52))
  })
})

describe("pre-order is planned by category, not by product", () => {
  // There's no per-SKU ad for a pre-order item — one category ad runs (e.g. "Sneakers — pre-order") and the
  // customer picks whichever model they like, so planning (and pushing in ads) by category matches how the
  // team actually sells these, instead of splitting the target into many paper-thin per-SKU quotas.

  it("folds several pre-order products in the same category into one plan row", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Men's Classic Navy Sneakers", null, "BB-PO1", { preOrder: true, category: "Sneakers" })
    await addProduct("Women's Kappa High-Top Sneakers", null, "BB-PO2", { preOrder: true, category: "Sneakers" })
    await sell("BB-PO1-41", "Men's Classic Navy Sneakers", 10, 1000, NOW - 20 * DAY)
    await sell("BB-PO2-41", "Women's Kappa High-Top Sneakers", 6, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const rows = Object.fromEntries(p.products!.map((r) => [r.key, r]))
    expect(rows["BB-PO1"]).toBeUndefined()
    expect(rows["BB-PO2"]).toBeUndefined()
    expect(rows["cat:Sneakers"]).toBeDefined()
    expect(rows["cat:Sneakers"].name).toBe("Sneakers — pre-order")
    expect(rows["cat:Sneakers"].stockUnits).toBeNull() // still shows as "pre-order", not a stock number
    // One combined row carrying both SKUs' demand (16 pairs sold), not two 8/6-pair rows nobody pushes individually.
    expect(rows["cat:Sneakers"].sold).toBe(0) // nothing sold yet this month — "sold" above was 20 days ago, outside Nov
    expect(p.products!.length).toBe(1)
  })

  it("keeps different pre-order categories separate, and buckets an uncategorized one on its own", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Men's Classic Navy Sneakers", null, "BB-PO1", { preOrder: true, category: "Sneakers" })
    await addProduct("Pierre Cardin Chelsea Boot", null, "BB-PO2", { preOrder: true, category: "Boots" })
    await addProduct("Mystery Pair", null, "BB-PO3", { preOrder: true }) // no category set
    await sell("BB-PO1-41", "Men's Classic Navy Sneakers", 10, 1000, NOW - 20 * DAY)
    await sell("BB-PO2-41", "Pierre Cardin Chelsea Boot", 5, 1000, NOW - 20 * DAY)
    await sell("BB-PO3-41", "Mystery Pair", 2, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const keys = p.products!.map((r) => r.key).sort()
    expect(keys).toEqual(["cat:Boots", "cat:Sneakers", "cat:Uncategorized"])
  })

  it("still plans a normal in-stock product per SKU, unaffected by the pre-order category grouping", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Hero Sandal", 100, "BB-HERO")
    await addProduct("Men's Classic Navy Sneakers", null, "BB-PO1", { preOrder: true, category: "Sneakers" })
    await sell("BB-HERO-41", "Hero Sandal", 30, 1000, NOW - 20 * DAY)
    await sell("BB-PO1-41", "Men's Classic Navy Sneakers", 10, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const rows = Object.fromEntries(p.products!.map((r) => [r.key, r]))
    expect(rows["BB-HERO"]).toBeDefined()
    expect(rows["BB-HERO"].name).toBe("Hero Sandal")
    expect(rows["BB-HERO"].stockUnits).toBe(100)
    expect(rows["cat:Sneakers"]).toBeDefined()
  })
})

describe("restock suggestions on the Target page", () => {
  it("flags a product running low on real sales history, with a per-size buy quantity ready to route into a purchase", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    const heroVariant = await addProduct("Hero Sandal", 4, "BB-HERO") // thin stock left
    await sell("BB-HERO-41", "Hero Sandal", 60, 1000, NOW - 20 * DAY) // heavy recent demand
    await addProduct("Slow Mover", 1000, "BB-SLOW") // plenty of stock, no urgency — should not appear
    await sell("BB-SLOW-41", "Slow Mover", 2, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.restock).not.toBeNull()
    expect(p.restock!.map((r) => r.name)).toEqual(["Hero Sandal"])
    const hero = p.restock![0]
    expect(hero.reasons).toContain("running_low")
    expect(hero.sizes).toHaveLength(1)
    expect(hero.sizes[0].variantId).toBe(heroVariant)
    expect(hero.sizes[0].suggest).toBeGreaterThan(0)
    expect(hero.sizes.reduce((s, x) => s + x.suggest, 0)).toBe(hero.suggestedTotal)
  })

  it("drops a product from the list once someone removes it from the pipeline, and brings it back on restore", async () => {
    // Emon's literal complaint: pick "Pro Asics", press remove, and it must vanish from the visible list — not
    // just get unchecked from whatever purchase draft is being built. This is a durable, server-side removal.
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Pro Asics Gel Nimbus", 4, "BB-ASICS")
    await sell("BB-ASICS-41", "Pro Asics Gel Nimbus", 60, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const before = await asAdmin.action(api.targets.progress, {})
    expect(before.restock!.map((r) => r.name)).toEqual(["Pro Asics Gel Nimbus"])
    expect(before.restockDismissedCount).toBe(0)

    await asAdmin.mutation(api.targets.dismissRestock, { key: before.restock![0].key, name: "Pro Asics Gel Nimbus", dismissed: true })

    const after = await asAdmin.action(api.targets.progress, {})
    expect(after.restock).toEqual([]) // actually gone, not merely deselected
    expect(after.restockDismissedCount).toBe(1)
    expect(await asAdmin.query(api.targets.listDismissedRestock, {})).toEqual([{ key: before.restock![0].key, name: "Pro Asics Gel Nimbus", at: NOW }])

    await asAdmin.mutation(api.targets.dismissRestock, { key: before.restock![0].key, name: "", dismissed: false })

    const restored = await asAdmin.action(api.targets.progress, {})
    expect(restored.restock!.map((r) => r.name)).toEqual(["Pro Asics Gel Nimbus"])
    expect(restored.restockDismissedCount).toBe(0)
  })
})

describe("catalog duplicates are merged into one plan row", () => {
  // The team found the same product listed several times in the catalog — a relaunch under new SKUs that never
  // deactivated the old shell. Left alone, each duplicate gets its own paper-thin plan row and its own ad-push
  // line on the Target page: the same listing competing against itself for marketing budget.

  it("folds two in-stock products with the exact same name into one row, summing their stock and sales", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 2, "BB-SH-BHSS-BLACK") // the old, nearly-dead shell
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 70, "BB-SH-BHSS-BLACK-NEW") // the real, relaunched listing
    await sell("BB-SH-BHSS-BLACK-NEW-41", "BlackBole Harbor Shore Sandal For Men - Black", 10, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.filter((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")).toHaveLength(1)
    const row = p.products!.find((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")!
    expect(row.stockUnits).toBe(72) // 2 + 70, not two separate rows each getting their own ad budget
  })

  it("merges a duplicate even when the two catalog entries have different categories", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Duplicate Loafer", 1, "BB-DUP-OLD", { category: "Shoe" })
    await addProduct("Duplicate Loafer", 50, "BB-DUP-NEW", { category: "Sandals" })
    await sell("BB-DUP-NEW-41", "Duplicate Loafer", 8, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.filter((r) => r.name === "Duplicate Loafer")).toHaveLength(1)
  })

  it("folds old sales onto the current row even when the duplicate's own variant was deactivated, not just destocked", async () => {
    // This is the sharper version of the relaunch bug: the old shell wasn't just left at low stock, its variant
    // was switched off entirely once the new SKU took over. Its past orders still carry the product's name, but
    // the SKU they reference no longer appears anywhere in the active-stock pass above, so only a second,
    // name-based pass (over every variant, active or not) can route them onto today's row.
    const { t, asAdmin, addProduct, sell } = await setup()
    const oldVariantId = await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 0, "BB-SH-BHSS-BLACK")
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 70, "BB-SH-BHSS-BLACK-NEW")
    await sell("BB-SH-BHSS-BLACK-41", "BlackBole Harbor Shore Sandal For Men - Black", 6, 1000, NOW - 25 * DAY) // old SKU's past orders
    await sell("BB-SH-BHSS-BLACK-NEW-41", "BlackBole Harbor Shore Sandal For Men - Black", 10, 1000, NOW - 20 * DAY)
    await t.run((ctx) => ctx.db.patch(oldVariantId, { active: false })) // relaunch switched the old SKU off
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.filter((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")).toHaveLength(1)
    const row = p.products!.find((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")!
    expect(row.stockUnits).toBe(70) // only the live SKU's stock — the dead one contributes sales history, not stock
  })

  it("folds sales under a product name that has NO matching catalog SKU left at all into the current row", async () => {
    // The deepest version of the bug: the old duplicate's variant isn't just deactivated, it no longer exists
    // anywhere in the catalog — only its past orders remain, carrying the product's name. Neither of the
    // catalog-aware passes in gatherStock() can find a SKU that was deleted outright, so this has to be caught
    // as a last resort, purely by the name every surviving row already carries.
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 70, "BB-SH-BHSS-BLACK-NEW")
    await sell("GHOST-SKU-NO-LONGER-IN-CATALOG-41", "BlackBole Harbor Shore Sandal For Men - Black", 6, 1000, NOW - 25 * DAY)
    await sell("BB-SH-BHSS-BLACK-NEW-41", "BlackBole Harbor Shore Sandal For Men - Black", 10, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.filter((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")).toHaveLength(1)
    const row = p.products!.find((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")!
    expect(row.stockUnits).toBe(70) // the real SKU's stock; the ghost SKU only ever contributed sales history
  })

  it("never merges two genuinely different products that just happen to both have stock", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Hero Sandal", 10, "BB-HERO")
    await addProduct("Soft Slide", 500, "BB-SOFT")
    await sell("BB-HERO-41", "Hero Sandal", 60, 1000, NOW - 20 * DAY)
    await sell("BB-SOFT-41", "Soft Slide", 30, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.map((r) => r.name).sort()).toEqual(["Hero Sandal", "Soft Slide"])
  })
})

describe("inactive products never get pushed with ad budget just because they used to sell", () => {
  // Emon's report: a product marked inactive (discontinued, not sellable on the website) with no catalog SKUs
  // left and no stock-check entry was still showing up on the Target page's sell list with ad budget, because
  // old sales history alone was enough to plan it as an uncapped "pre-order" item. gatherStock() already leaves
  // inactive/deleted products out of the stock map on purpose — the fix is to stop treating "no stock-map row"
  // as "unlimited pre-order" for anything that isn't a real, currently-active pre-order product.

  it("drops a product that's marked inactive from the plan, even with recent sales history and no stock left", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Morning Running Shoe - Unisex", 0, "BB-MRS")
    await sell("BB-MRS-41", "Morning Running Shoe - Unisex", 5, 1527, NOW - 20 * DAY)
    await t.run(async (ctx) => {
      const prod = (await ctx.db.query("products").collect()).find((p) => p.name === "Morning Running Shoe - Unisex")!
      await ctx.db.patch(prod._id, { active: false })
    })
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.products!.find((r) => r.name === "Morning Running Shoe - Unisex")).toBeUndefined()
  })

  it("still folds an inactive duplicate's old sales onto its active, currently-sellable twin of the same name", async () => {
    // Regression guard: dropping orphans with no active listing must not break the existing catalog-duplicate
    // fix, which relies on exactly this kind of entry being merged into its live twin rather than dropped.
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 70, "BB-SH-BHSS-BLACK-NEW")
    await addProduct("BlackBole Harbor Shore Sandal For Men - Black", 0, "BB-SH-BHSS-BLACK-OLD")
    await sell("BB-SH-BHSS-BLACK-OLD-41", "BlackBole Harbor Shore Sandal For Men - Black", 6, 1000, NOW - 25 * DAY)
    await sell("BB-SH-BHSS-BLACK-NEW-41", "BlackBole Harbor Shore Sandal For Men - Black", 10, 1000, NOW - 20 * DAY)
    await t.run(async (ctx) => {
      const old = (await ctx.db.query("products").collect()).find((p) => p.name === "BlackBole Harbor Shore Sandal For Men - Black" && p.active)!
      // keep the NEW one active; deactivate whichever insert landed first (the OLD shell) by its variant's SKU
      const variants = await ctx.db.query("variants").collect()
      const oldVariant = variants.find((v) => v.sku === "BB-SH-BHSS-BLACK-OLD-41")!
      await ctx.db.patch(oldVariant.productId, { active: false })
    })
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })

    const p = await asAdmin.action(api.targets.progress, {})
    const rows = p.products!.filter((r) => r.name === "BlackBole Harbor Shore Sandal For Men - Black")
    expect(rows).toHaveLength(1)
    expect(rows[0].stockUnits).toBe(70) // the live twin's stock; the deactivated one only contributed sales history
  })
})

describe("marketing budget vs spend", () => {
  const meta = (spendPerDay: number) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const days = Array.from({ length: 10 }, (_, i) => ({ date_start: new Date(NOW + 6 * 3600000 - i * DAY).toISOString().slice(0, 10), spend: String(spendPerDay) }))
      return { json: async () => ({ data: days }) } as any
    }))

  it("shows budget and spend to people with ads access, and nothing to people without", async () => {
    const { t, asAdmin, asCx, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 100, 1000, NOW - 5 * DAY)
    await t.run((ctx) => ctx.db.insert("settings", { key: "metaAds", value: { token: "tok", accounts: [{ id: "1", name: "Main" }] } }))
    meta(1000)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 300000 })

    const admin = await asAdmin.action(api.targets.progress, {})
    expect(admin.marketing!.state).toBe("ok")
    const m = (admin.marketing as any).plan
    expect(m.mer).toBeGreaterThan(0)
    expect(m.budget).toBe(Math.ceil(300000 / m.mer))

    const cx = await asCx.action(api.targets.progress, {})
    expect(cx.marketing).toBeNull()
    expect(cx.products).not.toBeNull() // the product plan is for everyone
  })

  it("says Meta isn't connected when there is no ads setting", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 10, 1000, NOW - 5 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })
    expect((await asAdmin.action(api.targets.progress, {})).marketing).toEqual({ state: "not_configured" })
  })
})

describe("KPI points for the target", () => {
  const withLead = async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.insert("settings", { key: "accountabilityOwners", value: { byTeam: { Marketing: { name: "Nuha", email: "nuha@blackbole.com" } } } }))
    const events = () => s.t.run((ctx) => ctx.db.query("kpiEvents").collect())
    return { ...s, events }
  }

  it("pays the Marketing lead for a week that ended on pace, once", async () => {
    vi.setSystemTime(Date.parse("2026-11-09T04:00:00Z")) // Monday morning, Nov 9
    const { t, asAdmin, sell, events } = await withLead()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 90000 })
    await sell("BB-X-41", "X", 30, 1000, Date.parse("2026-11-03T05:00:00Z")) // 30,000 by Sunday Nov 8 ≥ 90000*8/30 = 24000
    await t.action(internal.targets.weeklyTargetCheck, {})
    await t.action(internal.targets.weeklyTargetCheck, {})
    const ev = (await events()).filter((e) => e.ruleKey === "marketing.target_week_pace")
    expect(ev).toHaveLength(1)
    expect(ev[0].staffName).toBe("Nuha")
  })

  it("pays nothing when the week was behind pace", async () => {
    vi.setSystemTime(Date.parse("2026-11-09T04:00:00Z"))
    const { t, asAdmin, sell, events } = await withLead()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 90000 })
    await sell("BB-X-41", "X", 5, 1000, Date.parse("2026-11-03T05:00:00Z"))
    await t.action(internal.targets.weeklyTargetCheck, {})
    expect(await events()).toHaveLength(0)
  })

  it("pays the month-hit bonus in the first days of the next month, once, only if the month reached its target", async () => {
    vi.setSystemTime(Date.parse("2026-12-02T04:00:00Z"))
    const { t, sell, events } = await withLead()
    await t.run((ctx) => ctx.db.insert("revenueTargets", { month: "2026-11", amount: 50000, setByName: "Emon", updatedAt: NOW }))
    await sell("BB-X-41", "X", 50, 1000, Date.parse("2026-11-20T05:00:00Z"))
    await t.action(internal.targets.monthTargetCheck, {})
    await t.action(internal.targets.monthTargetCheck, {})
    expect((await events()).filter((e) => e.ruleKey === "marketing.target_month_hit")).toHaveLength(1)
  })

  it("does not pay the month bonus for a missed month, or later in the month", async () => {
    vi.setSystemTime(Date.parse("2026-12-02T04:00:00Z"))
    const { t, sell, events } = await withLead()
    await t.run((ctx) => ctx.db.insert("revenueTargets", { month: "2026-11", amount: 50000, setByName: "Emon", updatedAt: NOW }))
    await sell("BB-X-41", "X", 10, 1000, Date.parse("2026-11-20T05:00:00Z"))
    await t.action(internal.targets.monthTargetCheck, {})
    vi.setSystemTime(Date.parse("2026-12-15T04:00:00Z"))
    await sell("BB-X-41", "X", 100, 1000, Date.parse("2026-11-21T05:00:00Z"))
    await t.action(internal.targets.monthTargetCheck, {})
    expect(await events()).toHaveLength(0)
  })
})

describe("profit: running costs against the target", () => {
  const meta = () =>
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ data: Array.from({ length: 10 }, (_, i) => ({ date_start: new Date(NOW + 6 * 3600000 - i * DAY).toISOString().slice(0, 10), spend: "1000" })) }),
    }) as any))
  const prep = async () => {
    const s = await setup()
    await s.addProduct("Soft Slide", 1000, "BB-SOFT") // cost 500, sells at 1000 → 50% margin
    await s.sell("BB-SOFT-41", "Soft Slide", 100, 1000, NOW - 5 * DAY)
    await s.t.run((ctx) => ctx.db.insert("settings", { key: "metaAds", value: { token: "tok", accounts: [{ id: "1", name: "Main" }] } }))
    meta()
    return s
  }

  it("works out break-even and profit at target from margin, ad budget and fixed costs", async () => {
    const { asAdmin } = await prep()
    await asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 127000, rent: 42000, other: 40000 })
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 300000 })
    const p = await asAdmin.action(api.targets.progress, {})
    // the one test order is ৳1,00,000, so ৳177 delivery + packaging is 0.177% of it; payment fee 2.5% (the defaults)
    expect(p.profit).toMatchObject({ fixed: 209000, grossMargin: 0.5, adRate: 0.1, payFeeRate: 0.025, returnRate: 0.3, orderCostRate: 0.003, contribution: 0.372, breakEven: 561117, profitAtTarget: -97259 })
  })

  it("shows no profit until costs are entered, and never to someone without manage rights", async () => {
    const { asAdmin, asCx } = await prep()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 300000 })
    expect((await asAdmin.action(api.targets.progress, {})).profit).toBeNull()
    await asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 127000, rent: 42000, other: 40000 })
    expect((await asAdmin.action(api.targets.progress, {})).profit).not.toBeNull()
    expect((await asCx.action(api.targets.progress, {})).profit).toBeNull()
    expect(await asCx.query(api.targets.getCosts, {})).toBeNull()
    await expect(asCx.mutation(api.targets.setMonthlyCosts, { salary: 1, rent: 1, other: 1 })).rejects.toThrow()
  })

  it("rejects negative costs and reads back what was saved", async () => {
    const { asAdmin } = await setup()
    await expect(asAdmin.mutation(api.targets.setMonthlyCosts, { salary: -1, rent: 0, other: 0 })).rejects.toThrow(/zero or more/)
    await asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 127000, rent: 42000, other: 40000 })
    expect(await asAdmin.query(api.targets.getCosts, {})).toEqual({ salary: 127000, rent: 42000, other: 40000, delivery: 120, packaging: 57, payFeePct: 2.5, returnPct: 30 })
    await asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 1, rent: 2, other: 3, delivery: 130, packaging: 60, payFeePct: 2, returnPct: 25 })
    expect(await asAdmin.query(api.targets.getCosts, {})).toEqual({ salary: 1, rent: 2, other: 3, delivery: 130, packaging: 60, payFeePct: 2, returnPct: 25 })
    await expect(asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 1, rent: 2, other: 3, payFeePct: 250 })).rejects.toThrow(/percentage/)
    await expect(asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 1, rent: 2, other: 3, returnPct: 95 })).rejects.toThrow(/percentage/)
  })
})

describe("stock-weighted plan and automation", () => {
  it("gives a slow-selling product with a big stock pile a real share (the Veyron loafers)", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Fast Sandal", 30, "BB-FAST")
    await addProduct("BlackBole Veyron Casual Loafer - Olive", 90, "BB-VEY")
    await sell("BB-FAST-41", "Fast Sandal", 80, 1000, NOW - 20 * DAY)
    await sell("BB-VEY-41", "Veyron", 20, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 100000 })
    const p = await asAdmin.action(api.targets.progress, {})
    const rows = Object.fromEntries(p.products!.map((r) => [r.key, r]))
    expect(rows["BB-VEY"].monthUnits).toBeGreaterThan(30) // sales alone would give 20 pairs
    expect(rows["BB-VEY"].stockUnits).toBe(90)
  })

  it("measures courier cost, payment fee and return rate from the orders, and uses them for the daily ad limit", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    // 40 delivered orders (courier 100, COD fee 2% of 1,000) and 20 returned → 33.3% returns
    for (let i = 0; i < 40; i++) {
      const id = await sell("BB-SOFT-41", "Soft Slide", 1, 1000, NOW - 5 * DAY)
      await t.run((ctx) => ctx.db.patch(id, { courierCost: 100, codCost: 20 }))
    }
    for (let i = 0; i < 20; i++) {
      const id = await sell("BB-SOFT-41", "Soft Slide", 1, 1000, NOW - 5 * DAY)
      await t.run((ctx) => ctx.db.patch(id, { status: "returned", deliveredAt: undefined, statusChangedAt: NOW - 4 * DAY, courierCost: 100 }))
    }
    await t.run((ctx) => ctx.db.insert("settings", { key: "metaAds", value: { token: "tok", accounts: [{ id: "1", name: "Main" }] } }))
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ data: Array.from({ length: 10 }, (_, i) => ({ date_start: new Date(NOW + 6 * 3600000 - i * DAY).toISOString().slice(0, 10), spend: "500" })) }) }) as any))
    await asAdmin.mutation(api.targets.setMonthlyCosts, { salary: 127000, rent: 42000, other: 40000 })
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 300000 })
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.measured).toEqual({ returnPct: 33.3, delivery: 100, payFeePct: 2, sample: 60 })
    expect(p.profit!.returnRate).toBeCloseTo(0.333, 3)
    const d = p.daily!
    expect(d.adMax).toBeGreaterThan(0)
    expect(d.adBudget).toBeLessThanOrEqual(d.adMax)
    expect(d.ordersToBook).toBeGreaterThan(d.ordersToDeliver) // returns mean more orders must be booked
  })

  it("sets a target by itself when nobody has, never overwrites a person's, and starts next month's on the 25th", async () => {
    const { t, asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 5000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 100, 1000, NOW - 10 * DAY) // 100,000 in the last 30 days
    await t.action(internal.targets.autoTargets, {})
    const row = await t.run((ctx) => ctx.db.query("revenueTargets").first())
    expect(row).toMatchObject({ month: "2026-11", amount: 120000, auto: true }) // 100,000 + 15%, rounded to 10,000
    expect((await asAdmin.query(api.targets.getTarget, { month: "2026-11" }))!.auto).toBe(true)

    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 500000 }) // a person takes over
    await t.action(internal.targets.autoTargets, {})
    expect((await asAdmin.query(api.targets.getTarget, { month: "2026-11" }))).toMatchObject({ amount: 500000, auto: false })

    vi.setSystemTime(Date.parse("2026-11-25T06:00:00Z"))
    await t.action(internal.targets.autoTargets, {})
    expect((await asAdmin.query(api.targets.getTarget, { month: "2026-12" }))!.auto).toBe(true)
  })
})
