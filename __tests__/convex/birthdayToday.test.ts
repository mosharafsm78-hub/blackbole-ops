import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

describe("birthdays.today (index-based)", () => {
  it("lists only customers whose saved birthday is today, ignoring people with no birthday", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "lead@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    expect(await as.mutation(api.team.claim, { name: "Lead" })).toBe("ok")
    const d = new Date(Date.now() + 6 * 3600000)
    const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    const other = md === "01-01" ? "02-02" : "01-01"
    await t.run(async (ctx) => {
      const base = { orderCount: 0, createdAt: Date.now(), code: 1, tag: "NEW", deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0 }
      await ctx.db.insert("customers", { ...base, name: "Today Person", phone: "01700000001", dob: `1990-${md}` } as any)
      await ctx.db.insert("customers", { ...base, name: "Other Day", phone: "01700000002", dob: `1990-${other}` } as any)
      await ctx.db.insert("customers", { ...base, name: "No Birthday", phone: "01700000003" } as any)
    })
    const rows = await as.query(api.birthdays.today, {})
    expect(rows.map((r) => r.name)).toEqual(["Today Person"])
  })
})
