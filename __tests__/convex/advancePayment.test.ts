import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ADVANCE_REASON_REFUSED, ADVANCE_REASONS,
  buildAdvanceFields, dateInputToMs, isAdvanceReason, msToDateInput, parseTakaInput,
} from "../../convex/rules"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** A user + one in-stock variant, same shape the real order tests use. */
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  const locations = await as.query(api.team.listLocations, {})
  const locationId = locations.find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v41 = (await t.run((ctx) =>
    ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  return { t, as, userId, locationId, v41 }
}

const baseOrder = (locationId: Id<"locations">, variantId: Id<"variants">) => ({
  source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
  locationId, deliveryType: "pickup", items: [{ variantId, qty: 1, price: 1480, discount: 0 }],
  discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
})

/** Places one order and returns its id. */
async function placeOrder(as: Awaited<ReturnType<typeof setup>>["as"], locationId: Id<"locations">, variantId: Id<"variants">) {
  const { orderId } = await as.mutation(api.orders.create, baseOrder(locationId, variantId))
  return orderId as Id<"orders">
}

const read = (t: ReturnType<typeof makeT>, id: Id<"orders">) => t.run((ctx) => ctx.db.get(id))

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
describe("advance reason vocabulary", () => {
  it("has exactly the four reasons the briefs specify (3 from Task 4 + the failed/expired chip)", () => {
    expect(ADVANCE_REASONS).toEqual([
      "Hold: Awaiting Advance Payment",
      "Hold: Customer Promised Advance",
      "Canceled: Refused Advance Payment",
      "Canceled: Advance Payment Failed/Expired",
    ])
  })

  it("recognises the three advance reasons and nothing else", () => {
    expect(isAdvanceReason(ADVANCE_REASON_AWAITING)).toBe(true)
    expect(isAdvanceReason(ADVANCE_REASON_PROMISED)).toBe(true)
    expect(isAdvanceReason(ADVANCE_REASON_REFUSED)).toBe(true)
    // ordinary hold/cancel reasons must NOT reveal the extra inputs
    expect(isAdvanceReason("Customer asked to wait")).toBe(false)
    expect(isAdvanceReason("Advance payment pending")).toBe(false) // the old vague chip
    expect(isAdvanceReason("Out of stock")).toBe(false)
    expect(isAdvanceReason(undefined)).toBe(false)
    expect(isAdvanceReason(null)).toBe(false)
    expect(isAdvanceReason("")).toBe(false)
  })
})

describe("parseTakaInput", () => {
  it("accepts the shapes an agent actually types", () => {
    expect(parseTakaInput("500")).toBe(500)
    expect(parseTakaInput(" 500 ")).toBe(500)
    expect(parseTakaInput("5,000")).toBe(5000)
    expect(parseTakaInput("৳5000")).toBe(5000)
    expect(parseTakaInput(750)).toBe(750)
    expect(parseTakaInput("0")).toBe(0)
  })

  it("rejects junk instead of silently storing NaN", () => {
    expect(parseTakaInput("")).toBeNull()
    expect(parseTakaInput("   ")).toBeNull()
    expect(parseTakaInput("abc")).toBeNull()
    expect(parseTakaInput(".")).toBeNull()
    expect(parseTakaInput(null)).toBeNull()
    expect(parseTakaInput(undefined)).toBeNull()
  })
})

describe("date helpers", () => {
  it("round-trips a date through the input format", () => {
    const ms = dateInputToMs("2026-11-05")!
    expect(ms).toBeTypeOf("number")
    expect(msToDateInput(ms)).toBe("2026-11-05")
  })

  it("rejects impossible dates rather than rolling them into the next month", () => {
    expect(dateInputToMs("2026-02-31")).toBeNull()
    expect(dateInputToMs("2026-13-01")).toBeNull()
    expect(dateInputToMs("not-a-date")).toBeNull()
    expect(dateInputToMs("")).toBeNull()
    expect(dateInputToMs(null)).toBeNull()
  })

  it("returns an empty string for an unset value", () => {
    expect(msToDateInput(undefined)).toBe("")
    expect(msToDateInput(null)).toBe("")
  })
})

describe("buildAdvanceFields", () => {
  it("returns an empty block for an ordinary reason, ignoring any stray amount", () => {
    const res = buildAdvanceFields({ reason: "Out of stock", expectedAdvanceAmount: 500, promisedPaymentDate: 1 })
    expect(res).toEqual({ ok: true, fields: {} })
  })

  it("demands both fields when an advance reason is picked", () => {
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_AWAITING })).toMatchObject({ ok: false })
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 500 })).toMatchObject({ ok: false })
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_AWAITING, promisedPaymentDate: Date.now() })).toMatchObject({ ok: false })
  })

  it("rejects zero or negative amounts", () => {
    const date = dateInputToMs("2026-11-05")!
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 0, promisedPaymentDate: date })).toMatchObject({ ok: false })
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: -5, promisedPaymentDate: date })).toMatchObject({ ok: false })
  })

  it("returns both fields, rounded, once valid", () => {
    const date = dateInputToMs("2026-11-05")!
    expect(buildAdvanceFields({ reason: ADVANCE_REASON_PROMISED, expectedAdvanceAmount: 499.6, promisedPaymentDate: date }))
      .toEqual({ ok: true, fields: { expectedAdvanceAmount: 500, promisedPaymentDate: date } })
  })
})

// ---------------------------------------------------------------------------
// legacy orders: no advance fields at all
// ---------------------------------------------------------------------------
describe("legacy orders without advance fields", () => {
  it("reads back as a valid order with both fields undefined", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    const o = await read(t, id)
    expect(o).toBeTruthy()
    // this is the whole point of v.optional — a document written before the feature has neither key
    expect(o!.expectedAdvanceAmount).toBeUndefined()
    expect(o!.promisedPaymentDate).toBeUndefined()
    expect(o!.advanceClearedAt).toBeUndefined()
    expect(o!.status).toBe("pending")
  })

  it("can still be held and cancelled on an ordinary reason without any advance data", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    const hold = await as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: "Customer asked to wait" })
    expect(hold.errors).toEqual([])
    expect(hold.done).toBe(1)
    const o = await read(t, id)
    expect(o!.status).toBe("on_hold")
    expect(o!.reason).toBe("Customer asked to wait")
    expect(o!.expectedAdvanceAmount).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// the real click-path an agent walks
// ---------------------------------------------------------------------------
describe("placing an order on hold for an advance payment", () => {
  it("persists the amount and the promised date on save", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    const date = dateInputToMs("2026-11-05")!

    const res = await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING,
      expectedAdvanceAmount: 500, promisedPaymentDate: date,
    })
    expect(res.errors).toEqual([])
    expect(res.done).toBe(1)

    const o = await read(t, id)
    expect(o!.status).toBe("on_hold")
    expect(o!.reason).toBe(ADVANCE_REASON_AWAITING)
    expect(o!.expectedAdvanceAmount).toBe(500)
    expect(o!.promisedPaymentDate).toBe(date)
    expect(o!.advanceClearedAt).toBeUndefined()
  })

  it("writes the reason into the order log so the history shows who promised what", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_PROMISED,
      expectedAdvanceAmount: 750, promisedPaymentDate: dateInputToMs("2026-11-10")!,
    })
    const logs = await t.run((ctx) => ctx.db.query("orderEvents").collect())
    const line = logs.find((l) => l.orderId === id && l.text.includes(ADVANCE_REASON_PROMISED))
    expect(line).toBeTruthy()
  })

  it("works for a cancel with a refused advance", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    const date = dateInputToMs("2026-11-06")!
    const res = await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "cancelled", reason: ADVANCE_REASON_REFUSED,
      expectedAdvanceAmount: 300, promisedPaymentDate: date,
    })
    expect(res.done).toBe(1)
    const o = await read(t, id)
    expect(o!.status).toBe("cancelled")
    expect(o!.expectedAdvanceAmount).toBe(300)
  })

  it("refuses an advance reason with no amount — nothing half-saved", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    await expect(
      as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING }),
    ).rejects.toThrow(/advance amount/i)
    const o = await read(t, id)
    expect(o!.status).toBe("pending") // untouched
    expect(o!.expectedAdvanceAmount).toBeUndefined()
  })

  it("refuses an advance reason with an amount but no date", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    await expect(
      as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 500 }),
    ).rejects.toThrow(/date/i)
    expect((await read(t, id))!.status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// toggling: the stale-value bug this feature had to avoid
// ---------------------------------------------------------------------------
describe("switching reasons clears stale advance data", () => {
  it("re-holding with an ordinary reason wipes the previous amount and date", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING,
      expectedAdvanceAmount: 5000, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    expect((await read(t, id))!.expectedAdvanceAmount).toBe(5000)

    // same status, different reason: the old promise must not survive
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "on_hold", reason: "Stock not ready" })
    const o = await read(t, id)
    expect(o!.reason).toBe("Stock not ready")
    expect(o!.expectedAdvanceAmount).toBeUndefined()
    expect(o!.promisedPaymentDate).toBeUndefined()
  })

  it("switching from one advance reason to another replaces both values, never merges", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    const d1 = dateInputToMs("2026-11-05")!
    const d2 = dateInputToMs("2026-11-20")!

    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 500, promisedPaymentDate: d1,
    })
    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_PROMISED, expectedAdvanceAmount: 900, promisedPaymentDate: d2,
    })

    const o = await read(t, id)
    expect(o!.reason).toBe(ADVANCE_REASON_PROMISED)
    expect(o!.expectedAdvanceAmount).toBe(900) // not 500
    expect(o!.promisedPaymentDate).toBe(d2) // not d1
  })

  it("moving a held order forward stamps advanceClearedAt but keeps what was asked for", async () => {
    const { t, as, locationId, v41 } = await setup()
    const id = await placeOrder(as, locationId, v41._id)
    await as.mutation(api.orders.changeStatus, {
      ids: [id], to: "on_hold", reason: ADVANCE_REASON_AWAITING,
      expectedAdvanceAmount: 500, promisedPaymentDate: dateInputToMs("2026-11-05")!,
    })
    await as.mutation(api.orders.changeStatus, { ids: [id], to: "approved" })

    const o = await read(t, id)
    expect(o!.status).toBe("approved")
    expect(o!.expectedAdvanceAmount).toBe(500) // history intact
    expect(o!.advanceClearedAt).toBeTypeOf("number") // but no longer a live promise
  })
})
