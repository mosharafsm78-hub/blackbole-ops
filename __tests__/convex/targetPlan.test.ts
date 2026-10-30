import { describe, expect, it } from "vitest"
import { allocateRevenue, buildPlan, marketingPlan, onPace, productRows, skuBase, summarizeSales, type ProductInput, type ProductPlan } from "../../convex/targetPlan"
import { nextMonthKey, prevMonthKey } from "../../convex/targetMath"

const p = (key: string, demandRevenue: number, stockUnits: number | null, price = 1000): ProductInput => ({ key, name: key, price, demandRevenue, stockUnits })
const byKey = (rows: ReturnType<typeof allocateRevenue>["rows"]) => Object.fromEntries(rows.map((r) => [r.key, r]))

describe("skuBase", () => {
  it("drops the size segment, and leaves a SKU with no dash alone", () => {
    expect(skuBase("BB-HSS-41")).toBe("BB-HSS")
    expect(skuBase("BB-HSS-BLK-42")).toBe("BB-HSS-BLK")
    expect(skuBase("SINGLE")).toBe("SINGLE")
  })
})

describe("allocating the target across products", () => {
  it("splits by demand when stock is not a limit", () => {
    const { rows, gap } = allocateRevenue([p("A", 600, null), p("B", 400, null)], 100000)
    const r = byKey(rows)
    expect(r.A.revenue).toBe(60000); expect(r.A.units).toBe(60)
    expect(r.B.revenue).toBe(40000); expect(r.B.units).toBe(40)
    expect(gap).toBe(0)
  })

  it("never asks a product for more pairs than it has, and moves the rest to the others by demand", () => {
    const { rows, gap } = allocateRevenue([p("A", 600, 10), p("B", 400, null)], 100000)
    const r = byKey(rows)
    expect(r.A).toMatchObject({ units: 10, revenue: 10000, capped: true })
    expect(r.B.units).toBe(90)
    expect(gap).toBe(0)
  })

  it("keeps redistributing when a second product runs out only after the first one's share moved over", () => {
    // A (d50, 5 in stock) caps first; its overflow pushes B (d30, 40 in stock) over its own limit; C takes what's left.
    const { rows } = allocateRevenue([p("A", 50, 5), p("B", 30, 40), p("C", 20, null)], 100000)
    const r = byKey(rows)
    expect(r.A.units).toBe(5)
    expect(r.B.units).toBe(40)
    expect(r.C.units).toBe(55)
  })

  it("reports a stock gap when the whole range cannot carry the target", () => {
    const { rows, gap } = allocateRevenue([p("A", 600, 10), p("B", 400, 20)], 100000)
    expect(rows.reduce((s, r) => s + r.units, 0)).toBe(30)
    expect(gap).toBe(70000)
  })

  it("does not cap pre-order products (stock unknown or arriving on demand)", () => {
    const { rows } = allocateRevenue([p("PRE", 100, null)], 50000)
    expect(rows[0].units).toBe(50)
  })

  it("ignores products with no recent sales or no stock", () => {
    const { rows } = allocateRevenue([p("DEAD", 0, 500), p("OOS", 300, 0), p("A", 100, null)], 10000)
    expect(rows.map((r) => r.key)).toEqual(["A"])
  })

  it("rounds pairs up, so the plan is never short of the money", () => {
    const { rows } = allocateRevenue([p("A", 1, null, 1480)], 5000)
    expect(rows[0].units).toBe(4) // 5000 / 1480 = 3.38
  })

  it("allocates nothing for a zero target", () => {
    expect(allocateRevenue([p("A", 1, null)], 0)).toEqual({ rows: [], gap: 0 })
  })
})

describe("building the month plan", () => {
  it("keeps what each product already sold and adds what is planned from here", () => {
    const plan = buildPlan({ at: 1, revenueLeft: 7000, products: [p("A", 1, null)], soldMtd: { A: 3 } })
    expect(plan.products.A.units).toBe(3 + 7)
    expect(plan.revenueLeft).toBe(7000)
  })

  it("keeps a product that sold but needs nothing more (out of stock), finished at what it sold", () => {
    const plan = buildPlan({ at: 1, revenueLeft: 5000, products: [p("A", 1, null), p("SOLDOUT", 5, 0)], soldMtd: { SOLDOUT: 4 } })
    expect(plan.products.SOLDOUT.units).toBe(4)
    expect(plan.products.A.units).toBe(5)
  })
})

describe("per-product daily targets re-balance", () => {
  const plan = (units: number): ProductPlan => ({ at: 0, revenueLeft: 0, gap: 0, products: { A: { name: "A", units, price: 1000 } } })
  const row = (units: number, sold: Record<string, number>, today: string, daysLeft: number, extra: Partial<Parameters<typeof productRows>[0]> = {}) =>
    productRows({ plan: plan(units), sold: { A: sold }, today, daysLeft, started: true, stockUnits: { A: null }, trailingUnits: {}, trailingDays: 60, ...extra })[0]

  it("starts the day at its fair share of what's missing", () => {
    expect(row(20, {}, "2026-11-26", 5).todayTarget).toBe(4)
  })

  it("makes the next day heavier when today missed: 4 due, 1 sold → tomorrow asks for more", () => {
    const today = row(20, { "2026-11-26": 1 }, "2026-11-26", 5)
    expect(today.todayTarget).toBe(4)
    expect(today.todaySold).toBe(1)
    expect(today.toGo).toBe(3)
    expect(today.left).toBe(19)
    expect(today.perDayAfterToday).toBe(5) // ceil(19 / 4)
    const tomorrow = row(20, { "2026-11-26": 1 }, "2026-11-27", 4)
    expect(tomorrow.todayTarget).toBe(5)
    expect(tomorrow.todayTarget!).toBeGreaterThan(today.todayTarget!)
  })

  it("makes the next day lighter when today beat its share", () => {
    const tomorrow = row(20, { "2026-11-26": 8 }, "2026-11-27", 4)
    expect(tomorrow.todayTarget).toBe(3) // ceil(12 / 4)
  })

  it("asks for nothing once the product's plan is done", () => {
    const r = row(10, { "2026-11-10": 10 }, "2026-11-12", 19)
    expect(r.left).toBe(0)
    expect(r.todayTarget).toBe(0)
    expect(r.perDayAfterToday).toBe(0)
  })

  it("has no daily target before the month starts", () => {
    const r = row(20, {}, "2026-11-20", 30, { started: false })
    expect(r.todayTarget).toBeNull()
    expect(r.toGo).toBe(0)
  })

  it("counts pairs the current stock cannot cover, and spots overstock from days of cover", () => {
    const short = row(30, { "2026-11-05": 7 }, "2026-11-06", 20, { stockUnits: { A: 10 } })
    expect(short.left).toBe(23)
    expect(short.stockShort).toBe(13)
    const heavy = row(30, {}, "2026-11-06", 20, { stockUnits: { A: 300 }, trailingUnits: { A: 60 } })
    expect(heavy.coverDays).toBe(300)
    expect(heavy.overstock).toBe(true)
    const lean = row(30, {}, "2026-11-06", 20, { stockUnits: { A: 30 }, trailingUnits: { A: 60 } })
    expect(lean.overstock).toBe(false)
  })

  it("lists the biggest plan first", () => {
    const rows = productRows({
      plan: { at: 0, revenueLeft: 0, gap: 0, products: { S: { name: "Small", units: 2, price: 1 }, B: { name: "Big", units: 40, price: 1 } } },
      sold: {}, today: "2026-11-02", daysLeft: 29, started: true, stockUnits: {}, trailingUnits: {}, trailingDays: 60,
    })
    expect(rows.map((r) => r.key)).toEqual(["B", "S"])
  })
})

describe("marketing budget from the target", () => {
  const base = { target: 1200000, trailingRevenue: 600000, trailingSpend: 100000, days: 30 }

  it("sizes the budget as target ÷ revenue earned per taka of ad spend", () => {
    const m = marketingPlan({ ...base, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1 })
    expect(m.mer).toBe(6)
    expect(m.budget).toBe(200000)
    expect(m.status).toBe("on_track")
  })

  it("does not judge the first days of the month — deliveries lag the ads that brought them", () => {
    expect(marketingPlan({ ...base, deliveredMtd: 0, spentMtd: 90000, dayOfMonth: 3 }).status).toBe("on_track")
    expect(marketingPlan({ ...base, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 3 }).status).toBe("on_track")
    expect(marketingPlan({ ...base, deliveredMtd: 0, spentMtd: 90000, dayOfMonth: 4 }).status).toBe("overspending")
  })

  it("flags overspending: spend ahead of the calendar while revenue is behind pace", () => {
    const m = marketingPlan({ ...base, deliveredMtd: 200000, spentMtd: 90000, dayOfMonth: 10 })
    expect(m.expectedToDate).toBe(66667)
    expect(m.remaining).toBe(110000)
    expect(m.status).toBe("overspending")
  })

  it("flags underspending: revenue behind pace and spend behind too", () => {
    expect(marketingPlan({ ...base, deliveredMtd: 200000, spentMtd: 30000, dayOfMonth: 10 }).status).toBe("underspending")
  })

  it("is on track whenever revenue keeps pace, even with spend ahead", () => {
    expect(marketingPlan({ ...base, deliveredMtd: 450000, spentMtd: 90000, dayOfMonth: 10 }).status).toBe("on_track")
  })

  it("says how much more spend the rest of the target needs", () => {
    expect(marketingPlan({ ...base, deliveredMtd: 200000, spentMtd: 50000, dayOfMonth: 10 }).neededForRest).toBe(166667)
  })

  it("gives no budget without history to base it on", () => {
    const m = marketingPlan({ ...base, trailingSpend: 0, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 5 })
    expect(m).toMatchObject({ status: "no_history", budget: null, mer: null })
  })
})

describe("pace and sales history", () => {
  it("compares delivered revenue with the straight-line share of the target", () => {
    expect(onPace({ target: 30000, delivered: 8000, dayOfMonth: 8, days: 30 })).toBe(true)
    expect(onPace({ target: 30000, delivered: 7999, dayOfMonth: 8, days: 30 })).toBe(false)
  })

  it("turns delivered orders into Dhaka-day revenue, per-product totals and this month's units", () => {
    const month = { startMs: Date.parse("2026-10-31T18:00:00Z"), endMs: Date.parse("2026-11-30T18:00:00Z") }
    const s = summarizeSales([
      { at: Date.parse("2026-11-02T04:00:00Z"), total: 3500, items: [{ k: "A", n: "A Black", q: 2, a: 3000 }] },
      { at: Date.parse("2026-11-02T08:00:00Z"), total: 1700, items: [{ k: "A", n: "A Black", q: 1, a: 1500 }, { k: "B", n: "B", q: 1, a: 200 }] },
      { at: Date.parse("2026-10-20T08:00:00Z"), total: 900, items: [{ k: "A", n: "A Black", q: 1, a: 900 }] }, // before the month
    ], month)
    expect(s.byDay).toEqual({ "2026-11-02": 5200, "2026-10-20": 900 })
    expect(s.trailing.A).toEqual({ name: "A Black", units: 4, revenue: 5400 })
    expect(s.mtd.A).toEqual({ "2026-11-02": 3 })
    expect(s.mtd.B).toEqual({ "2026-11-02": 1 })
    expect(s.ratio).toBeCloseTo(6100 / 5600, 5)
  })

  it("falls back to a ratio of 1 with no lines", () => {
    expect(summarizeSales([], { startMs: 0, endMs: 1 }).ratio).toBe(1)
  })

  it("steps between months across a year end", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01")
    expect(nextMonthKey("2026-10")).toBe("2026-11")
    expect(prevMonthKey("2027-01")).toBe("2026-12")
    expect(prevMonthKey("2026-11")).toBe("2026-10")
  })
})

import { fixedTotal, mixMargin, profitPlan } from "../../convex/targetPlan"

describe("profit: margin, break-even and profit at target", () => {
  const costs = { salary: 127000, rent: 42000, other: 40000 }

  it("adds the fixed costs", () => {
    expect(fixedTotal(costs)).toBe(209000)
  })

  it("weights margin by revenue and ignores products with no known cost", () => {
    // A: 10 × 1000 at cost 400 (60%), B: 10 × 2000 at cost 1400 (30%) → (6000+6000)/(10000+20000) = 40%
    expect(mixMargin([{ units: 10, price: 1000, cost: 400 }, { units: 10, price: 2000, cost: 1400 }, { units: 99, price: 500, cost: null }])).toBeCloseTo(0.4, 5)
    expect(mixMargin([{ units: 5, price: 1000, cost: null }])).toBeNull()
  })

  it("break-even = fixed ÷ (margin − ad spend per taka); profit at target follows", () => {
    // margin 55%, MER 4 → ads 25% of revenue → 30% contributes → 209,000 / 0.30 = 696,667
    const p = profitPlan({ target: 1200000, grossMargin: 0.55, mer: 4, costs, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1, days: 30 })
    expect(p.contribution).toBeCloseTo(0.3, 5)
    expect(p.breakEven).toBe(696667)
    expect(p.profitAtTarget).toBe(Math.round(1200000 * 0.3 - 209000)) // 151,000
    expect(p.coverage).toBeCloseTo(1.72, 2)
  })

  it("never breaks even when ads eat the whole margin", () => {
    const p = profitPlan({ target: 1200000, grossMargin: 0.3, mer: 3, costs, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1, days: 30 })
    expect(p.breakEven).toBeNull()
    expect(p.profitAtTarget).toBeLessThan(0)
  })

  it("profit so far counts fixed costs only for the days gone", () => {
    const p = profitPlan({ target: 1200000, grossMargin: 0.5, mer: 4, costs, deliveredMtd: 400000, spentMtd: 90000, dayOfMonth: 10, days: 30 })
    expect(p.profitMtd).toBe(Math.round(400000 * 0.5 - 90000 - (209000 * 10) / 30)) // 40,333
  })
})

import { allocateGrouped, classify } from "../../convex/targetPlan"

describe("focus / others / dead-stock groups", () => {
  it("sends broken size runs and never-selling stock to dead, thin stock to others, the rest to focus", () => {
    expect(classify({ stockUnits: 60, sizesIn: 6, sizesTotal: 7, soldUnits: 20 })).toBe("focus")
    expect(classify({ stockUnits: 60, sizesIn: 2, sizesTotal: 7, soldUnits: 20 })).toBe("dead") // only 2 of 7 sizes left
    expect(classify({ stockUnits: 60, sizesIn: 3, sizesTotal: 8, soldUnits: 20 })).toBe("dead") // under 60% of sizes
    expect(classify({ stockUnits: 60, sizesIn: 6, sizesTotal: 7, soldUnits: 0 })).toBe("dead") // stock, no sales
    expect(classify({ stockUnits: 6, sizesIn: 6, sizesTotal: 7, soldUnits: 20 })).toBe("other") // fine sizes, thin stock
    expect(classify({ stockUnits: 40, sizesIn: 1, sizesTotal: 1, soldUnits: 5 })).toBe("focus") // sizeless item
    expect(classify({ stockUnits: null, sizesIn: 0, sizesTotal: 0, soldUnits: 5 })).toBe("focus") // pre-order
  })

  it("puts 80% on focus, 12% on others, 8% on dead stock", () => {
    const mk = (key: string, group: "focus" | "other" | "dead"): any => ({ key, name: key, price: 1000, demandRevenue: 100, stockUnits: null, group })
    const { rows } = allocateGrouped([mk("F", "focus"), mk("O", "other"), mk("D", "dead")], 100000)
    const r = Object.fromEntries(rows.map((x) => [x.key, x.revenue]))
    expect(r).toEqual({ D: 8000, O: 12000, F: 80000 })
  })

  it("hands what a small group's stock can't carry back to focus, and lets one group take everything if alone", () => {
    const mk = (key: string, group: "focus" | "dead", stockUnits: number | null): any => ({ key, name: key, price: 1000, demandRevenue: 100, stockUnits, group })
    const { rows } = allocateGrouped([mk("F", "focus", null), mk("D", "dead", 3)], 100000)
    const r = Object.fromEntries(rows.map((x) => [x.key, x.units]))
    expect(r).toEqual({ D: 3, F: 97 })
    expect(allocateGrouped([mk("D", "dead", 500)], 100000).rows[0].units).toBe(100)
  })
})

describe("profit: per-order costs", () => {
  it("with 30% returns, each delivered order carries 1/0.7 shipments of delivery and packaging", () => {
    const base = { target: 1200000, grossMargin: 0.55, ratio: 1, aov: 1770, mer: 4, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1, days: 30 }
    const costs = { salary: 127000, rent: 42000, other: 40000, delivery: 120, packaging: 57, payFeePct: 2.5 }
    const none = profitPlan({ ...base, costs })
    const ret = profitPlan({ ...base, costs: { ...costs, returnPct: 30 } })
    expect(ret.orderCostRate).toBeCloseTo(0.1 / 0.7, 3)
    expect(ret.returnRate).toBe(0.3)
    expect(ret.contribution).toBeLessThan(none.contribution)
    expect(ret.breakEven!).toBeGreaterThan(none.breakEven!)
  })

  it("takes delivery, packaging and the payment fee off every taka before fixed costs", () => {
    // margin 55%, no delivery-fee income (ratio 1), average order ৳1,770 → ৳177 per order = 10%, payment fee 2.5%, ads 25% (MER 4)
    const p = profitPlan({ target: 1200000, grossMargin: 0.55, ratio: 1, aov: 1770, mer: 4, costs: { salary: 127000, rent: 42000, other: 40000, delivery: 120, packaging: 57, payFeePct: 2.5 }, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1, days: 30 })
    expect(p.orderCostRate).toBeCloseTo(0.1, 3)
    expect(p.payFeeRate).toBe(0.025)
    expect(p.contribution).toBeCloseTo(0.175, 3)
    expect(p.breakEven).toBe(Math.ceil(209000 / 0.175))
    expect(p.profitAtTarget).toBe(Math.round(1200000 * 0.175 - 209000))
  })

  it("counts the delivery fee customers pay as income against the courier", () => {
    // ratio 1.1 → 1/11 of each order is delivery fee collected; shoes are 10/11 of it
    const p = profitPlan({ target: 1000000, grossMargin: 0.5, ratio: 1.1, aov: 1100, mer: 100, costs: { salary: 0, rent: 0, other: 0, delivery: 0, packaging: 0, payFeePct: 0 }, deliveredMtd: 0, spentMtd: 0, dayOfMonth: 1, days: 30 })
    expect(p.contribution).toBeCloseTo(0.5 / 1.1 + 1 - 1 / 1.1 - 0.01, 3)
  })
})
