import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * A fake/duplicate order that was already confirmed over the phone is a screening miss on THAT confirmation
 * call — the agent who actually ran it should answer for it, not whoever happens to lead Customer Care that
 * week. (Before this, every "Duplicate order" / "Fake / prank order" cancel routed to the department lead by
 * default, so two different agents' mistakes both landed on the same lead's desk.)
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  await as.mutation(api.accountability.saveOwners, { byTeam: { "Customer Care": { name: "Nuha", email: "nuha@blackbole.com" } } })
  const roles = await as.query(api.team.listRoles, {})
  const cx = roles.find((r) => r.name === "Team CX") ?? roles[0]
  await as.mutation(api.team.saveStaff, { email: "nuha@blackbole.com", name: "Nuha", roleId: cx._id, active: true })
  // Create Arian's auth user FIRST so saveStaff links staff.userId right away (same as how a real
  // already-signed-in invite gets linked) — otherwise `as Arian` below has no staff record to find.
  const arianUserId = await t.run((ctx) => ctx.db.insert("users", { email: "arian@blackbole.com" }))
  await as.mutation(api.team.saveStaff, { email: "arian@blackbole.com", name: "Arian", roleId: cx._id, active: true })

  const locations = await as.query(api.team.listLocations, {})
  const locationId = locations.find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Veyron Casual Loafer", active: true,
    variants: [{ sku: "BB-VCL-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-VCL-42")).unique()))!
  const { orderId: orderId0 } = await as.mutation(api.orders.create, {
    source: "Website", customerName: "Maruf Shariair Antor", phone: "+8801709529850", address: "House 1, Road 2, Lalmatia",
    locationId, deliveryType: "pickup", items: [{ variantId: v._id, qty: 1, price: 1480, discount: 0 }],
    discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
  })
  return { t, as, orderId: orderId0 as Id<"orders">, arianUserId }
}

describe("duplicate/fake order cancel routes to the agent who confirmed it", () => {
  it("assigns the flag to the specific confirming agent, not the department lead, when they differ", async () => {
    const { t, as, orderId, arianUserId } = await setup()
    // Arian is the one who actually ran the confirmation call — NOT the CX lead (Nuha).
    const arian = t.withIdentity({ subject: `${arianUserId}|s2` })
    await arian.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })

    await arian.mutation(api.orders.changeStatus, { ids: [orderId], to: "cancelled", reason: "Duplicate order" })

    const flag = await t.run((ctx) => ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).first())
    expect(flag).toBeTruthy()
    expect(flag!.team).toBe("Customer Care")
    expect(flag!.assignee).toBe("Arian") // not "Nuha", the department lead
  })

  it("falls back to the department lead when no confirming agent can be found", async () => {
    const { t, as, orderId } = await setup()
    // Approved with no prior "pending" confirmation call to earn cx.order_confirmed (e.g. a migrated/legacy
    // order) — nothing to attribute to a specific agent, so it should fall back to the CX lead as before.
    await t.run((ctx) => ctx.db.patch(orderId, { status: "approved", approvedAt: Date.now() }))

    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "cancelled", reason: "Fake / prank order" })

    const flag = await t.run((ctx) => ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).first())
    expect(flag!.assignee).toBe("Nuha")
  })
})
