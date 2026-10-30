import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { cleanCodes } from "../../convex/checkouts"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** One staff user with full access. */
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "care@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Care Agent" })).toBe("ok")
  return { t, as }
}

/** A cart exactly as the OLD code wrote it: no isArchived, no notes, no discountCodes, no recoveryStatus.
 *  This is the shape of every legacy row already in production. */
async function legacyCart(t: ReturnType<typeof makeT>, over: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("checkouts", {
      checkoutId: "legacy-1",
      customerName: "Old Customer",
      phone: "01712345678",
      address: "Old address, Dhaka",
      items: [],
      subtotal: 0,
      discount: 0,
      deliveryFee: 90,
      total: 90,
      shopCreatedAt: Date.now() - 3600000,
      shopUpdatedAt: Date.now() - 3600000,
      status: "open",
      callCount: 0,
      ...over,
    } as any),
  )
}

describe("abandoned queue — archiving a legacy record", () => {
  it("archives a row that has no isArchived field at all", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)

    // The legacy row genuinely has no field — this is the case the whole design has to survive.
    const before = await t.run((ctx) => ctx.db.get(id))
    expect(before!.isArchived).toBeUndefined()

    const res = await as.mutation(api.checkouts.archive, { id, reason: "duplicate" })
    expect(res.alreadyArchived).toBe(false)

    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.isArchived).toBe(true)
    expect(after!.archivedBy).toBe("Care Agent")
    expect(after!.archiveReason).toBe("duplicate")
    expect(typeof after!.archivedAt).toBe("number")
    // Soft delete: the record and its data are still there.
    expect(after!.customerName).toBe("Old Customer")
    expect(after!.phone).toBe("01712345678")
  })

  it("treats a legacy row (no field) as active — it still shows in the working queue", async () => {
    const { t, as } = await setup()
    await legacyCart(t)
    const rows = await as.query(api.checkouts.list, { tab: "new" })
    expect(rows).toHaveLength(1)
    expect(rows![0]!.customerName).toBe("Old Customer")
  })

  it("hides an archived row from every working tab and shows it in Archived", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.archive, { id })

    expect(await as.query(api.checkouts.list, { tab: "new" })).toHaveLength(0)
    expect(await as.query(api.checkouts.list, { tab: "followup" })).toHaveLength(0)
    const archived = await as.query(api.checkouts.list, { tab: "archived" })
    expect(archived).toHaveLength(1)
    expect(archived![0]!._id).toBe(id)
  })

  it("is idempotent — archiving twice does not throw or double-log", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.archive, { id })
    const second = await as.mutation(api.checkouts.archive, { id })
    expect(second.alreadyArchived).toBe(true)
    const log = await as.query(api.checkouts.auditFor, { id })
    expect(log).toHaveLength(1)
  })

  it("restores an archived row back into the queue", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.archive, { id })
    await as.mutation(api.checkouts.unarchive, { id })
    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.isArchived).toBe(false)
    expect(await as.query(api.checkouts.list, { tab: "new" })).toHaveLength(1)
  })

  it("refuses to log a call or convert an archived cart", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.archive, { id })
    await expect(as.mutation(api.checkouts.logCall, { id, outcome: "No answer" })).rejects.toThrow(/archived/i)
    await expect(
      as.mutation(api.checkouts.convert, { id, customerName: "X", phone: "01712345678", address: "Y", deliveryFee: 90, status: "approved" }),
    ).rejects.toThrow(/archived/i)
  })
})

describe("abandoned queue — audit log", () => {
  it("writes an audit entry naming who archived the record and when", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    const before = Date.now()
    await as.mutation(api.checkouts.archive, { id, reason: "invalid phone" })

    const log = await as.query(api.checkouts.auditFor, { id })
    expect(log).toHaveLength(1)
    expect(log![0]!.action).toBe("archive")
    expect(log![0]!.byName).toBe("Care Agent")
    expect(log![0]!.reason).toBe("invalid phone")
    expect(log![0]!.at).toBeGreaterThanOrEqual(before)
    expect(log![0]!.checkoutId).toBe(id)
  })

  it("logs a modify with the field names that changed, and an unarchive", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.modify, { id, customerName: "New Name", notes: "called twice" })
    await as.mutation(api.checkouts.archive, { id })
    await as.mutation(api.checkouts.unarchive, { id })

    const log = await as.query(api.checkouts.auditFor, { id })
    expect(log!.map((l) => l.action)).toEqual(["unarchive", "archive", "modify"]) // newest first
    const modifyEntry = log!.find((l) => l.action === "modify")!
    expect(modifyEntry.fields).toEqual(["customerName", "notes"])
    // Values are never copied into the audit trail — only field names.
    expect(JSON.stringify(modifyEntry)).not.toContain("New Name")
  })

  it("keeps the audit trail append-only across repeated edits", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await as.mutation(api.checkouts.modify, { id, notes: "first" })
    await as.mutation(api.checkouts.modify, { id, notes: "second" })
    const log = await as.query(api.checkouts.auditFor, { id })
    expect(log).toHaveLength(2)
  })
})

describe("abandoned queue — modify on a record with missing fields", () => {
  it("edits a legacy row that has no notes and no discountCodes", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    const before = await t.run((ctx) => ctx.db.get(id))
    expect(before!.notes).toBeUndefined()
    expect(before!.discountCodes).toBeUndefined()

    const res = await as.mutation(api.checkouts.modify, {
      id, notes: "Customer wants size 43", discountCodes: ["save10", "SAVE10", " eid200 "],
    })
    expect(res.changed).toEqual(["notes", "discountCodes"])

    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.notes).toBe("Customer wants size 43")
    // upper-cased and de-duplicated
    expect(after!.discountCodes).toEqual(["SAVE10", "EID200"])
    expect(after!.editedBy).toBe("Care Agent")
  })

  it("clears a field when the agent empties it", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t, { notes: "old note", discountCodes: ["OLD"] })
    await as.mutation(api.checkouts.modify, { id, notes: "", discountCodes: [] })
    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.notes).toBeUndefined()
    expect(after!.discountCodes).toBeUndefined()
  })

  it("only patches the fields that were sent — untouched fields keep their value", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t, { notes: "keep me", recoveryStatus: "Contacted" })
    await as.mutation(api.checkouts.modify, { id, customerName: "Renamed" })
    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.customerName).toBe("Renamed")
    expect(after!.notes).toBe("keep me")
    expect(after!.recoveryStatus).toBe("Contacted")
  })

  it("rejects an invalid phone but accepts an empty one", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await expect(as.mutation(api.checkouts.modify, { id, phone: "12345" })).rejects.toThrow(/phone/i)
    await as.mutation(api.checkouts.modify, { id, phone: "" })
    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.phone).toBe("")
  })

  it("rejects an empty customer name", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    await expect(as.mutation(api.checkouts.modify, { id, customerName: "   " })).rejects.toThrow(/name/i)
  })

  it("reports no change when nothing actually differs", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t)
    const res = await as.mutation(api.checkouts.modify, { id, customerName: "Old Customer" })
    expect(res.changed).toEqual([])
    expect(await as.query(api.checkouts.auditFor, { id })).toHaveLength(0)
  })
})

describe("abandoned queue — discount code normalisation", () => {
  it("uppercases, trims, de-duplicates and drops blanks", () => {
    expect(cleanCodes([" save10 ", "SAVE10", "", "  ", "eid200"])).toEqual(["SAVE10", "EID200"])
  })
  it("returns undefined for an empty or missing list", () => {
    expect(cleanCodes([])).toBeUndefined()
    expect(cleanCodes(undefined)).toBeUndefined()
  })
  it("caps the list at 10 codes", () => {
    const many = Array.from({ length: 20 }, (_, i) => `CODE${i}`)
    expect(cleanCodes(many)).toHaveLength(10)
  })
})

describe("abandoned queue — archived carts survive Shopify sync", () => {
  it("does not resurrect an archived cart when Shopify sends it again", async () => {
    const { t, as } = await setup()
    const id = await legacyCart(t, { checkoutId: "shop-1" })
    await as.mutation(api.checkouts.archive, { id })

    await t.mutation((await import("../../convex/_generated/api")).internal.checkouts.upsertFromShopify, {
      checkoutId: "shop-1", customerName: "Old Customer", phone: "01712345678", address: "New address",
      items: [], subtotal: 0, discount: 0, deliveryFee: 90, total: 90,
      shopCreatedAt: Date.now() - 3600000, shopUpdatedAt: Date.now(), completed: false,
    })

    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.isArchived).toBe(true)
    expect(after!.address).toBe("Old address, Dhaka") // untouched
  })
})
