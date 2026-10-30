import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { ADVANCE_REASON_AWAITING } from "../../convex/rules"

/**
 * The KPI leaderboard is a point ledger, not a running total — the risk is double-counting (an order
 * transition re-firing the same rule) and misattribution (a system actor like "Pathao sync" or "Auto-approve"
 * getting credited for a human's work). Both are covered here, plus the ordinary "does the right person get
 * the right points" paths.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id

  // A second staff member (Rafi) who will actually earn points in most of these tests. Given Super Admin so a
  // single fixture works across checkout conversion (orders.create), order-status moves, and accountability
  // responses (orders.accountability) without juggling a different role per test.
  const roles = await as.query(api.team.listRoles, {})
  const role = roles.find((r) => r.name === "Super Admin") ?? roles[0]
  const rafiUser = await t.run((ctx) => ctx.db.insert("users", { email: "rafi@blackbole.com" }))
  await as.mutation(api.team.saveStaff, { email: "rafi@blackbole.com", name: "Rafi", roleId: role._id, active: true })
  const asRafi = t.withIdentity({ subject: `${rafiUser}|s2` })

  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!

  return { t, as, asRafi, locationId, v41 }
}

describe("recovered abandoned checkout", () => {
  it("credits the agent who converts the cart to an APPROVED order, not to pending", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    const checkoutId = await t.run((ctx) =>
      ctx.db.insert("checkouts", {
        checkoutId: "cko_1", customerName: "Test Customer", phone: "", address: "", items: [
          { variantId: v41._id, sku: "BB-HSS-41", name: "Harbor Shore Sandal - Black", price: 1480, qty: 1, discount: 0, weightKg: 0.4 },
        ],
        subtotal: 1480, discount: 0, deliveryFee: 0, total: 1480, shopCreatedAt: Date.now(), shopUpdatedAt: Date.now(),
        status: "open", callCount: 0,
      }),
    )
    await asRafi.mutation(api.checkouts.convert, {
      id: checkoutId, customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia", deliveryFee: 0, status: "approved",
    })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")?.points).toBe(20)
  })

  it("does NOT credit a recovery left as pending — only an approved order counts", async () => {
    const { t, as, asRafi, v41 } = await setup()
    const checkoutId = await t.run((ctx) =>
      ctx.db.insert("checkouts", {
        checkoutId: "cko_2", customerName: "Test Customer", phone: "", address: "", items: [
          { variantId: v41._id, sku: "BB-HSS-41", name: "Harbor Shore Sandal - Black", price: 1480, qty: 1, discount: 0, weightKg: 0.4 },
        ],
        subtotal: 1480, discount: 0, deliveryFee: 0, total: 1480, shopCreatedAt: Date.now(), shopUpdatedAt: Date.now(),
        status: "open", callCount: 0,
      }),
    )
    await asRafi.mutation(api.checkouts.convert, {
      id: checkoutId, customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia", deliveryFee: 0, status: "pending",
    })
    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")).toBeUndefined()
  })
})

describe("advance payment clearing", () => {
  const baseOrder = (locationId: Id<"locations">, variantId: Id<"variants">) => ({
    source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
    locationId, deliveryType: "pickup", items: [{ variantId, qty: 1, price: 1480, discount: 0 }],
    discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
  })

  it("credits the agent who moves the order off hold once the advance clears, exactly once", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    const { orderId: id0 } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const orderId = id0 as Id<"orders">
    await asRafi.mutation(api.orders.changeStatus, {
      ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 500, promisedPaymentDate: Date.now() + 86400000,
    })
    await asRafi.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })

    let board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")?.points).toBe(15)

    // A later, ordinary move of the SAME order (processing) must not re-fire the same rule a second time.
    await asRafi.mutation(api.orders.changeStatus, { ids: [orderId], to: "processing" })
    board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")?.points).toBe(15) // unchanged, not 30
  })

  it("never credits a system actor (Auto-approve) for a scheduled hold clearing itself", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    const { orderId: id0 } = await as.mutation(api.orders.create, baseOrder(locationId, v41._id))
    const orderId = id0 as Id<"orders">
    await asRafi.mutation(api.orders.changeStatus, {
      ids: [orderId], to: "on_hold", reason: ADVANCE_REASON_AWAITING, expectedAdvanceAmount: 500, promisedPaymentDate: Date.now() + 86400000, autoApproveAt: Date.now() - 1000,
    })
    const { internal } = await import("../../convex/_generated/api")
    await t.mutation(internal.orders.runAutoApprove, {})

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly).toEqual([]) // "Auto-approve" isn't a real staff member — nobody gets credited
  })
})

describe("accountability scoring", () => {
  async function flagId(t: ReturnType<typeof makeT>, as: any, locationId: Id<"locations">, v41: Id<"variants">) {
    const { orderId: id0 } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
      locationId, deliveryType: "pickup", items: [{ variantId: v41, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })
    await as.mutation(api.orders.logReturnCsat, { id: id0 as Id<"orders">, outcome: "Wrong product sent", note: "test" })
    const flag: any = await t.run((ctx: any) => ctx.db.query("opsFlags").withIndex("by_order", (q: any) => q.eq("orderId", id0)).first())
    return flag._id as Id<"opsFlags">
  }

  it("credits a fast, complete CAPA answer resolved within 6 hours", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    await as.mutation(api.accountability.saveOwners, { byTeam: { Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } } })
    const id = await flagId(t, as, locationId, v41._id)

    await asRafi.mutation(api.accountability.respond, {
      id, rootCause: "The picker read an old printout instead of the screen.",
      correctiveAction: "Customer refunded and the correct item re-shipped.",
      preventiveAction: "Pickers now scan the SKU barcode before sealing.",
    })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")?.points).toBe(15)
  })

  it("does NOT credit a CAPA answer that took longer than 6 hours", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    await as.mutation(api.accountability.saveOwners, { byTeam: { Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } } })
    const id = await flagId(t, as, locationId, v41._id)
    await t.run((ctx) => ctx.db.patch(id, { raisedAt: Date.now() - 7 * 3600000 }))

    await asRafi.mutation(api.accountability.respond, {
      id, rootCause: "The picker read an old printout instead of the screen.",
      correctiveAction: "Customer refunded and the correct item re-shipped.",
      preventiveAction: "Pickers now scan the SKU barcode before sealing.",
    })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")).toBeUndefined()
  })

  it("docks the raiser when a Super Admin re-routes a flag to a different department", async () => {
    const { t, as, locationId, v41 } = await setup()
    await as.mutation(api.accountability.saveOwners, {
      byTeam: { Marketing: { name: "Emon", email: "mkt@blackbole.com" }, Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } },
    })
    const { orderId: id0 } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
      locationId, deliveryType: "pickup", items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })
    await as.mutation(api.orders.logReturnCsat, { id: id0 as Id<"orders">, outcome: "Doesn't match description", note: "test" })
    const flag: any = await t.run((ctx: any) => ctx.db.query("opsFlags").withIndex("by_order", (q: any) => q.eq("orderId", id0)).first())
    const id = flag._id as Id<"opsFlags">

    // Emon raised it (via logReturnCsat, acting as themselves) and it was routed to Marketing — a Super Admin
    // decides it's actually a Fulfillment issue.
    await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", assignee: "Rafi", reason: "Doesn't match description" })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Emon")?.points).toBe(-20)
  })
})

describe("manual awards and rule config", () => {
  it("a Super Admin can award or dock points by hand for anything not auto-tracked", async () => {
    const { as } = await setup()
    await as.mutation(api.kpi.manualAward, { staffName: "Rafi", points: 2, reason: "Packed 45 pairs this hour — above baseline", ruleKey: "fulfillment.pack_speed" })
    await as.mutation(api.kpi.manualAward, { staffName: "Rafi", points: -50, reason: "Shipped the wrong size on BB-11234" })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")?.points).toBe(-48)
  })

  it("refuses a manual award for someone who isn't an active staff member", async () => {
    const { as } = await setup()
    await expect(as.mutation(api.kpi.manualAward, { staffName: "Nobody Here", points: 10, reason: "test" })).rejects.toThrow(/wasn't found/i)
  })

  it("turning a rule off in Settings stops it from awarding, without a redeploy", async () => {
    const { t, as, asRafi, locationId, v41 } = await setup()
    await as.mutation(api.kpi.saveRule, { key: "cx.advance_secured", points: 15, active: false })

    const { orderId: id0 } = await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
      locationId, deliveryType: "pickup", items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }],
      discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })
    const orderId = id0 as Id<"orders">
    await asRafi.mutation(api.orders.changeStatus, { ids: [orderId], to: "on_hold", reason: "Customer asked to wait", expectedAdvanceAmount: 500 })
    await asRafi.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })

    const board = await as.query(api.kpi.leaderboard, {})
    expect(board!.weekly.find((r) => r.staffName === "Rafi")).toBeUndefined()
  })
})

describe("monthly payout", () => {
  it("finalizing a month ranks the top scorers and creates pending payouts; marking paid locks that rank in", async () => {
    const { as } = await setup()
    await as.mutation(api.kpi.manualAward, { staffName: "Rafi", points: 100, reason: "Top performer this month" })
    await as.mutation(api.kpi.manualAward, { staffName: "Emon", points: 50, reason: "Second place" })

    const month = new Date().toISOString().slice(0, 7)
    const res = await as.mutation(api.kpi.finalizeMonth, { month, prizes: [1800, 800, 400] })
    expect(res.created).toBe(2) // only two people have ever earned points
    expect(res.ranked[0]!.staffName).toBe("Rafi")

    const payouts = await as.query(api.kpi.listPayouts, { month })
    const first = payouts.find((p) => p.rank === 1)!
    expect(first.staffName).toBe("Rafi")
    expect(first.amount).toBe(1800)
    expect(first.status).toBe("pending")

    await as.mutation(api.kpi.markPayoutPaid, { id: first._id, note: "Paid via bKash" })
    const afterPay = (await as.query(api.kpi.listPayouts, { month })).find((p) => p.rank === 1)!
    expect(afterPay.status).toBe("paid")

    // Re-finalizing the same month must never undo an already-paid rank.
    await as.mutation(api.kpi.manualAward, { staffName: "Emon", points: 200, reason: "Huge save at the end of the month" })
    await as.mutation(api.kpi.finalizeMonth, { month, prizes: [1800, 800, 400] })
    const afterRefinalize = (await as.query(api.kpi.listPayouts, { month })).find((p) => p.rank === 1)!
    expect(afterRefinalize.staffName).toBe("Rafi") // still Rafi, even though Emon now outranks them
    expect(afterRefinalize.status).toBe("paid")
  })
})
