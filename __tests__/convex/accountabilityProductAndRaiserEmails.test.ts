import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * Three asks from the fulfillment/accountability feedback: (1) a flagged issue shows which product it's
 * about, (2) the person who raised a flag gets their own email the moment it's routed, and (3) BOTH the
 * raiser and the assignee get told when it's resolved. Also covers the new automatic "orders stuck in
 * Approved" business-health flag.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function sentEmails(t: ReturnType<typeof makeT>) {
  const rows = await t.run(async (ctx) => (await ctx.db.query("smsLogs").collect()).filter((r: any) => r.channel === "email"))
  return rows.map((r: any) => ({ to: r.phone as string, subject: (r.text as string).split(" — ")[0], status: r.status as string }))
}

/** The signed-in user becomes staff under their OWN user email (team.claim), which is exactly the "raiser"
 *  whose address the new raiser-email logic has to resolve by name. */
async function setup(leads: Record<string, { name: string; email: string }> = {}) {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  if (Object.keys(leads).length) await as.mutation(api.accountability.saveOwners, { byTeam: leads })
  const locations = await as.query(api.team.listLocations, {})
  const locationId = locations.find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  const { orderId: orderId0 } = await as.mutation(api.orders.create, {
    source: "Facebook", customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
    locationId, deliveryType: "pickup", items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }],
    discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
  })
  const orderId = orderId0 as Id<"orders">
  return { t, as, orderId }
}

describe("product name on a flagged issue", () => {
  it("freezes the order's product names onto the flag when it's raised from a return call", async () => {
    const { t, as, orderId } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
    await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Sent the wrong size" })

    const open = await as.query(api.accountability.listOpen, {})
    expect(open).toHaveLength(1)
    expect(open[0]!.productNames).toEqual(["Harbor Shore Sandal - Black"])

    const flag = await t.run((ctx) => ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).first())
    expect(flag!.productNames).toEqual(["Harbor Shore Sandal - Black"])
  })
})

describe("raiser gets their own email", () => {
  it("emails the person who raised the flag, separately from the department lead, exactly once", async () => {
    vi.useFakeTimers()
    try {
      const { t, as, orderId } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
      await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Sent the wrong size" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const emails = await sentEmails(t)
      expect(emails.some((e: any) => e.to === "rafi@blackbole.com")).toBe(true) // the department lead
      expect(emails.some((e: any) => e.to === "emon@blackbole.com")).toBe(true) // Emon, who raised it

      const flag = await t.run((ctx) => ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).first())
      expect(flag!.raiserEmailSentAt).toBeDefined()

      // Re-logging the same outcome (reuses the still-open flag) must never send Emon a second copy.
      const before = (await sentEmails(t)).filter((e: any) => e.to === "emon@blackbole.com").length
      await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Still wrong size, called again" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect((await sentEmails(t)).filter((e: any) => e.to === "emon@blackbole.com").length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("resolved — both parties told", () => {
  it("emails the raiser and the assignee when a case is answered, exactly once", async () => {
    vi.useFakeTimers()
    try {
      const { t, as, orderId } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
      await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Sent the wrong size" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const flag = (await t.run((ctx) => ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).first()))!
      await as.mutation(api.accountability.respond, {
        id: flag._id,
        rootCause: "The picker read an old printout instead of the screen.",
        correctiveAction: "Customer refunded and the correct item re-shipped.",
        preventiveAction: "Pickers now scan the SKU barcode before sealing.",
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const emails = await sentEmails(t)
      const resolvedEmails = emails.filter((e: any) => /resolved/i.test(e.subject ?? ""))
      expect(resolvedEmails.some((e: any) => e.to === "emon@blackbole.com")).toBe(true)
      expect(resolvedEmails.some((e: any) => e.to === "rafi@blackbole.com")).toBe(true)

      const after = (await t.run((ctx) => ctx.db.get(flag._id)))!
      expect(after.resolvedEmailSentAt).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("business health — stuck approved orders", () => {
  it("flags Fulfillment once when approved orders have sat untouched past the SLA", async () => {
    const { t, as, orderId } = await setup()
    await as.mutation(api.orders.changeStatus, { ids: [orderId], to: "approved" })
    // Push the order's own statusChangedAt into the past so it reads as stuck without needing a real clock jump.
    await t.run((ctx) => ctx.db.patch(orderId, { statusChangedAt: Date.now() - 3 * 86400000 }))

    await t.action(internal.accountability.businessHealthCheck, {})

    const open = await as.query(api.accountability.listOpen, {})
    expect(open.some((f) => f.team === "Fulfillment" && f.reason.includes("stuck in Approved"))).toBe(true)

    // Running it again the same day must not pile on a second flag for the same thing.
    await t.action(internal.accountability.businessHealthCheck, {})
    const again = await as.query(api.accountability.listOpen, {})
    expect(again.filter((f) => f.reason.includes("stuck in Approved"))).toHaveLength(1)
  })
})
