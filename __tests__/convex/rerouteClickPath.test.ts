import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

/**
 * The click-path a Super Admin actually performs: a misassigned case (a delivery error filed under MKT / Mofazzal)
 * is corrected to OPS / Rafi, the typo in its title is fixed, and then the corrected case is answered — which is
 * the whole point of re-routing instead of archiving and re-creating.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

describe("click-path — Super Admin fixes a misassigned delivery case", () => {
  it("re-routes MKT/Mofazzal → OPS/Rafi, fixes the title, then answers it", async () => {
    vi.useFakeTimers()
    try {
      const t = makeT()
      const userId = await t.run((ctx) => ctx.db.insert("users", { email: "saju@blackbole.com" }))
      const as = t.withIdentity({ subject: `${userId}|s1` })
      expect(await as.mutation(api.team.claim, { name: "Saju" })).toBe("ok")

      await as.mutation(api.accountability.saveOwners, {
        byTeam: {
          Marketing: { name: "Mofazzal", email: "mofazzal@blackbole.com" },
          Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" },
        },
      })
      // A lead setting is not a staff record — put Mofazzal and Rafi on the team too, so the modal's person
      // picker (which lists real staff) can offer them by name.
      const roles = await as.query(api.team.listRoles, {})
      const ops = roles.find((r) => r.name === "Fulfillment") ?? roles[0]
      for (const p of [{ name: "Mofazzal", email: "mofazzal@blackbole.com" }, { name: "Rafi", email: "rafi@blackbole.com" }]) {
        await as.mutation(api.team.saveStaff, { email: p.email, name: p.name, roleId: ops._id, active: true })
      }

      // 1. The case as the system raised it: a delivery failure wrongly filed under Marketing.
      const id = await t.run((ctx) =>
        ctx.db.insert("opsFlags", {
          reason: "Late deliverry", // the typo the complaint is about
          team: "Marketing",
          assignee: "Mofazzal",
          assigneeEmail: "mofazzal@blackbole.com",
          note: undefined, // legacy: no note at all
          status: "open",
          raisedByName: "Care Agent",
          raisedAt: Date.now() - 86400000,
          flagEmailSentAt: Date.now() - 3600000, // already emailed to the wrong lead
        } as any),
      )

      // The queue shows it under Marketing.
      expect((await as.query(api.accountability.openCounts, {})).byTeam).toMatchObject({ Marketing: 1 })

      // 2. The Super Admin opens the modal — the picker must offer both departments and both people.
      const choices = await as.query(api.accountability.assigneeChoices, {})
      expect(choices.teams).toEqual(expect.arrayContaining(["Marketing", "Fulfillment"]))
      expect(choices.byTeam.Fulfillment).toMatchObject({ name: "Rafi" })
      expect(choices.people.map((p) => p.name)).toEqual(expect.arrayContaining(["Mofazzal", "Rafi"]))

      // 3. Save: OPS + Rafi + the typo fixed + a real note.
      const res = await as.mutation(api.accountability.rerouteOpsFlag, {
        id,
        team: "Fulfillment",
        assignee: "Rafi",
        reason: "Late delivery",
        note: "Courier missed the pickup window — fulfilment never handed it over.",
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(res.noop).toBe(false)
      expect(res.emailed).toBe(true)
      expect(res.changed).toEqual(expect.arrayContaining(["department", "assignee", "title", "note"]))

      // 4. The queue counts moved instantly — Marketing is clear, OPS owns it now.
      const counts = await as.query(api.accountability.openCounts, {})
      expect(counts.byTeam.Marketing).toBeUndefined()
      expect(counts.byTeam.Fulfillment).toBe(1)

      // 5. The record reads correctly, with a full audit trail.
      const row = await t.run((ctx) => ctx.db.get(id))
      expect(row!.team).toBe("Fulfillment")
      expect(row!.assignee).toBe("Rafi")
      expect(row!.reason).toBe("Late delivery")
      expect(row!.note).toMatch(/pickup window/)
      expect(row!.editedBy).toBe("Saju")
      expect(row!.previousTeam).toBe("Marketing")
      expect(row!.newTeam).toBe("Fulfillment")
      expect(row!.flagEmailTo).toBe("rafi@blackbole.com") // went to the NEW lead
      expect(row!.rerouteHistory).toHaveLength(1)
      expect(row!.rerouteHistory![0]).toMatchObject({
        editedBy: "Saju", previousTeam: "Marketing", newTeam: "Fulfillment",
        previousAssignee: "Mofazzal", newAssignee: "Rafi",
      })

      // 6. The order timeline records it, so the correction is visible where the order lives.
      //    (this flag has no orderId, so nothing is expected there — asserted below on a real order)

      // 7. Rafi answers the corrected case — exactly as if it had been raised correctly in the first place.
      await as.mutation(api.accountability.respond, {
        id,
        rootCause: "Fulfilment held the parcel past the courier's cut-off and never rebooked it.",
        correctiveAction: "Parcel re-picked and shipped same day; customer notified of the new date.",
        preventiveAction: "The dispatch sheet now fails closed at 4pm with any unbooked parcel listed.",
      })
      const after = await t.run((ctx) => ctx.db.get(id))
      expect(after!.status).toBe("resolved")

      // 8. Closed cases still shows how it got there.
      const closed = await as.query(api.accountability.listClosed, {})
      expect(closed).toHaveLength(1)
      expect(closed[0]!.rerouteHistory).toHaveLength(1)
      expect(closed[0]!.editedBy).toBe("Saju")
      expect(closed[0]!.resolvedByName).toBe("Saju")
    } finally {
      vi.useRealTimers()
    }
  })

  it("records the re-route on the linked order's timeline", async () => {
    vi.useFakeTimers()
    try {
      const t = makeT()
      const userId = await t.run((ctx) => ctx.db.insert("users", { email: "saju@blackbole.com" }))
      const as = t.withIdentity({ subject: `${userId}|s1` })
      expect(await as.mutation(api.team.claim, { name: "Saju" })).toBe("ok")
      await as.mutation(api.accountability.saveOwners, { byTeam: { Fulfillment: { name: "Rafi", email: "rafi@blackbole.com" } } })

      const orderId = await t.run(async (ctx) => {
        const customerId = await ctx.db.insert("customers", {
          code: 1, name: "Test Customer", phone: "01711000000", tag: "NEW",
          orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0,
          createdAt: Date.now() - 86400000,
        } as any)
        const locationId = await ctx.db.insert("locations", { name: "CTG", isDefault: true, active: true } as any)
        return await ctx.db.insert("orders", {
          invoiceNo: 1001, status: "delivered_paid", source: "Facebook", customerId,
          customerName: "Test Customer", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
          locationId, deliveryType: "pickup", items: [], subtotal: 0, discount: 0, deliveryFee: 0,
          paidAmount: 0, total: 0, due: 0, callCount: 0, createdByName: "Saju",
          createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000, statusChangedAt: Date.now() - 86400000,
        } as any)
      })

      const id = await t.run((ctx) =>
        ctx.db.insert("opsFlags", {
          orderId, reason: "Late delivery", team: "Marketing", assignee: "Mofazzal", status: "open",
          raisedByName: "Care Agent", raisedAt: Date.now() - 86400000,
        } as any),
      )

      await as.mutation(api.accountability.rerouteOpsFlag, { id, team: "Fulfillment", assignee: "Rafi", reason: "Late delivery" })
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const log = await t.run(async (ctx) => {
        const rows = await ctx.db.query("orderEvents").collect()
        return rows.filter((r: any) => r.orderId === orderId).map((r: any) => r.text as string)
      })
      expect(log.some((x) => /Marketing → Fulfillment/.test(x))).toBe(true)
      expect(log.some((x) => /Mofazzal → Rafi/.test(x))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
