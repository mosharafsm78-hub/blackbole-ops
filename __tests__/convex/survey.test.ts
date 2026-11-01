import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { discountFor, ratingRows } from "../../convex/survey"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, { name: "Harbor Shore Sandal - Black", active: true, variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "8801700000000" })
  const delivered = async (phone: string, daysAgo: number) => {
    const r = await as.mutation(api.orders.create, { source: "Website", customerName: "Rahim Uddin", phone, address: "House 12, Road 5, Lalmatia, Dhaka", locationId, deliveryType: "regular", items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 60, advanceAmount: 0, advanceMethod: "bKash", approve: false })
    await t.run((ctx) => ctx.db.patch(r.orderId, { status: "delivered_due", deliveredAt: Date.now() - daysAgo * 86400000 }))
    return r.orderId
  }
  return { t, as, delivered }
}

describe("rating survey", () => {
  it("discount amounts follow the rating", () => {
    expect([1, 5].map(discountFor)).toEqual([100, 100])
    expect([6, 8].map(discountFor)).toEqual([200, 200])
    expect([9, 10].map(discountFor)).toEqual([300, 300])
    expect(ratingRows("abc")).toHaveLength(10)
    expect(ratingRows("abc").every((r) => r.title.length <= 24)).toBe(true)
  })

  it("asks only delivered orders, once per order and once per phone; off by default", async () => {
    const { t, as, delivered } = await setup()
    const a = await delivered("01711000031", 3)
    expect(await t.query(internal.survey.dueAuto, {})).toEqual([]) // off
    await as.mutation(api.survey.saveConfig, { enabled: true })
    expect(await t.query(internal.survey.dueAuto, {})).toEqual([]) // delivered before the switch
    const b = await delivered("01711000032", 0)
    await t.run((ctx) => ctx.db.patch(b, { deliveredAt: Date.now() + 1000 })) // after the switch…
    expect(await t.mutation(internal.survey.claim, { orderId: a, batch: "past90" })).not.toBeNull()
    expect(await t.mutation(internal.survey.claim, { orderId: a, batch: "past90" })).toBeNull() // same order
    const a2 = await delivered("01711000031", 4)
    expect(await t.mutation(internal.survey.claim, { orderId: a2, batch: "past90" })).toBeNull() // same phone within 60 days
    const pend = await delivered("01711000033", 3)
    await t.run((ctx) => ctx.db.patch(pend, { status: "pending" }))
    expect(await t.mutation(internal.survey.claim, { orderId: pend, batch: "past90" })).toBeNull() // not delivered
  })

  it("Rate now → 1–10 list → rating saved once, code made, low rating alerts the team", async () => {
    vi.useFakeTimers()
    const { t, as, delivered } = await setup()
    await as.mutation(api.survey.saveConfig, { enabled: true })
    const o = await delivered("01711000034", 3)
    await t.action(internal.survey.send, { orderId: o, batch: "auto" }) // test mode: recorded, nothing sent
    const s = (await t.run((ctx) => ctx.db.query("surveys").collect()))[0]
    expect(s.result).toBe("test")
    const asked = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000034", wamid: "q1", buttonId: `wv:q:${s._id}` })
    expect(asked.result).toBe("survey_asked")
    expect((asked.out[0] as any).rows).toHaveLength(10)
    const stranger = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801999999999", wamid: "q2", buttonId: `wv:v:${s._id}:9` })
    expect(stranger.result).toBe("survey_unknown") // a different number cannot rate
    const rated = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000034", wamid: "q3", buttonId: `wv:v:${s._id}:4` })
    expect(rated.result).toBe("survey_rated")
    const again = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000034", wamid: "q4", buttonId: `wv:v:${s._id}:10` })
    expect(again.result).toBe("survey_done")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    const after = (await t.run((ctx) => ctx.db.get(s._id))) as any
    expect(after).toMatchObject({ result: "rated", rating: 4, discount: 100 })
    expect(after.code).toMatch(/^TEST-100-/)
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect())
    expect(notes.some((n: any) => /Low rating: 4\/10/.test(n.title))).toBe(true)
    const sum = await as.query(api.survey.summary, { days: 30 })
    expect(sum).toMatchObject({ rated: 1, avg: 4, asked: 1 })
    expect(sum.low).toHaveLength(1)
  })
})
