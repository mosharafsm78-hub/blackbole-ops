import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, { name: "Veyron Loafer", active: true, variants: [{ sku: "VL-42", title: "42", weightKg: 0.5, price: 1900, purchasePrice: 700, active: true }] })
  const v42 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "VL-42")).unique()))!
  await t.run((ctx) => ctx.db.insert("settings", { key: "monthlyCosts", value: { salary: 300000, rent: 0, other: 0, delivery: 120, packaging: 50, payFeePct: 0, returnPct: 30 } }))
  const at = Date.parse("2026-11-10T12:00:00+06:00")
  const order = async (source: string, campaignId: string | undefined, status: string, extra: any = {}) => {
    const r = await as.mutation(api.orders.create, { source, customerName: "Karim", phone: "01711000099", address: "House 1, Road 2, Dhanmondi, Dhaka", locationId, deliveryType: "regular", items: [{ variantId: v42._id, qty: 1, price: 1900, discount: 0 }], discount: 0, deliveryFee: 90, advanceAmount: 0, advanceMethod: "bKash", approve: false })
    await t.run((ctx) => ctx.db.patch(r.orderId, { createdAt: at, status: status as any, campaignId, ...extra }))
    return r.orderId
  }
  return { t, as, order }
}

describe("profit page", () => {
  it("gives each website order its campaign's spend, chat orders nothing, and the Meta total always adds up", async () => {
    const { t, as, order } = await setup()
    await t.mutation(internal.profit.saveSpend, {
      days: ["2026-11-10"], info: {},
      rows: [
        { day: "2026-11-10", accountId: "1", campaignId: "111", campaignName: "Veyron sale", spend: 1000 },
        { day: "2026-11-10", accountId: "1", campaignId: "222", campaignName: "Boots test", spend: 300 },
      ],
    })
    const delivered = await order("Website", "111", "delivered_paid", { consignmentId: "C1", courierCost: 105, courierCollected: 1990 })
    await order("Website", "111", "cancelled")
    const returned = await order("Website", "111", "returned", { consignmentId: "C2", courierCost: 130, courierCollected: 0 })
    await order("WhatsApp", "111", "delivered_paid", { consignmentId: "C3", courierCost: 105 })

    const from = Date.parse("2026-11-01T00:00:00+06:00"), to = Date.parse("2026-11-30T23:59:59+06:00")
    const r = await as.action(api.profit.report, { from, to })
    // Meta: 1000 split over the 3 website orders of campaign 111; campaign 222 (300) traced to no order,
    // so it is shared by the day's untraced order (the WhatsApp one). Nothing is left over.
    expect(r.meta.total).toBe(1300)
    expect(r.meta.onOrders).toBeCloseTo(1300, 5)
    expect(r.meta.unlinked).toBeCloseTo(0, 5)
    const d = r.orders.find((o: any) => o.id === delivered)
    expect(d.meta).toBeCloseTo(333.33, 1)
    // delivered: 1990 paid − 700 product − 105 Pathao − 50 packaging − 333.33 Meta
    expect(d.profit).toBeCloseTo(1990 - 700 - 105 - 50 - 333.33, 1)
    const ret = r.orders.find((o: any) => o.id === returned)
    expect(ret.profit).toBeCloseTo(-130 - 50 - 333.33, 1) // pair comes back to stock; courier, box and ads are lost
    expect(r.orders.find((o: any) => o.source === "WhatsApp").meta).toBeCloseTo(300, 5)
    expect(r.outcomes.cancelled.meta).toBeCloseTo(333.33, 1)
    expect(r.outcomes.cancelled.profit).toBeCloseTo(-333.33, 1)
    // net = finished orders − spend with no order − fixed costs (300,000 for 30 days of November)
    expect(r.fixed.period).toBe(300000)
    expect(r.totals.netProfit).toBeCloseTo(r.totals.finishedProfit - 300000, 1)
    expect(r.products[0].name).toBe("Veyron Loafer")

    // a day with ads but no orders keeps its spend as "no order"
    await t.mutation(internal.profit.saveSpend, { days: ["2026-11-11"], info: {}, rows: [{ day: "2026-11-11", accountId: "1", campaignId: "111", campaignName: "Veyron sale", spend: 200 }] })
    await t.mutation(internal.dashboard.writeCache, { key: `profit:${from}:${to}`, value: null })
    const r2 = await as.action(api.profit.report, { from, to })
    expect(r2.meta.total).toBe(1500)
    expect(r2.meta.unlinked).toBeCloseTo(200, 5)
    expect(r2.meta.onOrders + r2.meta.unlinked).toBeCloseTo(1500, 5)
  })
})
