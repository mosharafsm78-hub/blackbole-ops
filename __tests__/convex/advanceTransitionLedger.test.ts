import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Doc, Id } from "../../convex/_generated/dataModel"
import {
  ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED,
  ADVANCE_CANCEL_CODES, advanceReasonCode, isAdvanceCancelReason, reasonPresets, resolveReasonToggle,
  dateInputToMs,
} from "../../convex/rules"

/**
 * Task 4 scope expansion: the same advance-payment vocabulary, driven through the status transition dialogs.
 *
 * The Task 4 tests already prove the Hold/Cancel dialog logic. This file exists because the requirement changed
 * shape: the reasons are now reachable from ANY transition modal, both cancel chips must tag the order with
 * `cancelReason: "refused_advance"`, and the ledger has to record the money no matter which door the agent
 * came through. Each test below names the failure it prevents.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup(sku = "BB-LED-41") {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: `P ${sku}`, active: true,
    variants: [{ sku, title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: variant._id, qty: 10, unitCost: 520 }] })
  return { t, as, locationId, variant }
}

async function placeOrder(as: Awaited<ReturnType<typeof setup>>["as"], locationId: Id<"locations">, variantId: Id<"variants">) {
  const { orderId } = await as.mutation(api.orders.create, {
    source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
    locationId, deliveryType: "pickup", items: [{ variantId, qty: 1, price: 1480, discount: 0 }],
    discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
  })
  return orderId as Id<"orders">
}

// ---------------------------------------------------------------------------
// the new cancel chip is in the vocabulary, and both chips share one code
// ---------------------------------------------------------------------------
describe("cancel reason chips for advance failures", () => {
  it("offers both advance cancel chips on a cancel, ahead of the generic reasons", () => {
    const cancel = reasonPresets("cancelled")
    expect(cancel).toContain(ADVANCE_REASON_REFUSED)
    expect(cancel).toContain(ADVANCE_REASON_FAILED)
    // first, so an agent reaching for "Other" sees the right tool before the catch-alls
    expect(cancel.slice(0, 2)).toEqual([ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED])
    expect(cancel).toContain("Customer cancelled")
  })

  it("never offers a failed-advance chip on a hold — a failed advance is a death, not a wait", () => {
    expect(reasonPresets("on_hold")).not.toContain(ADVANCE_REASON_FAILED)
    expect(reasonPresets("on_hold")).toContain(ADVANCE_REASON_AWAITING)
  })

  it("maps BOTH cancel chips to the same refused_advance code, per the brief", () => {
    expect(advanceReasonCode(ADVANCE_REASON_REFUSED)).toBe("refused_advance")
    expect(advanceReasonCode(ADVANCE_REASON_FAILED)).toBe("refused_advance")
    expect(ADVANCE_CANCEL_CODES[ADVANCE_REASON_REFUSED]).toBe("refused_advance")
    expect(ADVANCE_CANCEL_CODES[ADVANCE_REASON_FAILED]).toBe("refused_advance")
  })

  it("leaves hold reasons without a cancel code — a hold is not a cancellation", () => {
    expect(advanceReasonCode(ADVANCE_REASON_AWAITING)).toBeUndefined()
    expect(advanceReasonCode(ADVANCE_REASON_PROMISED)).toBeUndefined()
    expect(isAdvanceCancelReason(ADVANCE_REASON_AWAITING)).toBe(false)
    expect(isAdvanceCancelReason("Out of stock")).toBe(false)
    expect(isAdvanceCancelReason(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 1. cancelReason is written on a cancel — from either chip
// ---------------------------------------------------------------------------
describe("cancelReason is written on an advance-driven cancel", () => {
  it('writes cancelReason: "refused_advance" when cancelling for a refused advance', async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-41")
    const id = await placeOrder(as, locationId, variant._id)

    const res = await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_REFUSED,
      expectedAdvanceAmount: 500, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    expect(res.errors).toEqual([])
    expect(res.done).toBe(1)

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.status).toBe("cancelled")
    expect(o.cancelReason).toBe("refused_advance") // the machine-readable tag the brief asks for
    expect(o.reason).toBe(ADVANCE_REASON_REFUSED) // and the human wording is kept separately
  })

  it('writes the SAME code for a failed/expired advance, with the precise reason preserved', async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-42")
    const id = await placeOrder(as, locationId, variant._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_FAILED,
      expectedAdvanceAmount: 800, promisedPaymentDate: dateInputToMs("2026-11-01")!,
    })

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.cancelReason).toBe("refused_advance")
    expect(o.reason).toBe(ADVANCE_REASON_FAILED) // nuance survives for a human reading the order
  })

  it("clears a stale cancelReason when the cancel reason is corrected to something ordinary", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-43")
    const id = await placeOrder(as, locationId, variant._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_REFUSED,
      expectedAdvanceAmount: 500, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    expect(((await t.run((ctx) => ctx.db.get(id))) as Doc<"orders">).cancelReason).toBe("refused_advance")

    // same status, corrected reason: the code must not survive
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "cancelled", reason: "Duplicate order" })
    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.reason).toBe("Duplicate order")
    expect(o.cancelReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. amount + date persisted on a hold, and carried in the ledger text
// ---------------------------------------------------------------------------
describe("advance amount and date are persisted on a hold", () => {
  it("stores both fields and puts the money in the order timeline", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-44")
    const id = await placeOrder(as, locationId, variant._id)
    const date = dateInputToMs("2026-11-20")!

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING,
      expectedAdvanceAmount: 700, promisedPaymentDate: date,
    })

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.status).toBe("on_hold")
    expect(o.expectedAdvanceAmount).toBe(700)
    expect(o.promisedPaymentDate).toBe(date)
    expect(o.cancelReason).toBeUndefined() // a hold is not a cancellation

    // the timeline is the only place a dispute gets reconstructed later, so the amount belongs in the text
    const events = await t.run((ctx) => ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", id)).collect())
    const line = events.find((e) => e.text.includes(ADVANCE_REASON_AWAITING))
    expect(line).toBeTruthy()
    expect(line!.text).toContain("৳700")
    expect(line!.text).toContain("2026-11-20")
  })

  it("records the promise on the Cancel path too, not only on Hold", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-45")
    const id = await placeOrder(as, locationId, variant._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_REFUSED,
      expectedAdvanceAmount: 300, promisedPaymentDate: dateInputToMs("2026-11-06")!,
    })

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.expectedAdvanceAmount).toBe(300)
    const events = await t.run((ctx) => ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", id)).collect())
    expect(events.some((e) => e.text.includes("৳300"))).toBe(true)
  })

  it("refuses an advance reason with no amount, leaving nothing half-written", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-46")
    const id = await placeOrder(as, locationId, variant._id)

    await expect(
      as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING }),
    ).rejects.toThrow(/advance amount/i)

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.status).toBe("pending")
    expect(o.expectedAdvanceAmount).toBeUndefined()
    expect(o.cancelReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. switching chips clears stale values
// ---------------------------------------------------------------------------
describe("switching chips never leaks a stale amount or date", () => {
  it("clears both inputs when moving between advance chips", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: ADVANCE_REASON_FAILED, amount: "5000", date: "2026-11-05" })
    expect(next).toEqual({ amount: "", date: "" })
  })

  it("clears both when an advance chip is replaced by a generic one", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_REFUSED, to: "Customer cancelled", amount: "5000", date: "2026-11-05" })
    expect(next).toEqual({ amount: "", date: "" })
  })

  it("keeps what was typed when the SAME chip is re-picked (a typo fix must not lose the date)", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_FAILED, to: ADVANCE_REASON_FAILED, amount: "5000", date: "2026-11-05" })
    expect(next).toEqual({ amount: "5000", date: "2026-11-05" })
  })

  it("wipes the stored figure when an order is re-cancelled for an ordinary reason", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-47")
    const id = await placeOrder(as, locationId, variant._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_REFUSED,
      expectedAdvanceAmount: 5000, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "cancelled", reason: "Out of stock" })

    const o = await t.run((ctx) => ctx.db.get(id)) as Doc<"orders">
    expect(o.expectedAdvanceAmount).toBeUndefined()
    expect(o.promisedPaymentDate).toBeUndefined()
    expect(o.cancelReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. a legacy order with no advance fields still transitions fine
// ---------------------------------------------------------------------------
describe("legacy orders without any advance fields", () => {
  it("has neither key on the document, yet still cancels and holds cleanly", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-48")
    const id = await placeOrder(as, locationId, variant._id)

    const raw = (await t.run((ctx) => ctx.db.get(id))) as Doc<"orders">
    expect("expectedAdvanceAmount" in raw).toBe(false)
    expect("promisedPaymentDate" in raw).toBe(false)
    expect("cancelReason" in raw).toBe(false) // the new field is genuinely absent, not undefined

    expect((await as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: "Stock not ready" })).done).toBe(1)
    expect((await as.mutation(api.orders.changeStatus, { ids: [id], to: "cancelled", reason: "Out of stock" })).done).toBe(1)

    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<"orders">
    expect(after.status).toBe("cancelled")
    expect(after.expectedAdvanceAmount).toBeUndefined()
    expect(after.cancelReason).toBeUndefined()
  })

  it("can also take an advance reason later — the fields are simply added on top", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-49")
    const id = await placeOrder(as, locationId, variant._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_FAILED,
      expectedAdvanceAmount: 450, promisedPaymentDate: dateInputToMs("2026-11-09")!,
    })

    const o = (await t.run((ctx) => ctx.db.get(id))) as Doc<"orders">
    expect(o.expectedAdvanceAmount).toBe(450)
    expect(o.cancelReason).toBe("refused_advance")
  })
})

// ---------------------------------------------------------------------------
// the second door: the post-hoc "Edit reason" dialog must write the same ledger
// ---------------------------------------------------------------------------
describe("the post-hoc reason dialog records the advance too", () => {
  it("persists amount, date and code when a Super Admin records an advance cancel after the fact", async () => {
    const { t, as, locationId, variant } = await setup("BB-LED-50")
    const id = await placeOrder(as, locationId, variant._id)
    // get the order into a cancelled state without an advance reason, the realistic in-between state
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "cancelled", reason: "Other" })

    await as.mutation(api.orders.setReason, {
      id, reason: ADVANCE_REASON_REFUSED, note: "Customer said no to the advance.",
      expectedAdvanceAmount: 600, promisedPaymentDate: dateInputToMs("2026-11-12")!,
    })

    const o = (await t.run((ctx) => ctx.db.get(id))) as Doc<"orders">
    expect(o.reason).toBe(ADVANCE_REASON_REFUSED)
    expect(o.expectedAdvanceAmount).toBe(600)
    expect(o.cancelReason).toBe("refused_advance")
  })

  it("still rejects an advance reason with no amount through that door", async () => {
    const { as, locationId, variant } = await setup("BB-LED-51")
    const id = await placeOrder(as, locationId, variant._id)
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "cancelled", reason: "Other" })

    await expect(
      as.mutation(api.orders.setReason, { id, reason: ADVANCE_REASON_AWAITING, note: "Promised to pay." }),
    ).rejects.toThrow(/advance amount/i)
  })
})
