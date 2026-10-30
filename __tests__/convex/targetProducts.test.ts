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

  const addProduct = async (name: string, stock: number | null, base: string, extra: { preOrder?: boolean } = {}) => {
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
    expect(rows["BB-SOFT"].monthUnits).toBe(90)
    expect(rows["BB-DEAD"]).toBeUndefined()
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
    await addProduct("Soft Slide", null, "BB-SOFT", { preOrder: true })
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 210000 })
    const first = await asAdmin.action(api.targets.progress, {})
    const row = first.products![0]
    expect(row.monthUnits).toBe(210)
    expect(row.todayTarget).toBe(Math.ceil(210 / 21)) // 21 days left incl. today → 10

    const saved = await t.run((ctx) => ctx.db.query("revenueTargets").first())
    expect(saved!.plan.products["BB-SOFT"].units).toBe(210)

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

  it("previews next month when only next month has a target", async () => {
    const { asAdmin, addProduct, sell } = await setup()
    await addProduct("Soft Slide", 1000, "BB-SOFT")
    await sell("BB-SOFT-41", "Soft Slide", 40, 1000, NOW - 20 * DAY)
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-12", amount: 100000 })
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.month).toBe("2026-12")
    expect(p.plan!.started).toBe(false)
    expect(p.products![0].todayTarget).toBeNull()
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
