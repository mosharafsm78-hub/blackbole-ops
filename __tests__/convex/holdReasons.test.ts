import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { HOLD_NO_REASON, holdBucket, HOLD_CHIPS } from "../../convex/rules"

const makeT = () => convexTest(schema, import.meta.glob("../../convex/**/*.*s"))

describe("hold reasons", () => {
  it("buckets a reason into a chip", () => {
    expect(holdBucket("Call Not Answered")).toBe("Call Not Answered")
    expect(holdBucket("call not answered")).toBe("Call Not Answered")
    expect(holdBucket("whatsapp e kncok dite hohbe")).toBe("Other")
    expect(holdBucket(undefined)).toBe(HOLD_NO_REASON)
    expect(HOLD_CHIPS()).toContain("Hold: Awaiting Advance Payment")
    expect(HOLD_CHIPS().filter((c) => c === "Other")).toHaveLength(1)
  })

  it("counts held orders per reason and filters the list by it", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Sandal", active: true, variants: [{ sku: "BB-H-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-H-42")).unique()))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: variant._id, qty: 9, unitCost: 520 }] })
    const ids: any[] = []
    for (let i = 0; i < 3; i++) {
      const { orderId } = await as.mutation(api.orders.create, {
        source: "Facebook", customerName: `C${i}`, phone: `+88017110000${i}0`, address: "House 7, Dhanmondi", locationId, deliveryType: "pickup",
        items: [{ variantId: variant._id, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
      })
      ids.push(orderId)
    }
    await as.mutation(api.orders.changeStatus, { ids: [ids[0]], to: "on_hold", reason: "Call Not Answered" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[1]], to: "on_hold", reason: "Call Not Answered" })
    await as.mutation(api.orders.changeStatus, { ids: [ids[2]], to: "on_hold", reason: "Out of Stock" })
    const r = (await as.query(api.orders.holdReasonCounts, {}))!
    expect(r.total).toBe(3)
    expect(r.counts["Call Not Answered"]).toBe(2)
    expect(r.counts["Out of Stock"]).toBe(1)
    expect(r.counts["Invalid Phone Number"]).toBe(0)
    const l = (await as.query(api.orders.list, { tab: "on_hold", holdReason: "Call Not Answered", limit: 50 }))!
    expect(l.rows).toHaveLength(2)
    const all = (await as.query(api.orders.list, { tab: "on_hold", limit: 50 }))!
    expect(all.rows).toHaveLength(3)
  })
})
