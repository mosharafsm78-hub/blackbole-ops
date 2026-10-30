import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * Super Admin "Edit / Re-route". The risky parts are all about not over-doing it: a re-route must reach the NEW
 * lead once, must never re-mail the old one, must not fire twice for the same correction, and must leave a case's
 * history alone when nothing actually changed.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** A Super Admin (wildcard role) plus a department lead per team passed in. */
async function setup(leads: Record<string, { name: string; email: string }> = {}, opts: { staff?: { name: string; email: string }[] } = {}) {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "saju@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Saju" })).toBe("ok")
  if (Object.keys(leads).length) await as.mutation(api.accountability.saveOwners, { byTeam: leads })
  // Extra staff, so "switch the lead to Rafi" can resolve a real person.
  for (const s of opts.staff ?? []) {
    const roles = await as.query(api.team.listRoles, {})
    const role = roles.find((r) => r.name === "Team CX") ?? roles[0]
    await as.mutation(api.team.saveStaff, { email: s.email, name: s.name, roleId: role._id, active: true })
  }
  return { t, as, userId }
}

/** A flag exactly as the OLD code wrote it — no edit/re-route fields at all, and no note or assignee. */
async function legacyFlag(t: ReturnType<typeof makeT>, over: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("opsFlags", {
      reason: "Late delivery",
      team: "Marketing",
      status: "open",
      raisedByName: "Care Agent",
      raisedAt: Date.now() - 86400000,
      ...over,
    } as any),
  )
}

const read = (t: ReturnType<typeof makeT>, id: Id<"opsFlags">) => t.run((ctx) => ctx.db.get(id))

/** Emails sent, read from the outward SMS/email log the mailer writes to. */
async function sentEmails(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("smsLogs").collect()
    return rows.filter((r: any) => r.channel === "email")
  })
}

// ---------------------------------------------------------------------------
// legacy data
// ---------------------------------------------------------------------------
describe("edit / re-route — legacy records", () => {
  it("a legacy flag with no edit fields, note or assignee is still valid", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)
    const row = await read(t, id)

    expect(row!.editedAt).toBeUndefined()
    expect(row!.rerouteHistory).toBeUndefined()
    expect(row!.note).toBeUndefined()
    expect(row!.assignee).toBeUndefined()

    const open = await as.query(api.accountability.listOpen, {})
    expect(open).toHaveLength(1)
    expect(open[0]!.rerouteHistory).toBeUndefined()
  })

  it("a legacy flag with no note can be edited without crashing on the missing field", async () => {
    const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
    const id = await legacyFlag(t) // note: undefined

    const res = await as.mutation(api.accountability.rerouteOpsFlag, {
      id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery", note: "Courier missed the pickup.",
    })
    expect(res.changed).toEqual(expect.arrayContaining(["department", "assignee", "note"]))
    const row = await read(t, id)
    expect(row!.note).toBe("Courier missed the pickup.")
    expect(row!.team).toBe("Fulfillment")
  })
})

// ---------------------------------------------------------------------------
// re-routing between departments
// ---------------------------------------------------------------------------
describe("edit / re-route — between departments", () => {
  it("moves a case from MKT to OPS and re-points the assignee", async () => {
    const { t, as } = await setup({
      Marketing: { name: "Mofazzal", email: "mofazzal@blackbole.com" },
      Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" },
    })
    const id = await legacyFlag(t, { team: "Marketing", assignee: "Mofazzal", assigneeEmail: "mofazzal@blackbole.com" })

    const res = await as.mutation(api.accountability.rerouteOpsFlag, {
      id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery", note: "Actually a fulfilment miss.",
    })
    expect(res.changed).toContain("department")
    expect(res.changed).toContain("assignee")

    const row = await read(t, id)
    expect(row!.team).toBe("Fulfillment")
    expect(row!.assignee).toBe("Rafi")
    expect(row!.assigneeEmail).toBe("rafi@blackbole.com") // the daily digest follows the new owner
    expect(row!.editedBy).toBe("Saju")
    expect(typeof row!.editedAt).toBe("number")
    expect(row!.previousTeam).toBe("Marketing")
    expect(row!.newTeam).toBe("Fulfillment")
    expect(row!.previousAssignee).toBe("Mofazzal")
    expect(row!.newAssignee).toBe("Rafi")
    expect(row!.rerouteHistory).toHaveLength(1)
  })

  it("moves the case in the department-filtered counts immediately, from the same reactive query", async () => {
    const { t, as } = await setup()
    await legacyFlag(t, { team: "Marketing" })
    const second = await legacyFlag(t, { team: "Marketing" })

    expect((await as.query(api.accountability.listOpen, {})).filter((f) => f.team === "Marketing")).toHaveLength(2)

    await as.mutation(api.accountability.rerouteOpsFlag, { id: second, team: "Fulfillment", reason: "Late delivery" })

    // The page derives its counts from listOpen, so re-reading it is exactly what a live client sees.
    const after = await as.query(api.accountability.listOpen, {})
    expect(after.filter((f) => f.team === "Marketing")).toHaveLength(1)
    expect(after.filter((f) => f.team === "Fulfillment")).toHaveLength(1)
    expect(await as.query(api.accountability.openCounts, {})).toMatchObject({ total: 2, byTeam: { Marketing: 1, Fulfillment: 1 } })
  })
})

// ---------------------------------------------------------------------------
// no-op
// ---------------------------------------------------------------------------
describe("edit / re-route — no-op", () => {
  it("submitting the unchanged case writes no audit entry and sends no email", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
      const id = await legacyFlag(t, { team: "Fulfillment", assignee: "Rafi", note: "Missed pickup." })

      const res = await as.mutation(api.accountability.rerouteOpsFlag, {
        id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery", note: "Missed pickup.",
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.noop).toBe(true)
      expect(res.changed).toEqual([])

      const row = await read(t, id)
      expect(row!.editedAt).toBeUndefined()
      expect(row!.rerouteHistory).toBeUndefined()
      expect(row!.flagEmailSentAt).toBeUndefined()
      expect(await sentEmails(t)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a title/note-only edit records the change but never emails anyone", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
      const id = await legacyFlag(t, { team: "Fulfillment", assignee: "Rafi" })

      const res = await as.mutation(api.accountability.rerouteOpsFlag, {
        id, team: "Fulfillment", assignee: "Rafi", reason: "Late deliverry", note: "Typo fixed.",
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.changed).toEqual(["title", "note"])
      expect(res.emailed).toBe(false)
      expect((await read(t, id))!.rerouteHistory).toHaveLength(1)
      expect(await sentEmails(t)).toHaveLength(0) // routing didn't change, so nobody is re-notified
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// guard rails
// ---------------------------------------------------------------------------
describe("edit / re-route — guard rails", () => {
  it("refuses an answered case — its history is final", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t, { status: "resolved", resolvedAt: Date.now(), closedAt: Date.now() })
    await expect(as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" }))
      .rejects.toThrow(/already closed/i)
  })

  it("refuses an archived case", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)
    await as.mutation(api.accountability.archive, { id })
    await expect(as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" }))
      .rejects.toThrow(/archived/i)
  })

  it("refuses anyone who is not a Super Admin, even if they can answer cases", async () => {
    const { t, as } = await setup()
    // Fulfillment agents legitimately hold orders.accountability — they answer cases all day. Re-routing is a
    // different right entirely, so this is the gate that must hold: permitted to answer, not to rewrite history.
    const roles = await as.query(api.team.listRoles, {})
    const ops = roles.find((r) => r.name === "Fulfillment") ?? roles.find((r) => !r.permissions.includes("*"))!
    const opsUser = await t.run((ctx) => ctx.db.insert("users", { email: "agent@blackbole.com" }))
    await as.mutation(api.team.saveStaff, { email: "agent@blackbole.com", name: "Rumon", roleId: ops._id, active: true })
    const asOps = t.withIdentity({ subject: `${opsUser}|s2` })

    const id = await legacyFlag(t)
    await expect(asOps.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" }))
      .rejects.toThrow(/super admin/i)
    expect((await read(t, id))!.team).toBe("Marketing") // untouched
  })

  it("refuses someone with no accountability access at all", async () => {
    const { t, as } = await setup()
    const roles = await as.query(api.team.listRoles, {})
    const cx = roles.find((r) => r.name === "Team CX") ?? roles[0]
    const cxUser = await t.run((ctx) => ctx.db.insert("users", { email: "cx@blackbole.com" }))
    await as.mutation(api.team.saveStaff, { email: "cx@blackbole.com", name: "Care Agent", roleId: cx._id, active: true })
    const asCx = t.withIdentity({ subject: `${cxUser}|s3` })

    const id = await legacyFlag(t)
    await expect(asCx.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" }))
      .rejects.toThrow(/permission/i)
    expect((await read(t, id))!.team).toBe("Marketing")
  })

  it("rejects an empty title rather than writing a nameless case", async () => {
    const { t, as } = await setup()
    const id = await legacyFlag(t)
    await expect(as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "   " }))
      .rejects.toThrow(/title/i)
  })
})

// ---------------------------------------------------------------------------
// re-notification
// ---------------------------------------------------------------------------
describe("edit / re-route — re-notification", () => {
  it("emails the NEW lead once, and never the old one", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({
        Marketing: { name: "Mofazzal", email: "mofazzal@blackbole.com" },
        Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" },
      })
      // Raised as a Marketing case that was already emailed to Mofazzal — the Task-5 latch is set.
      const id = await legacyFlag(t, { team: "Marketing", assignee: "Mofazzal", assigneeEmail: "mofazzal@blackbole.com", flagEmailSentAt: Date.now() - 3600000 })

      const res = await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.emailed).toBe(true)
      // The record itself names the new lead as the recipient — the old lead is not in it.
      const row = await read(t, id)
      expect(row!.flagEmailTo).toBe("rafi@blackbole.com")
      expect(row!.flagEmailSentAt).toBeGreaterThan(Date.now() - 5000) // fresh latch for the new lead
      expect(row!.flagEmailSkippedReason).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("submitting the same re-route twice does not send a second email", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
      const id = await legacyFlag(t, { team: "Marketing" })

      const args = { id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery" }
      await as.mutation(api.accountability.rerouteOpsFlag, args)
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      const firstStamp = (await read(t, id))!.flagEmailSentAt
      const firstCount = (await sentEmails(t)).length

      // The same submission again — the second is a genuine no-op (nothing left to change).
      const second = await as.mutation(api.accountability.rerouteOpsFlag, args)
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(second.noop).toBe(true)
      expect((await read(t, id))!.flagEmailSentAt).toBe(firstStamp)
      expect((await sentEmails(t)).length).toBe(firstCount)
      expect((await read(t, id))!.rerouteHistory).toHaveLength(1) // one entry, not two
    } finally {
      vi.useRealTimers()
    }
  })

  it("a missing lead email is recorded and never throws — the re-route still saves", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup() // no leads configured at all
      const id = await legacyFlag(t, { team: "Marketing" })

      const res = await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.emailed).toBe(false)
      expect(res.skippedEmailBecause).toMatch(/no lead is set/i)

      const row = await read(t, id)
      expect(row!.team).toBe("Fulfillment") // the correction itself landed
      expect(row!.flagEmailSentAt).toBeUndefined()
      expect(row!.flagEmailSkippedReason).toMatch(/no lead is set/i)
      expect(row!.rerouteHistory?.[0]?.emailNote).toMatch(/no lead is set/i)
      expect(await sentEmails(t)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a malformed lead address is skipped, not sent", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "not-an-email" } })
      const id = await legacyFlag(t, { team: "Marketing" })
      const res = await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", reason: "Late delivery" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.emailed).toBe(false)
      expect((await read(t, id))!.flagEmailSkippedReason).toMatch(/no valid email/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it("routes to a named person who is on the team, even if they aren't the department lead", async () => {
    vi.useFakeTimers()
    try {
      const { t, as } = await setup(
        { Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } },
        { staff: [{ name: "Rumon", email: "rumon@blackbole.com" }] },
      )
      const id = await legacyFlag(t, { team: "Marketing" })
      const res = await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", assignee: "Rumon", reason: "Late delivery" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.emailed).toBe(true)
      expect((await read(t, id))!.flagEmailTo).toBe("rumon@blackbole.com") // went to the named person, not the lead
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// the trail in Closed cases
// ---------------------------------------------------------------------------
describe("edit / re-route — history", () => {
  it("keeps the re-route trail visible after the case is answered", async () => {
    const { t, as } = await setup({ Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } })
    const id = await legacyFlag(t, { team: "Marketing" })
    await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery" })
    await as.mutation(api.accountability.respond, {
      id,
      rootCause: "The picker read an old printout instead of the screen.",
      correctiveAction: "Customer refunded and the correct item re-shipped.",
      preventiveAction: "Pickers now scan the SKU barcode before sealing.",
    })

    const closed = await as.query(api.accountability.listClosed, {})
    expect(closed).toHaveLength(1)
    // The trail survives the closure, so the closed view can still show how the case got where it did.
    expect(closed[0]!.rerouteHistory).toHaveLength(1)
    expect(closed[0]!.rerouteHistory?.[0]?.previousTeam).toBe("Marketing")
    expect(closed[0]!.editedBy).toBe("Saju")
  })
})
