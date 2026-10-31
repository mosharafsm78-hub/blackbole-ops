import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"

/** Results tracking: an answer needs review, what a team needs from another becomes a case, and a problem that
 *  returns after an answer is counted as the earlier fix not holding. */
function makeT() { return convexTest(schema, import.meta.glob("../../convex/**/*.*s")) }
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "saju@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Saju" })).toBe("ok")
  return { t, as }
}
const flag = (t: ReturnType<typeof makeT>, over: Record<string, unknown> = {}) =>
  t.run((ctx) => ctx.db.insert("opsFlags", { reason: "Doesn't match description", team: "Marketing", status: "open", raisedByName: "ijaab", raisedAt: Date.now(), productNames: ["Veyron Loafer"], ...over } as any))
const A = { rootCause: "Product photos show a brighter colour than the real leather.", correctiveAction: "Customer offered an exchange.", preventiveAction: "Every product photo is checked against the real pair before upload." }

describe("accountability results", () => {
  it("an answer waits for review, can't be self-accepted, and is accepted by someone else", async () => {
    const { t, as } = await setup()
    const id = await flag(t)
    await as.mutation(api.accountability.respond, { id, ...A, fixOwner: "Rumon", fixDueDays: 7 })
    let f = await t.run((ctx) => ctx.db.get(id))
    expect(f?.reviewStatus).toBe("pending")
    expect(f?.fixOwner).toBe("Rumon")
    expect(f!.fixDueAt! - Date.now()).toBeGreaterThan(6 * 86400000)
    await expect(as.mutation(api.accountability.review, { id, accept: true })).rejects.toThrow(/your own/)
    await t.run((ctx) => ctx.db.patch(id, { resolvedByName: "Someone Else" }))
    await as.mutation(api.accountability.review, { id, accept: true })
    f = await t.run((ctx) => ctx.db.get(id))
    expect(f?.reviewStatus).toBe("accepted")
    expect(f!.checkDueAt! - Date.now()).toBeGreaterThan(29 * 86400000)
  })

  it("sending back needs a reason and returns the case to the open queue", async () => {
    const { t, as } = await setup()
    const id = await flag(t)
    await as.mutation(api.accountability.respond, { id, ...A })
    await t.run((ctx) => ctx.db.patch(id, { resolvedByName: "Someone Else" }))
    await expect(as.mutation(api.accountability.review, { id, accept: false, note: "no" })).rejects.toThrow(/what is missing/i)
    await as.mutation(api.accountability.review, { id, accept: false, note: "This is a request, not a fix." })
    const f = await t.run((ctx) => ctx.db.get(id))
    expect(f?.status).toBe("open")
    expect(f?.reviewStatus).toBe("sent_back")
    expect(f?.reviewNote).toMatch(/not a fix/)
    expect((await as.query(api.accountability.listOpen, {})).some((x: any) => x._id === id)).toBe(true)
  })

  it("what a team needs from another department becomes a case there", async () => {
    const { t, as } = await setup()
    const id = await flag(t)
    await expect(as.mutation(api.accountability.respond, { id, ...A, needsFrom: "Development" })).rejects.toThrow(/what you need/i)
    await as.mutation(api.accountability.respond, { id, ...A, needsFrom: "Development", needsWhat: "A list of products whose colour differs from the photos" })
    const linked = await t.run((ctx) => ctx.db.query("opsFlags").filter((q) => q.eq(q.field("linkedFromId"), id)).collect())
    expect(linked).toHaveLength(1)
    expect(linked[0].team).toBe("Development")
    expect(linked[0].status).toBe("open")
  })

  it("the same problem coming back after an answer is counted as a repeat", async () => {
    const { t, as } = await setup()
    const first = await flag(t, { status: "resolved", resolvedAt: Date.now() - 5 * 86400000, reviewStatus: "accepted" })
    const again = await t.mutation(internal.accountability.raiseSystem, { team: "Marketing", reason: "Doesn't match description" })
    const f = await t.run((ctx) => ctx.db.get(again))
    expect(f?.repeatOfId).toBe(first)
    expect((await t.run((ctx) => ctx.db.get(first)))?.repeatCount).toBe(1)
    const card = await as.query(api.accountability.scorecard, {})
    expect(card.find((r) => r.team === "Marketing")?.cameBack).toBe(1)
  })
})
