import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { SLA_DAYS } from "../../convex/accountability"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "ops@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Ops Lead" })
  return { t, as }
}

describe("findingLog.log — one-click close", () => {
  it("accepts an empty note when marking resolved, and fills in a default text", async () => {
    const { as } = await setup()
    await as.mutation(api.findingLog.log, { findingId: "sku-returns", text: "", status: "resolved" })
    const entries = await as.query(api.findingLog.list, { findingId: "sku-returns" })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe("resolved")
    expect(entries[0].text).toBe("Marked resolved")
  })

  it("still requires a real note for open / in_progress logs", async () => {
    const { as } = await setup()
    await expect(as.mutation(api.findingLog.log, { findingId: "sku-returns", text: "  ", status: "in_progress" })).rejects.toThrow(
      "Write what was done before logging it",
    )
    await expect(as.mutation(api.findingLog.log, { findingId: "sku-returns", text: "  ", status: "open" })).rejects.toThrow(
      "Write what was done before logging it",
    )
  })

  it("keeps a real note when one is given, even for a resolved log", async () => {
    const { as } = await setup()
    await as.mutation(api.findingLog.log, { findingId: "sku-returns", text: "Paused ads, supplier fixing the batch", status: "resolved" })
    const entries = await as.query(api.findingLog.list, { findingId: "sku-returns" })
    expect(entries[0].text).toBe("Paused ads, supplier fixing the batch")
  })
})

describe("dashboard.insights — accountability-overdue finding", () => {
  it("surfaces open accountability cases once they pass the SLA, grouped by team", async () => {
    const { t, as } = await setup()
    const overdueAt = Date.now() - (SLA_DAYS + 1) * 86400000
    const freshAt = Date.now() - 1 * 3600000
    await t.run((ctx) =>
      ctx.db.insert("opsFlags", { reason: "Wrong size sent", team: "Fulfillment", status: "open", raisedByName: "Care Agent", raisedAt: overdueAt }),
    )
    await t.run((ctx) =>
      ctx.db.insert("opsFlags", { reason: "Ad claim complaint", team: "Marketing", status: "open", raisedByName: "Care Agent", raisedAt: overdueAt - 86400000 }),
    )
    // Not overdue yet — must not appear in the finding.
    await t.run((ctx) =>
      ctx.db.insert("opsFlags", { reason: "Just raised", team: "Fulfillment", status: "open", raisedByName: "Care Agent", raisedAt: freshAt }),
    )

    await t.action(internal.actionCenter.run, {})
    const data = await as.action(api.dashboard.insights, {})
    const finding = data.findings.find((f: any) => f.id === "accountability-overdue")
    expect(finding).toBeTruthy()
    expect(finding.problem).toContain("2 accountability cases")
    expect(finding.team.sort()).toEqual(["Fulfillment", "Marketing"])
    expect(finding.detail.join(" ")).toContain("Ad claim complaint")
  })

  it("omits the finding entirely when nothing is overdue", async () => {
    const { t, as } = await setup()
    await t.run((ctx) =>
      ctx.db.insert("opsFlags", { reason: "Just raised", team: "Fulfillment", status: "open", raisedByName: "Care Agent", raisedAt: Date.now() }),
    )
    await t.action(internal.actionCenter.run, {})
    const data = await as.action(api.dashboard.insights, {})
    expect(data.findings.find((f: any) => f.id === "accountability-overdue")).toBeUndefined()
  })
})

// Sanity check that the internal digest query this finding relies on is still shaped the way buildInsights expects.
describe("accountability.openForDigest shape", () => {
  it("returns rows with raisedAt and team for every open flag", async () => {
    const { t } = await setup()
    await t.run((ctx) => ctx.db.insert("opsFlags", { reason: "x", team: "Fulfillment", status: "open", raisedByName: "A", raisedAt: Date.now() }))
    const out = await t.query(internal.accountability.openForDigest, {})
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].team).toBe("Fulfillment")
  })
})

describe("actionCenter daily AI check", () => {
  it("adds a stuck-order problem, puts the order back on the call list, then closes the card itself once it's cleared", async () => {
    const { t, as } = await setup()
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Veyron Loafer", active: true, variants: [{ sku: "VL-42", title: "42", weightKg: 0.5, price: 1900, purchasePrice: 700, active: true }] })
    const v42 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "VL-42")).unique()))!
    const r = await as.mutation(api.orders.create, { source: "Website", customerName: "Karim", phone: "01711000099", address: "House 1, Road 2, Dhanmondi, Dhaka", locationId, deliveryType: "regular", items: [{ variantId: v42._id, qty: 1, price: 1900, discount: 0 }], discount: 0, deliveryFee: 90, advanceAmount: 0, advanceMethod: "bKash", approve: false })
    await t.run(async (ctx) => ctx.db.patch(r.orderId, { status: "pending", statusChangedAt: Date.now() - 2 * 86400000, followUpAt: undefined }))

    await t.action(internal.actionCenter.run, {})
    let list = await as.query(api.actionCenter.list, {})
    const card = list.items.find((i) => i.key === "stuck:confirm")!
    expect(card.status).toBe("open")
    expect(card.mode).toBe("auto")
    expect(card.aiLog.map((l) => l.text).join(" ")).toContain("back on the call list")
    expect(((await t.run((ctx) => ctx.db.get(r.orderId))) as any).followUpAt).toBeLessThanOrEqual(Date.now())
    expect(list.run.added).toBeGreaterThanOrEqual(1)

    await t.run(async (ctx) => ctx.db.patch(r.orderId, { status: "approved", statusChangedAt: Date.now() }))
    await t.action(internal.actionCenter.run, {})
    list = await as.query(api.actionCenter.list, {})
    const after = list.items.find((i) => i.key === "stuck:confirm")!
    expect(after.status).toBe("fixed")
    expect(after.aiLog.at(-1)!.text).toContain("AI closed it")
    expect(list.run.fixed).toBe(1)
  })
})
