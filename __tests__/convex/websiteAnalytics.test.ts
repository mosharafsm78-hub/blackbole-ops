import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  aggregateDay, bdDay, channels, checkoutSummary, dailySeries, dayStart, discountCodes, maxAgeFor, summarize, topProducts,
} from "../../convex/websiteAnalytics"

const DAY = 86400000
const item = (sku: string, price: number, qty: number, discount = 0) => ({ sku, name: `Shoe ${sku}`, price, qty, discount, weightKg: 0.5 })
const order = (o: Partial<any>) => ({
  status: "pending", source: "Website", items: [item("A", 1000, 1)], discount: 0, deliveryFee: 90, total: 1090,
  createdAt: dayStart("2026-10-20") + 3600000 * 10, customerId: "c1", ...o,
}) as any

describe("one day added up", () => {
  it("splits website numbers from other channels and skips cancelled / deleted", () => {
    const d = aggregateDay("2026-10-20", [
      order({}),
      order({ customerId: "c2", items: [item("A", 1000, 2, 100), item("B", 500, 1)], discount: 50, total: 2440, discountCode: "EID10" }),
      order({ customerId: "c3", status: "cancelled" }),
      order({ customerId: "c4", deletedAt: 5 }),
      order({ customerId: "c5", source: "Facebook", total: 3000 }),
      order({ customerId: "c6", status: "returned", total: 1090 }),
    ], new Set(["c2"]))
    expect(d.w).toEqual({ n: 3, gross: 4500, disc: 150, ret: 1000, retN: 1, ship: 270, tot: 4620, units: 5, canc: 1 })
    expect(d.ch).toEqual([{ s: "Website", n: 3, v: 4620 }, { s: "Facebook", n: 1, v: 3000 }])
    expect(d.it.find((i) => i.k === "A")).toMatchObject({ q: 4, v: 3900 })
    expect(d.dc).toEqual([{ c: "EID10", n: 1, v: 2440, d: 150 }])
    expect(d.cu).toEqual([["c1", 0], ["c2", 1], ["c6", 0]])
    expect(d.hs[10]).toBe(4620) // 10:00 in Dhaka
    expect(d.hn[10]).toBe(3)
  })
})

describe("report from days", () => {
  const a = aggregateDay("2026-10-20", [order({}), order({ customerId: "c2", discountCode: "EID10", total: 990, discount: 100 })], new Set())
  const b = aggregateDay("2026-10-22", [order({ customerId: "c1", createdAt: dayStart("2026-10-22") + 1000 })], new Set(["c1"]))

  it("works out Shopify-style totals and returning customers", () => {
    const s = summarize([a, b])
    expect(s).toMatchObject({ orders: 3, gross: 3000, discounts: 100, returns: 0, net: 2900, shipping: 270, total: 3170, aov: 967, customers: 2, returning: 1, returningRate: 50 })
    expect(summarize([])).toMatchObject({ orders: 0, aov: 0, returningRate: null })
  })

  it("fills empty days and groups channels, products and codes", () => {
    expect(dailySeries([a, b], "2026-10-20", "2026-10-22").map((d) => d.orders)).toEqual([2, 0, 1])
    expect(channels([a, b])).toEqual([{ source: "Website", orders: 3, sales: 3170 }])
    expect(topProducts([a, b]).byUnits[0]).toEqual({ sku: "A", name: "Shoe A", units: 3, sales: 3000 })
    expect(discountCodes([a, b])).toEqual([{ code: "EID10", orders: 1, sales: 990, discount: 100 }])
  })

  it("keeps recent days fresher than old ones", () => {
    expect(maxAgeFor("2026-10-27", "2026-10-27")).toBe(5 * 60000)
    expect(maxAgeFor("2026-10-20", "2026-10-27")).toBe(3600000)
    expect(maxAgeFor("2026-09-01", "2026-10-27")).toBe(12 * 3600000)
  })
})

describe("checkouts", () => {
  const now = 10 * DAY
  const c = (o: Partial<any>) => ({ kind: "webcheckout", status: "open", total: 1000, shopCreatedAt: now - DAY, shopUpdatedAt: now - DAY, ...o }) as any
  it("counts abandoned, recovered and normal checkouts", () => {
    const s = checkoutSummary([
      c({ status: "ordered", closedAt: now - DAY + 5 * 60000 }), // finished within 15 minutes: not abandoned
      c({ status: "ordered", closedAt: now - DAY + 3600000 }), // came back an hour later: recovered
      c({ status: "converted", closedAt: now }), // team made the order
      c({ status: "lost", closedAt: now }),
      c({}), // still open
      c({ shopUpdatedAt: now - 60000 }), // too fresh to count as abandoned
    ], now)
    expect(s).toMatchObject({ started: 6, completed: 1, abandoned: 4, abandonedValue: 4000, recovered: 2, recoveredByTeam: 1, open: 1, lost: 1, recoveryRate: 50, checkoutConversion: 50 })
  })
})

describe("overview action", () => {
  it("reports website numbers for a range and its previous period, and stores day summaries", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const today = bdDay(Date.now())
    const start = dayStart(today)
    await t.run(async (ctx) => {
      const locationId = (await ctx.db.query("locations").first())!._id
      const cust = async (phone: string) => ctx.db.insert("customers", { code: Number(phone.slice(-3)), name: "C", phone, tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 0 })
      const c1 = await cust("01711111111"), c2 = await cust("01722222222"), c3 = await cust("01733333333")
      let n = 1
      const add = (customerId: Id<"customers">, createdAt: number, extra: Partial<any> = {}) => ctx.db.insert("orders", {
        invoiceNo: n++, status: "pending", source: "Website", customerId, customerName: "C", phone: "017", address: "x", locationId, deliveryType: "regular",
        items: [item("A", 1000, 1)], subtotal: 1000, discount: 0, deliveryFee: 90, paidAmount: 0, total: 1090, due: 1090, callCount: 0,
        createdByName: "API", createdAt, updatedAt: createdAt, statusChangedAt: createdAt, ...extra,
      } as any)
      await add(c1, start - 3 * DAY) // before the range: makes c1 a returning customer
      await add(c1, start + 1000)
      await add(c2, start + 2000, { discountCode: "EID10" })
      await add(c3, start + 3000, { source: "Facebook", total: 500 })
      await add(c3, start - 1 * DAY) // the day before = previous period of "today"
      await ctx.db.insert("checkouts", { checkoutId: "codform:01733333333", kind: "codform", customerName: "C", phone: "01733333333", address: "", items: [], subtotal: 1000, discount: 0, deliveryFee: 90, total: 1090, shopCreatedAt: start + 10, shopUpdatedAt: start + 10, status: "open", callCount: 0 })
    })
    const r: any = await as.action(api.websiteAnalytics.overview, { fromDay: today, toDay: today, todo: true })
    expect(r.cur.summary).toMatchObject({ orders: 2, total: 2180, customers: 2, returning: 1, returningRate: 50 })
    expect(r.prev.summary).toMatchObject({ orders: 1, total: 1090 })
    expect(r.channels).toEqual([{ source: "Website", orders: 2, sales: 2180 }, { source: "Facebook", orders: 1, sales: 500 }])
    expect(r.discountCodes[0]).toMatchObject({ code: "EID10", orders: 1 })
    expect(r.checkouts.started).toBe(1)
    expect(r.todo.pending.n).toBeGreaterThanOrEqual(2)
    const stored = await t.run((ctx) => ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", `webDay:${today}`)).first())
    expect(stored?.value.w.n).toBe(2)

    // signed out: nothing
    expect(await t.action(api.websiteAnalytics.overview, { fromDay: today, toDay: today })).toBeNull()
  })
})
