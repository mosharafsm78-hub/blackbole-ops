import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { daysInMonth, dhakaDay, dhakaMonth, monthEndMs, monthStartMs, planMonth, sumDeliveredByDay } from "../../convex/targetMath"

/**
 * Company revenue target. Revenue = delivered orders' total on the Dhaka day of delivery; the monthly target
 * re-balances into daily targets (what's still missing ÷ days still left). The risks worth pinning down: the
 * re-balancing maths, Dhaka (UTC+6) day/month edges, only-delivered/not-deleted counting, and who may set it.
 */

// 2026-11-10 12:00 in Dhaka
const NOW = Date.parse("2026-11-10T06:00:00Z")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe("daily allocation maths", () => {
  it("starts as an even split on day 1", () => {
    const p = planMonth({ month: "2026-11", target: 30000, deliveredByDay: {}, today: "2026-11-01" })
    expect(p.today).toEqual({ day: "2026-11-01", target: 1000, delivered: 0, toGo: 1000 })
    expect(p.daysLeft).toBe(30)
    expect(p.days).toHaveLength(1)
  })

  it("raises the next day's target after a slow day", () => {
    const p = planMonth({ month: "2026-11", target: 30000, deliveredByDay: { "2026-11-01": 0 }, today: "2026-11-02" })
    expect(p.days.map((d) => d.target)).toEqual([1000, Math.ceil(30000 / 29)])
    expect(p.days[0].hit).toBe(false)
  })

  it("lowers the next day's target after a big day", () => {
    const p = planMonth({ month: "2026-11", target: 30000, deliveredByDay: { "2026-11-01": 5000 }, today: "2026-11-02" })
    expect(p.days[0].hit).toBe(true)
    expect(p.days[1].target).toBe(Math.ceil(25000 / 29))
  })

  it("asks for nothing more once the month is already beaten", () => {
    const p = planMonth({ month: "2026-11", target: 10000, deliveredByDay: { "2026-11-02": 12000 }, today: "2026-11-05" })
    expect(p.remaining).toBe(0)
    expect(p.pct).toBe(120)
    expect(p.today!.target).toBe(0)
    expect(p.today!.toGo).toBe(0)
    expect(p.perDayFromTomorrow).toBe(0)
  })

  it("rounds daily targets up so hitting every day always meets the month", () => {
    const p = planMonth({ month: "2026-11", target: 100000, deliveredByDay: {}, today: "2026-11-01" })
    expect(p.today!.target).toBe(Math.ceil(100000 / 30))
    expect(p.today!.target * 30).toBeGreaterThanOrEqual(100000)
  })

  it("reports what each remaining day must deliver, excluding today", () => {
    const p = planMonth({ month: "2026-11", target: 30000, deliveredByDay: { "2026-11-01": 1000, "2026-11-02": 500 }, today: "2026-11-02" })
    expect(p.remaining).toBe(28500)
    expect(p.daysLeft).toBe(29)
    expect(p.perDayFromTomorrow).toBe(Math.ceil(28500 / 28))
  })

  it("on the last day there are no later days to ask anything of", () => {
    const p = planMonth({ month: "2026-11", target: 30000, deliveredByDay: { "2026-11-29": 100 }, today: "2026-11-30" })
    expect(p.daysLeft).toBe(1)
    expect(p.perDayFromTomorrow).toBe(0)
    expect(p.today!.target).toBe(29900) // everything still missing lands on the final day
    expect(p.days).toHaveLength(30)
  })

  it("a finished month has no 'today' and no days left, but keeps its history", () => {
    const p = planMonth({ month: "2026-10", target: 31000, deliveredByDay: { "2026-10-15": 31000 }, today: "2026-11-02" })
    expect(p.finished).toBe(true)
    expect(p.daysLeft).toBe(0)
    expect(p.today).toBeNull()
    expect(p.days).toHaveLength(31)
    expect(p.pct).toBe(100)
  })

  it("a month that has not started lists no days and asks for no per-day pace", () => {
    const p = planMonth({ month: "2026-12", target: 31000, deliveredByDay: {}, today: "2026-11-10" })
    expect(p.started).toBe(false)
    expect(p.days).toHaveLength(0)
    expect(p.today).toBeNull()
    expect(p.perDayFromTomorrow).toBe(0)
  })

  it("ignores delivered money from days outside the month", () => {
    const p = planMonth({ month: "2026-11", target: 1000, deliveredByDay: { "2026-10-31": 999, "2026-11-01": 100, "2026-12-01": 999 }, today: "2026-11-02" })
    expect(p.delivered).toBe(100)
  })

  it("handles February in a leap and a non-leap year", () => {
    expect(daysInMonth("2028-02")).toBe(29)
    expect(daysInMonth("2026-02")).toBe(28)
  })
})

describe("Dhaka day and month edges", () => {
  it("counts an order delivered at 23:59 Dhaka on the 31st as October, and 00:01 on the 1st as November", () => {
    const lastOct = Date.parse("2026-10-31T17:59:00Z") // 23:59 Dhaka
    const firstNov = Date.parse("2026-10-31T18:01:00Z") // 00:01 Dhaka, Nov 1
    expect(dhakaDay(lastOct)).toBe("2026-10-31")
    expect(dhakaDay(firstNov)).toBe("2026-11-01")
    expect(dhakaMonth(lastOct)).toBe("2026-10")
    expect(dhakaMonth(firstNov)).toBe("2026-11")
  })

  it("month bounds are Dhaka midnight, and the end is the next month's start", () => {
    expect(monthStartMs("2026-11")).toBe(Date.parse("2026-10-31T18:00:00Z"))
    expect(monthEndMs("2026-11")).toBe(monthStartMs("2026-12"))
  })

  it("sums rows into Dhaka days", () => {
    const sums = sumDeliveredByDay([
      { at: Date.parse("2026-11-01T18:30:00Z"), total: 100 }, // Nov 2, 00:30 Dhaka
      { at: Date.parse("2026-11-02T05:00:00Z"), total: 250 }, // Nov 2, 11:00 Dhaka
      { at: Date.parse("2026-11-02T17:59:00Z"), total: 50 }, // Nov 2, 23:59 Dhaka
    ])
    expect(sums).toEqual({ "2026-11-02": 400 })
  })
})

// ---------------------------------------------------------------------------------------------------------------

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const adminUser = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const asAdmin = t.withIdentity({ subject: `${adminUser}|s1` })
  await asAdmin.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await asAdmin.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id

  const roles = await asAdmin.query(api.team.listRoles, {})
  const cx = roles.find((r) => r.name === "Team CX")!
  const cxUser = await t.run((ctx) => ctx.db.insert("users", { email: "nuha@blackbole.com" }))
  await asAdmin.mutation(api.team.saveStaff, { email: "nuha@blackbole.com", name: "Nuha", roleId: cx._id, active: true })
  const asCx = t.withIdentity({ subject: `${cxUser}|s2` })

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { code: 1, name: "Test Customer", phone: "01711000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: NOW }),
  )
  let invoiceNo = 1000
  const addOrder = (o: { status: string; total: number; deliveredAt?: number; deletedAt?: number }) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        invoiceNo: ++invoiceNo, status: o.status as any, source: "Website", customerId, customerName: "Test Customer", phone: "01711000000",
        address: "House 1, Road 2", locationId: locationId as Id<"locations">, deliveryType: "regular",
        items: [{ sku: "BB-X-41", name: "Test Sandal", price: o.total, qty: 1, discount: 0, weightKg: 0.4 }],
        subtotal: o.total, discount: 0, deliveryFee: 0, paidAmount: 0, total: o.total, due: o.total, callCount: 0,
        createdByName: "Emon", createdAt: NOW - 20 * 86400000, updatedAt: NOW, statusChangedAt: NOW,
        deliveredAt: o.deliveredAt, deletedAt: o.deletedAt,
      }),
    )
  return { t, asAdmin, asCx, addOrder }
}

describe("setting the target", () => {
  it("lets an admin set and read back this month's target", async () => {
    const { asAdmin } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 3000000 })
    const row = await asAdmin.query(api.targets.getTarget, { month: "2026-11" })
    expect(row).toMatchObject({ month: "2026-11", amount: 3000000, setByName: "Emon" })
  })

  it("updates in place rather than adding a second row, and 0 clears it", async () => {
    const { t, asAdmin } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 1000 })
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 2500.4 })
    expect((await t.run((ctx) => ctx.db.query("revenueTargets").collect()))).toHaveLength(1)
    expect((await asAdmin.query(api.targets.getTarget, { month: "2026-11" }))!.amount).toBe(2500) // whole taka
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 0 })
    expect(await asAdmin.query(api.targets.getTarget, { month: "2026-11" })).toBeNull()
  })

  it("lets a future month be planned ahead", async () => {
    const { asAdmin } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-12", amount: 4000000 })
    expect((await asAdmin.query(api.targets.getTarget, { month: "2026-12" }))!.amount).toBe(4000000)
  })

  it("refuses a finished month, a malformed month, and a negative or non-numeric amount", async () => {
    const { asAdmin } = await setup()
    await expect(asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-10", amount: 1000 })).rejects.toThrow(/current or a future month/)
    await expect(asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-13", amount: 1000 })).rejects.toThrow(/valid month/)
    await expect(asAdmin.mutation(api.targets.setMonthlyTarget, { month: "Nov 2026", amount: 1000 })).rejects.toThrow(/valid month/)
    await expect(asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: -5 })).rejects.toThrow(/zero or more/)
    await expect(asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: Number.NaN })).rejects.toThrow(/zero or more/)
  })

  it("does not let someone without team-management rights change it, but they can read it", async () => {
    const { asAdmin, asCx } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 1000 })
    await expect(asCx.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 999999 })).rejects.toThrow(/permission/)
    expect((await asCx.query(api.targets.getTarget, { month: "2026-11" }))!.amount).toBe(1000)
  })

  it("shows nothing to someone who is not signed in", async () => {
    const { t } = await setup()
    expect(await t.query(api.targets.getTarget, { month: "2026-11" })).toBeNull()
  })
})

describe("progress against the target", () => {
  it("returns no plan when no target is set", async () => {
    const { asAdmin } = await setup()
    const p = await asAdmin.action(api.targets.progress, {})
    expect(p).toMatchObject({ month: "2026-11", target: null, plan: null })
  })

  it("adds up only delivered, not-deleted orders delivered inside the Dhaka month, per Dhaka day", async () => {
    const { asAdmin, addOrder } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 30000 })

    await addOrder({ status: "delivered_paid", total: 3000, deliveredAt: Date.parse("2026-11-02T04:00:00Z") }) // Nov 2
    await addOrder({ status: "delivered_due", total: 2000, deliveredAt: Date.parse("2026-11-09T10:00:00Z") }) // Nov 9
    await addOrder({ status: "delivered_paid", total: 1500, deliveredAt: Date.parse("2026-11-10T03:00:00Z") }) // Nov 10 (today)
    // none of these count:
    await addOrder({ status: "delivered_paid", total: 9999, deliveredAt: Date.parse("2026-11-10T03:30:00Z"), deletedAt: NOW }) // deleted
    await addOrder({ status: "returned", total: 7777, deliveredAt: Date.parse("2026-11-10T04:00:00Z") }) // came back
    await addOrder({ status: "delivered_paid", total: 5555, deliveredAt: Date.parse("2026-10-31T17:30:00Z") }) // 23:30 Dhaka, Oct 31
    await addOrder({ status: "in_transit", total: 4444 }) // not delivered yet

    const p = await asAdmin.action(api.targets.progress, {})
    expect(p.target).toEqual({ amount: 30000, setByName: "Emon" })
    const plan = p.plan!
    expect(plan.delivered).toBe(6500)
    expect(plan.remaining).toBe(23500)
    expect(plan.daysLeft).toBe(21)
    expect(plan.days.find((d) => d.day === "2026-11-02")!.delivered).toBe(3000)
    expect(plan.days.find((d) => d.day === "2026-11-09")!.delivered).toBe(2000)
    expect(plan.today).toEqual({ day: "2026-11-10", target: Math.ceil(25000 / 21), delivered: 1500, toGo: 0 })
    expect(plan.perDayFromTomorrow).toBe(Math.ceil(23500 / 20))
  })

  it("picks up a changed target immediately, even though the day totals are cached", async () => {
    const { asAdmin, addOrder } = await setup()
    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 30000 })
    await addOrder({ status: "delivered_paid", total: 3000, deliveredAt: Date.parse("2026-11-02T04:00:00Z") })
    const first = await asAdmin.action(api.targets.progress, {})
    expect(first.plan!.delivered).toBe(3000)

    await asAdmin.mutation(api.targets.setMonthlyTarget, { month: "2026-11", amount: 60000 })
    const second = await asAdmin.action(api.targets.progress, {})
    expect(second.plan!.target).toBe(60000)
    expect(second.plan!.delivered).toBe(3000)
  })

  it("rejects an invalid month and an unauthenticated caller", async () => {
    const { t, asAdmin } = await setup()
    await expect(asAdmin.action(api.targets.progress, { month: "nope" })).rejects.toThrow(/valid month/)
    await expect(t.action(api.targets.progress, {})).rejects.toThrow(/not signed in/)
  })
})
