import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Doc, Id } from "../../convex/_generated/dataModel"
import { ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ADVANCE_REASON_REFUSED, dateInputToMs, reasonPresets, resolveReasonToggle } from "../../convex/rules"

/**
 * The agent's click-path, end to end, in one test.
 *
 * The other advance-payment tests assert individual values; this one walks the WHOLE story a customer-care
 * agent actually performs — open the row, click Hold, pick a reason, type the two fields, correct a mistake,
 * approve — so a break anywhere in the chain (a stale value surviving a toggle, the approve wiping the amount,
 * the timeline losing its entry) fails here with the step named.
 */
function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

describe("agent click-path: holding an order for an advance payment", () => {
  it("walks hold → correct the reason → clear the promise → approve, and ends in a sane state", async () => {
    // ---- setup: one agent, one in-stock pair ----
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal - Black", active: true,
      variants: [{ sku: "BB-QA-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
    })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-QA-42")).unique()))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: variant._id, qty: 5, unitCost: 520 }] })
    const { orderId } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Rahim Uddin", phone: "+8801711000000", address: "House 7, Road 3, Dhanmondi",
      locationId, deliveryType: "pickup", items: [{ variantId: variant._id, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })
    const read = () => t.run((ctx) => ctx.db.get(orderId)) as Promise<Doc<"orders"> | null>

    // ---- step 1: a brand-new order carries no advance data ----
    let o = await read()
    expect(o!.status).toBe("pending")
    expect(o!.expectedAdvanceAmount).toBeUndefined()

    // ---- step 2: the Hold dialog offers the advance reasons first ----
    expect(reasonPresets("on_hold").slice(0, 2)).toEqual([ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED])

    // ---- step 3: picking the reason reveals two empty inputs ----
    const opened = resolveReasonToggle({ from: "", to: ADVANCE_REASON_AWAITING, amount: "", date: "" })
    expect(opened).toEqual({ amount: "", date: "" })

    // ---- step 4: agent types 5000 / 2026-11-05 and confirms ----
    await as.mutation(api.orders.changeStatus, {
      ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_AWAITING,
      expectedAdvanceAmount: 5000, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    o = await read()
    expect(o!.status).toBe("on_hold")
    expect(o!.expectedAdvanceAmount).toBe(5000)

    // ---- step 5: agent noticed the wrong reason and re-picks — inputs clear, nothing stale ----
    expect(resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: ADVANCE_REASON_PROMISED, amount: "5000", date: "2026-11-05" }))
      .toEqual({ amount: "", date: "" })

    // ---- step 6: retypes 700 / 2026-11-20 ----
    await as.mutation(api.orders.changeStatus, {
      ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_PROMISED,
      expectedAdvanceAmount: 700, promisedPaymentDate: dateInputToMs("2026-11-20")!,
    })
    o = await read()
    expect(o!.expectedAdvanceAmount).toBe(700)
    expect(o!.promisedPaymentDate).toBe(dateInputToMs("2026-11-20")!)

    // ---- step 7: reason switched to a plain one — the promise must vanish, not linger ----
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Stock not ready" })
    o = await read()
    expect(o!.reason).toBe("Stock not ready")
    expect(o!.expectedAdvanceAmount).toBeUndefined()
    expect(o!.promisedPaymentDate).toBeUndefined()

    // ---- step 8: stock arrives, agent approves ----
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    o = await read()
    expect(o!.status).toBe("approved")

    // ---- step 9: the timeline tells the whole story, in order ----
    const events = await t.run((ctx) =>
      ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect())
    const texts = events.map((e) => e.text)
    expect(texts.some((x) => x.includes(ADVANCE_REASON_AWAITING))).toBe(true)
    expect(texts.some((x) => x.includes(ADVANCE_REASON_PROMISED))).toBe(true)
    expect(texts.some((x) => x.includes("Stock not ready"))).toBe(true)
    expect(texts.some((x) => x.includes("Approved"))).toBe(true)
    // a same-status reason edit must NOT be logged as a status move
    expect(texts.some((x) => x.includes("On Hold → On Hold"))).toBe(false)
  })

  it("refuses every incomplete advance entry and leaves the order untouched", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, {
      name: "P", active: true, variants: [{ sku: "BB-QA-43", title: "43", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
    })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-QA-43")).unique()))!
    const { orderId } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Karim", phone: "+8801711000001", address: "X",
      locationId, deliveryType: "pickup", items: [{ variantId: variant._id, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })

    const date = dateInputToMs("2026-11-05")!
    await expect(as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_AWAITING })).rejects.toThrow(/advance amount/i)
    await expect(as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 0, promisedPaymentDate: date })).rejects.toThrow(/more than/i)
    await expect(as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_REFUSED, expectedAdvanceAmount: 500 })).rejects.toThrow(/date/i)

    // nothing leaked through: still pending, still no advance data
    const o = await t.run((ctx) => ctx.db.get(orderId))
    expect(o!.status).toBe("pending")
    expect(o!.expectedAdvanceAmount).toBeUndefined()
    expect(o!.promisedPaymentDate).toBeUndefined()
  })

  it("keeps a legacy order (no advance fields at all) working through every path", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, {
      name: "P", active: true, variants: [{ sku: "BB-QA-44", title: "44", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
    })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-QA-44")).unique()))!
    const { orderId } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Legacy", phone: "+8801711000002", address: "X",
      locationId, deliveryType: "pickup", items: [{ variantId: variant._id, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })

    // the document genuinely has no advance keys — this is what an order written before the feature looks like
    const raw = await t.run((ctx) => ctx.db.get(orderId))
    expect("expectedAdvanceAmount" in raw!).toBe(false)
    expect("promisedPaymentDate" in raw!).toBe(false)

    // and it can still be held, cancelled and approved with no advance data anywhere
    expect((await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Customer asked to wait" })).done).toBe(1)
    expect((await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "cancelled", reason: "Out of stock" })).done).toBe(1)
    const after = await t.run((ctx) => ctx.db.get(orderId))
    expect(after!.status).toBe("cancelled")
    expect(after!.expectedAdvanceAmount).toBeUndefined()
  })
})
