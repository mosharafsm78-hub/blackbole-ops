import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { isValidEmail } from "../../convex/accountability"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** One staff user with full access, plus a department lead configured for Fulfillment. */
async function setup(lead?: { name: string; email: string }) {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "ops@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Ops Lead" })).toBe("ok")
  if (lead) {
    await as.mutation(api.accountability.saveOwners, { byTeam: { Fulfillment: lead } })
  }
  return { t, as }
}

/** A flag exactly as the OLD code wrote it: no closedAt, no archivedAt, no email-tracking fields at all.
 *  This is the shape of every accountability record already in production. */
async function legacyFlag(t: ReturnType<typeof makeT>, over: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("opsFlags", {
      reason: "Wrong product sent",
      team: "Fulfillment",
      status: "open",
      raisedByName: "Care Agent",
      raisedAt: Date.now() - 86400000,
      ...over,
    } as any),
  )
}

const read = (t: ReturnType<typeof makeT>, id: Id<"opsFlags">) => t.run((ctx) => ctx.db.get(id))

/** A minimal real order, so the flag can be raised through the actual return-call path rather than by hand. */
async function makeOrder(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", {
      code: 1, name: "Test Customer", phone: "01711000000", tag: "NEW",
      orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0,
      createdAt: Date.now() - 86400000,
    } as any)
    const locationId = await ctx.db.insert("locations", { name: "CTG", isDefault: true, active: true } as any)
    return await ctx.db.insert("orders", {
      invoiceNo: 1001,
      status: "delivered_paid",
      source: "Facebook",
      customerId,
      customerName: "Test Customer",
      phone: "+8801711000000",
      address: "House 1, Road 2, Lalmatia",
      locationId,
      deliveryType: "pickup",
      items: [],
      subtotal: 0,
      discount: 0,
      deliveryFee: 0,
      paidAmount: 0,
      total: 0,
      due: 0,
      callCount: 0,
      createdByName: "Ops Lead",
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
      statusChangedAt: Date.now() - 86400000,
    } as any)
  })
}

// ---------------------------------------------------------------------------
// legacy data
// ---------------------------------------------------------------------------
describe("closed cases — legacy records", () => {
  it("a legacy flag with none of the new fields is still valid and still open", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)

    const row = await read(t, id)
    expect(row!.closedAt).toBeUndefined()
    expect(row!.archivedAt).toBeUndefined()
    expect(row!.flagEmailSentAt).toBeUndefined()

    // It shows in the open queue, and nowhere in the closed history.
    const open = await as.query(api.accountability.listOpen, {})
    expect(open).toHaveLength(1)
    expect(await as.query(api.accountability.listClosed, {})).toHaveLength(0)
  })

  it("a flag resolved before closedAt existed still appears in Closed cases", async () => {
    const { t, as } = await setup()
    // Resolved the old way: status + resolvedAt, but no closedAt.
    await legacyFlag(t, {
      status: "resolved",
      resolvedAt: Date.now() - 3600000,
      resolvedByName: "Ops Lead",
      response: "Root cause: x\nFix: y\nPrevention: z",
    })

    const closed = await as.query(api.accountability.listClosed, {})
    expect(closed).toHaveLength(1)
    expect(closed[0]!.outcome).toBe("answered")
    // Falls back to resolvedAt so the row still sorts and displays a real date.
    expect(closed[0]!.closedAtResolved).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// archiving
// ---------------------------------------------------------------------------
describe("closed cases — archiving", () => {
  it("archives a legacy flag as a soft delete and records who and when", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)

    const res = await as.mutation(api.accountability.archive, { id, reason: "duplicate" })
    expect(res.alreadyArchived).toBe(false)

    const row = await read(t, id)
    expect(row!.status).toBe("archived")
    expect(row!.archivedBy).toBe("Ops Lead")
    expect(row!.archiveReason).toBe("duplicate")
    expect(typeof row!.archivedAt).toBe("number")
    expect(typeof row!.closedAt).toBe("number")
    // Soft delete: the case itself is untouched.
    expect(row!.reason).toBe("Wrong product sent")
    expect(row!.raisedByName).toBe("Care Agent")
  })

  it("is idempotent — archiving twice does not error or change the first stamp", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)

    await as.mutation(api.accountability.archive, { id })
    const first = await read(t, id)
    const res = await as.mutation(api.accountability.archive, { id })
    const second = await read(t, id)

    expect(res.alreadyArchived).toBe(true)
    expect(second!.archivedAt).toBe(first!.archivedAt)
  })

  it("refuses to archive a case that was already answered", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t, { status: "resolved", resolvedAt: Date.now() })
    await expect(as.mutation(api.accountability.archive, { id })).rejects.toThrow(/already closed/i)
  })

  it("an archived case leaves the open queue and appears in Closed cases", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)
    await as.mutation(api.accountability.archive, { id })

    expect(await as.query(api.accountability.listOpen, {})).toHaveLength(0)
    const closed = await as.query(api.accountability.listClosed, {})
    expect(closed).toHaveLength(1)
    expect(closed[0]!.outcome).toBe("archived")
    expect(closed[0]!.archivedBy).toBe("Ops Lead")
  })

  it("restores an archived case back to the open queue", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)
    await as.mutation(api.accountability.archive, { id })
    await as.mutation(api.accountability.unarchive, { id })

    const row = await read(t, id)
    expect(row!.status).toBe("open")
    expect(row!.archivedAt).toBeUndefined()
    expect(row!.closedAt).toBeUndefined()
    expect(await as.query(api.accountability.listOpen, {})).toHaveLength(1)
  })

  it("filters Closed cases by department", async () => {
    const { t, as } = await setup()
    await legacyFlag(t, { status: "resolved", resolvedAt: Date.now(), team: "Fulfillment" })
    await legacyFlag(t, { status: "resolved", resolvedAt: Date.now(), team: "Marketing" })

    expect(await as.query(api.accountability.listClosed, {})).toHaveLength(2)
    expect(await as.query(api.accountability.listClosed, { team: "Marketing" })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// the flag email
// ---------------------------------------------------------------------------
describe("flag email — idempotency", () => {
  it("re-flagging the same order does not send a second email", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({ name: "Rahim Uddin", email: "rahim@blackbole.com" })
      const orderId = await makeOrder(t)

      // First return call: raises the flag and sends one email.
      await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Sent the wrong colour." })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const first = await t.run((ctx) => ctx.db.query("opsFlags").collect())
      expect(first).toHaveLength(1)
      expect(typeof first[0]!.flagEmailSentAt).toBe("number")
      expect(first[0]!.flagEmailSkippedReason).toBeUndefined()
      const sentAt = first[0]!.flagEmailSentAt

      // The same order is re-flagged (a re-logged call, or a double-click). The flag is reused, and the
      // email latch must hold — no second email.
      await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Re-logged." })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const after = await t.run((ctx) => ctx.db.query("opsFlags").collect())
      expect(after).toHaveLength(1) // still one flag, not two
      expect(after[0]!.flagEmailSentAt).toBe(sentAt) // and the original send stamp is untouched
    } finally {
      vi.useRealTimers()
    }
  })

  it("a missing lead email does not throw and records why it was skipped", async () => {
    const { t, as } = await setup() // no lead configured at all
    const orderId = await makeOrder(t)

    // The flag action itself must succeed regardless of the email problem.
    await expect(as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Wrong item." })).resolves.not.toThrow()

    const flags = await t.run((ctx) => ctx.db.query("opsFlags").collect())
    expect(flags).toHaveLength(1)
    expect(flags[0]!.flagEmailSentAt).toBeUndefined()
    expect(flags[0]!.flagEmailSkippedReason).toMatch(/no lead is set/i)
    // The flag is still open and actionable — an email problem never blocks the flag.
    expect(flags[0]!.status).toBe("open")
  })

  it("a malformed lead address is skipped, not sent", async () => {
    const { t, as } = await setup({ name: "Rahim", email: "not-an-email" })
    const orderId = await makeOrder(t)
    await as.mutation(api.orders.logReturnCsat, { id: orderId, outcome: "Wrong product sent", note: "Wrong item." })

    const flags = await t.run((ctx) => ctx.db.query("opsFlags").collect())
    expect(flags[0]!.flagEmailSentAt).toBeUndefined()
    expect(flags[0]!.flagEmailSkippedReason).toMatch(/no valid email/i)
  })

  it("validates addresses the way the sender does", () => {
    expect(isValidEmail("rahim@blackbole.com")).toBe(true)
    expect(isValidEmail("  rahim@blackbole.com  ")).toBe(true)
    expect(isValidEmail("not-an-email")).toBe(false)
    expect(isValidEmail("a@b")).toBe(false)
    expect(isValidEmail("")).toBe(false)
    expect(isValidEmail(undefined)).toBe(false)
    expect(isValidEmail(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// answering closes the case
// ---------------------------------------------------------------------------
describe("closed cases — answering", () => {
  it("stamps closedAt when a case is answered, and it lands in Closed cases", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)

    await as.mutation(api.accountability.respond, {
      id,
      rootCause: "The picker read an old printout instead of the screen.",
      correctiveAction: "Customer refunded and the correct item re-shipped.",
      preventiveAction: "Pickers now scan the SKU barcode before sealing.",
    })

    const row = await read(t, id)
    expect(row!.status).toBe("resolved")
    expect(typeof row!.closedAt).toBe("number")

    const closed = await as.query(api.accountability.listClosed, {})
    expect(closed).toHaveLength(1)
    expect(closed[0]!.outcome).toBe("answered")
    expect(closed[0]!.resolvedByName).toBe("Ops Lead")
  })
})
