import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

describe("parcel group", () => {
  it("lists DB/EB/RE parcels and links the exchange order", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    await t.run(async (ctx) => {
      await ctx.db.insert("settings", { key: "pathao", value: { env: "production", clientId: "a", clientSecret: "b", username: "c", password: "d" } })
      await ctx.db.insert("settings", { key: "pathaoToken", value: { accessToken: "x", expiresAt: Date.now() + 1e9 } })
    })
    const ids = await t.run(async (ctx) => {
      const loc = (await ctx.db.query("locations").first())!._id
      const cust = await ctx.db.insert("customers", { code: 1, name: "A", phone: "01720270475", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 0 })
      const base: any = { status: "delivered_paid", source: "Website", customerId: cust, customerName: "A", phone: "01720270475", address: "x", locationId: loc, deliveryType: "regular", courier: "pathao", items: [], subtotal: 0, discount: 0, deliveryFee: 0, total: 0, paidAmount: 0, due: 0, callCount: 0, createdByName: "x", statusChangedAt: 1, createdAt: 1, updatedAt: 1 }
      const a = await ctx.db.insert("orders", { ...base, invoiceNo: 11456, consignmentId: "DB121026HE7HZN" })
      const b = await ctx.db.insert("orders", { ...base, invoiceNo: 11650, status: "in_transit", createdAt: 2, isExchange: true, consignmentId: "DB2610266BYSZ7" })
      return { a, b }
    })
    const lists: Record<string, any[]> = {
      "BB-11456": [
        { order_consignment_id: "DB121026HE7HZN", merchant_order_id: "BB-11456", order_status: "Delivered", order_amount: 2830 },
        { order_consignment_id: "EB121026HE7HZN", merchant_order_id: "BB-11456", order_status: "Exchange", order_amount: 0 },
        { order_consignment_id: "RE121026HE7HZN", merchant_order_id: "BB-11456", order_status: "In Transit", order_amount: 0 },
      ],
      "BB-11650": [{ order_consignment_id: "DB2610266BYSZ7", merchant_order_id: "BB-11650", order_status: "Pickup Cancel", order_amount: 0 }],
    }
    vi.stubGlobal("fetch", async (url: string) => {
      const m = /merchant_order_id=([^&]+)/.exec(url)
      const arch = /archive=1/.test(url)
      const data = m && !arch ? lists[decodeURIComponent(m[1])] ?? [] : []
      return new Response(JSON.stringify({ data: { data } }), { status: 200 })
    })
    const r1 = await as.action(api.pathao.parcelGroup, { orderId: ids.b })
    expect(r1.candidates.map((c) => c.label)).toEqual(["BB-11456"])
    await as.mutation(api.pathao.setExchangeOf, { id: ids.b, originalId: ids.a })
    const r2 = await as.action(api.pathao.parcelGroup, { orderId: ids.b })
    expect(r2.linked).toBe(true)
    const b = await t.run((ctx) => ctx.db.get(ids.b))
    expect(b!.consignmentId).toBe("EB121026HE7HZN")
    expect(b!.returnConsignmentId).toBe("RE121026HE7HZN")
    expect(r2.parcels.map((p) => p.cid).sort()).toEqual(["DB121026HE7HZN", "DB2610266BYSZ7", "EB121026HE7HZN", "RE121026HE7HZN"])
  })
})
