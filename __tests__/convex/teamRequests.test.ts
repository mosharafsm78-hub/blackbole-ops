import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Ijaab" })
  const me = (await t.run((ctx) => ctx.db.query("staff").first()))!
  // a second team member with their own login
  const u2 = await t.run((ctx) => ctx.db.insert("users", { email: "rafi@blackbole.com" }))
  const staff2 = await t.run((ctx) => ctx.db.insert("staff", { email: "rafi@blackbole.com", name: "Rafi", roleId: me.roleId, userId: u2, active: true, createdAt: Date.now() }))
  const as2 = t.withIdentity({ subject: `${u2}|s2` })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, { name: "Loafer", active: true, variants: [{ sku: "L-41", title: "41", weightKg: 0.4, price: 1980, purchasePrice: 500, active: true }] })
  const v = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "L-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v._id, qty: 5, unitCost: 500 }] })
  const r = await as.mutation(api.orders.create, { source: "Website", customerName: "Rahim", phone: "01711000011", address: "House 12, Road 5, Lalmatia, Dhaka", locationId, deliveryType: "regular", items: [{ variantId: v._id, qty: 1, price: 1980, discount: 0 }], discount: 0, deliveryFee: 60, advanceAmount: 0, advanceMethod: "bKash", approve: false })
  return { t, as, as2, me, staff2, orderId: r.orderId }
}

describe("team requests", () => {
  it("asker → answerer → asker flow with badges and order timeline", async () => {
    const { as, as2, staff2, orderId } = await setup()
    const id = await as.mutation(api.teamRequests.create, { kind: "live_picture", toStaffId: staff2, message: "Customer wants a real photo, Loafer 41", orderId })
    expect((await as2.query(api.teamRequests.myCounts, {})).toAnswer).toBe(1)
    expect((await as2.query(api.teamRequests.list, { scope: "toMe" }))[0].fromName).toBe("Ijaab")
    await as2.mutation(api.teamRequests.reply, { id, text: "Photo sent on WhatsApp" })
    expect((await as2.query(api.teamRequests.myCounts, {})).total).toBe(0)
    expect((await as.query(api.teamRequests.myCounts, {})).answersIn).toBe(1)
    await as.mutation(api.teamRequests.close, { id })
    const [r] = await as.query(api.teamRequests.forOrder, { orderId })
    expect(r.status).toBe("done")
    expect(r.replies[0].byName).toBe("Rafi")
  })
  it("blocks a second open exchange on the same order, allows it once the first is closed; not to yourself", async () => {
    const { as, staff2, me, orderId } = await setup()
    const id = await as.mutation(api.teamRequests.create, { kind: "exchange", toStaffId: staff2, message: "Exchange to 42", orderId })
    await expect(as.mutation(api.teamRequests.create, { kind: "exchange", toStaffId: staff2, message: "Exchange again", orderId })).rejects.toThrow(/already open/)
    await expect(as.mutation(api.teamRequests.create, { kind: "question", toStaffId: me._id, message: "x" })).rejects.toThrow(/someone else/)
    await as.mutation(api.teamRequests.close, { id })
    await as.mutation(api.teamRequests.create, { kind: "exchange", toStaffId: staff2, message: "Exchange to 43", orderId })
  })
})
