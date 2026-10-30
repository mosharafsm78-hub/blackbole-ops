import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

/**
 * Sending damaged/wrong goods back to a supplier: stock must leave the warehouse the moment the return is
 * created (not when it's later "resolved"), and a refund/credit note must reduce what we owe the supplier
 * exactly the way a cash payment would.
 */

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id

  const supplierId = await as.mutation(api.purchasing.saveSupplier, { name: "Dhaka Footwear Factory", active: true })
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["invoice"])))
  const poId = await as.mutation(api.purchasing.savePO, {
    supplierId, locationId, lines: [{ variantId: v41._id, orderedQty: 20, unitCost: 500 }],
    discount: 0, shippingCost: 0, otherCost: 0, status: "ordered",
    supplierRef: "INV-0001", invoiceFile: { storageId, name: "invoice.pdf", type: "application/pdf" },
  })
  // 15 good units received, 5 arrived damaged — exactly the case that needs sending back.
  await as.mutation(api.purchasing.receivePO, { id: poId, lines: [{ variantId: v41._id, qty: 15, damaged: 5 }], costMode: "keep" })

  return { t, as, locationId, supplierId, poId, v41 }
}

const stockRow = (t: ReturnType<typeof makeT>, variantId: Id<"variants">, locationId: Id<"locations">) =>
  t.run((ctx) => ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", variantId).eq("locationId", locationId)).unique())

describe("creating a supplier return", () => {
  it("moves the damaged units out of the warehouse immediately, and refuses more than what's actually there", async () => {
    const { t, as, locationId, supplierId, poId, v41 } = await setup()

    const before = (await stockRow(t, v41._id, locationId))!
    expect(before.damaged).toBe(5)
    expect(before.available).toBe(15)

    const res = await as.mutation(api.supplierReturns.create, {
      supplierId, locationId, poId, reason: "Arrived damaged / not in good condition",
      items: [{ variantId: v41._id, qty: 5, bucket: "damaged" }],
    })
    expect(res.code).toBeGreaterThan(0)

    const after = (await stockRow(t, v41._id, locationId))!
    expect(after.damaged).toBe(0) // all 5 damaged units are gone — physically sent back
    expect(after.available).toBe(15) // untouched

    const list = await as.query(api.supplierReturns.listForSupplier, { supplierId })
    expect(list).toHaveLength(1)
    expect(list[0]!.status).toBe("pending")
    expect(list[0]!.totalValue).toBe(5 * 500)

    // Trying to send back more than is actually in Damaged (0 left now) must fail, not go negative.
    await expect(
      as.mutation(api.supplierReturns.create, { supplierId, locationId, poId, reason: "Second batch", items: [{ variantId: v41._id, qty: 1, bucket: "damaged" }] }),
    ).rejects.toThrow(/only 0 in Damaged/i)
  })
})

describe("resolving a supplier return", () => {
  it("a credit note reduces what we owe this supplier, same as a cash payment would", async () => {
    const { t, as, locationId, supplierId, poId, v41 } = await setup()
    const { id: id0 } = await as.mutation(api.supplierReturns.create, {
      supplierId, locationId, poId, reason: "Arrived damaged / not in good condition",
      items: [{ variantId: v41._id, qty: 5, bucket: "damaged" }],
    })
    const id = id0 as Id<"supplierReturns">

    const stBefore = await as.query(api.purchasing.supplierStatement, { id: supplierId })
    expect(stBefore!.due).toBe(20 * 500) // nothing paid yet — full PO value owed

    await as.mutation(api.supplierReturns.resolve, { id, resolution: "credited", creditedAmount: 2500 })

    const after = await t.run((ctx) => ctx.db.get(id))
    expect(after!.status).toBe("resolved")
    expect(after!.creditedAmount).toBe(2500)

    const stAfter = await as.query(api.purchasing.supplierStatement, { id: supplierId })
    expect(stAfter!.due).toBe(20 * 500 - 2500) // the credit note cleared exactly that much of the PO's due

    // Resolving twice must be refused, not silently credit the account a second time.
    await expect(as.mutation(api.supplierReturns.resolve, { id, resolution: "replaced" })).rejects.toThrow(/already resolved/i)
  })

  it("replaced or rejected need no amount and touch no money", async () => {
    const { as, supplierId, locationId, poId, v41 } = await setup()
    const { id } = await as.mutation(api.supplierReturns.create, {
      supplierId, locationId, poId, reason: "Wrong size/variant sent",
      items: [{ variantId: v41._id, qty: 5, bucket: "damaged" }],
    })
    const stBefore = await as.query(api.purchasing.supplierStatement, { id: supplierId })

    await as.mutation(api.supplierReturns.resolve, { id, resolution: "replaced", resolutionNote: "New units arriving next shipment" })

    const stAfter = await as.query(api.purchasing.supplierStatement, { id: supplierId })
    expect(stAfter!.due).toBe(stBefore!.due) // no money moved
  })

  it("refunded or credited without an amount is refused", async () => {
    const { as, supplierId, locationId, poId, v41 } = await setup()
    const { id } = await as.mutation(api.supplierReturns.create, {
      supplierId, locationId, poId, reason: "Expired",
      items: [{ variantId: v41._id, qty: 5, bucket: "damaged" }],
    })
    await expect(as.mutation(api.supplierReturns.resolve, { id, resolution: "credited" })).rejects.toThrow(/enter the amount/i)
  })
})
