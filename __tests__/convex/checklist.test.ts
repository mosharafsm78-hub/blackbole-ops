import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"

describe("route to 1 crore checklist", () => {
  async function setup() {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "saju@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    expect(await as.mutation(api.team.claim, { name: "Saju" })).toBe("ok")
    return { t, as }
  }
  it("loads the route once, can be ticked and unticked with who and when", async () => {
    const { as } = await setup()
    expect(await as.mutation(api.checklist.ensureSeeded, {})).toBe(true)
    expect(await as.mutation(api.checklist.ensureSeeded, {})).toBe(false)
    const items = await as.query(api.checklist.list, {})
    expect(items.length).toBeGreaterThan(20)
    expect(items.every((i) => i.doText && i.dontText && i.dueAt > 0)).toBe(true)
    await as.mutation(api.checklist.tick, { id: items[0]._id, done: true })
    expect((await as.query(api.checklist.list, {}))[0]).toMatchObject({ doneBy: "Saju" })
    await as.mutation(api.checklist.tick, { id: items[0]._id, done: false })
    expect((await as.query(api.checklist.list, {}))[0].doneAt).toBeUndefined()
  })
  it("a step past its deadline is raised once to its department; done steps are not", async () => {
    const { t, as } = await setup()
    await as.mutation(api.checklist.ensureSeeded, {})
    const items = await as.query(api.checklist.list, {})
    await t.run(async (ctx) => { for (const i of items.slice(0, 2)) await ctx.db.patch(i._id, { dueAt: Date.now() - 86400000 }) })
    await as.mutation(api.checklist.tick, { id: items[1]._id, done: true })
    await t.action(internal.checklist.flagOverdue, {})
    await t.action(internal.checklist.flagOverdue, {})
    const flags = await t.run((ctx) => ctx.db.query("opsFlags").collect())
    expect(flags).toHaveLength(1)
    expect(flags[0].team).toBe(items[0].team)
    expect(flags[0].reason).toContain(items[0].title)
  })
  it("a custom step can be added and removed, a built-in step cannot be removed", async () => {
    const { as } = await setup()
    await as.mutation(api.checklist.ensureSeeded, {})
    await as.mutation(api.checklist.addStep, { phase: "4 · The monthly ladder to Tk 1 crore", team: "Marketing", title: "Extra", doText: "a", dontText: "b", due: "2026-12-01" })
    const items = await as.query(api.checklist.list, {})
    const extra = items.find((i) => i.title === "Extra")!
    await expect(as.mutation(api.checklist.removeStep, { id: items[0]._id })).rejects.toThrow(/added yourself/)
    await as.mutation(api.checklist.removeStep, { id: extra._id })
    expect((await as.query(api.checklist.list, {})).some((i) => i.title === "Extra")).toBe(false)
  })
})
