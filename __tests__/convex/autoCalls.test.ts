import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { outOfQuiet } from "../../convex/autoCalls"

async function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-28T06:00:00Z")) // 12:00 noon in Dhaka
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, { name: "Harbor Shore Sandal - Black", active: true, variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  await as.mutation(api.autoCalls.saveSettings, { enabled: true, mode: "test", serverUrl: "", sources: [], delayMin: 0, retries: 1, retryGapMin: 30, quietFrom: 23, quietTo: 8, maxTotal: 0, pressTwo: "flag" })
  const order = (phone: string) => as.mutation(api.orders.create, {
    source: "Facebook", customerName: "Test", phone, address: "House 1, Road 2, Lalmatia", locationId, deliveryType: "pickup",
    items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
  })
  return { t, as, order }
}

const callOf = (t: any, orderId: any) => t.run((ctx: any) => ctx.db.query("autoCalls").withIndex("by_order", (q: any) => q.eq("orderId", orderId)).first())

describe("auto confirmation calls", () => {
  it("keeps calls out of quiet hours", () => {
    const night = Date.parse("2026-10-28T18:30:00Z") // 00:30 Dhaka
    expect(new Date(outOfQuiet(night, 23, 8) + 6 * 3600000).getUTCHours()).toBe(8)
    const noon = Date.parse("2026-10-28T06:00:00Z")
    expect(outOfQuiet(noon, 23, 8)).toBe(noon)
  })

  it("press 1 approves, press 2 flags, no answer retries then hands over", async () => {
    const { t, as, order } = await setup()
    const r1 = await order("01711000001")
    const r2 = await order("01711000002")
    const r3 = await order("01711000003")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const r of [r1, r2, r3]) expect((await callOf(t, r.orderId))?.status).toBe("queued")
    await t.mutation(internal.autoCalls.due, {}) // starts all three (test mode: no real call)
    const c1 = await callOf(t, r1.orderId), c2 = await callOf(t, r2.orderId), c3 = await callOf(t, r3.orderId)
    expect(c1.status).toBe("calling")

    await as.mutation(api.autoCalls.simulate, { id: c1._id, result: "answered", digit: "1" })
    expect(((await t.run((ctx) => ctx.db.get(r1.orderId))) as any).status).toBe("approved")

    await as.mutation(api.autoCalls.simulate, { id: c2._id, result: "answered", digit: "2" })
    const o2 = (await t.run((ctx) => ctx.db.get(r2.orderId))) as any
    expect(o2.status).toBe("pending")
    expect(o2.autoCall.result).toBe("cancel")

    await as.mutation(api.autoCalls.simulate, { id: c3._id, result: "no_answer" })
    expect((await callOf(t, r3.orderId)).status).toBe("queued") // retry later
    await t.run((ctx) => ctx.db.patch(c3._id, { nextAt: Date.now() - 1 }))
    await t.mutation(internal.autoCalls.due, {})
    await as.mutation(api.autoCalls.simulate, { id: c3._id, result: "no_answer" })
    const done = await callOf(t, r3.orderId)
    expect(done.status).toBe("done")
    expect(done.result).toBe("no_answer")
    vi.useRealTimers()
  })
})
