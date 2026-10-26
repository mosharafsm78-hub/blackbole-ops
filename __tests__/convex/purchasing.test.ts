import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  const supplierId = await as.mutation(api.purchasing.saveSupplier, { name: "Guangzhou Factory", active: true })
  const created = await as.mutation(api.purchasing.createProductWithSizes, {
    name: "BlackBole Harbor Shore Sandal For Men - Black", category: "Sandals", price: 1480, purchasePrice: 0, weightKg: 0.4,
    attrLabel: "Size", variants: [{ title: "41", sku: "BB-SH-HSS-BLACK-41" }, { title: "42", sku: "BB-SH-HSS-BLACK-42" }],
  })
  return { t, as, locationId, supplierId, v41: created.variants[0].variantId, v42: created.variants[1].variantId }
}

const fakeFile = async (t: ReturnType<typeof makeT>) => ({
  storageId: await t.run((ctx) => ctx.storage.store(new Blob(["slip"]))), name: "slip.png", type: "image/png",
})

const stockOf = (t: ReturnType<typeof makeT>, variantId: any) =>
  t.run((ctx) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", variantId)).first())

describe("purchases", () => {
  it("receives in parts, splits damaged units, and tracks supplier due", async () => {
    const { t, as, locationId, supplierId, v41, v42 } = await setup()
    const id = await as.mutation(api.purchasing.savePO, {
      supplierId, locationId, lines: [{ variantId: v41, orderedQty: 10, unitCost: 500 }, { variantId: v42, orderedQty: 10, unitCost: 500 }],
      discount: 0, shippingCost: 1000, otherCost: 0, status: "ordered", supplierRef: "PI-1", invoiceFile: await fakeFile(t),
    })
    // 10000 goods + 1000 shipping = 11000, landed cost 550 per pair
    let po = (await as.query(api.purchasing.getPO, { id }))!
    expect(po.missing).toBe(false)
    if (po.missing) return
    expect(po.po.total).toBe(11000)

    await as.mutation(api.purchasing.receivePO, { id, costMode: "average", lines: [{ variantId: v41, qty: 8, damaged: 2 }, { variantId: v42, qty: 4, damaged: 0 }] })
    expect(await stockOf(t, v41)).toMatchObject({ available: 8, damaged: 2 })
    expect(await stockOf(t, v42)).toMatchObject({ available: 4 })
    const v = await t.run((ctx) => ctx.db.get(v41))
    expect((v as any).purchasePrice).toBe(550)

    po = (await as.query(api.purchasing.getPO, { id }))!
    if (po.missing) return
    expect(po.po.status).toBe("partial")
    // can't receive more than ordered
    await expect(as.mutation(api.purchasing.receivePO, { id, costMode: "average", lines: [{ variantId: v42, qty: 7, damaged: 0 }] })).rejects.toThrow()
    await as.mutation(api.purchasing.receivePO, { id, costMode: "average", lines: [{ variantId: v42, qty: 6, damaged: 0 }] })
    po = (await as.query(api.purchasing.getPO, { id }))!
    if (po.missing) return
    expect(po.po.status).toBe("received")

    await as.mutation(api.purchasing.addSupplierPayment, { id, amount: 4000, method: "Bank transfer", slipId: (await fakeFile(t)).storageId })
    const sup = (await as.query(api.purchasing.listSuppliers, {})).find((s) => s._id === supplierId)!
    expect(sup).toMatchObject({ purchased: 11000, paid: 4000, due: 7000 })

    // supplier-level payment: previous due first, then oldest purchase, extra becomes advance
    await as.mutation(api.purchasing.saveSupplier, { id: supplierId, name: "Guangzhou Factory", openingDue: 2000, active: true })
    const r = await as.mutation(api.purchasing.paySupplier, { id: supplierId, amount: 10000, method: "Cash", slipId: (await fakeFile(t)).storageId })
    expect(r.applied).toEqual(["previous due 2000", "PO-0001 7000", "advance 1000"])
    const st = (await as.query(api.purchasing.supplierStatement, { id: supplierId }))!
    expect(st.due).toBe(-1000)
    expect(st.advance).toBe(1000)
    expect(st.rows[0].balance).toBe(-1000)
  })

  it("matches an uploaded supplier list by SKU and by name + size", async () => {
    const { as } = await setup()
    const m = await as.query(api.purchasing.matchLines, {
      lines: [{ sku: "bb-sh-hss-black-42" }, { name: "BlackBole Harbor Shore Sandal For Men - Black", size: "41" }, { name: "Unknown boot", size: "40" }],
    })
    expect(m[0]?.sku).toBe("BB-SH-HSS-BLACK-42")
    expect(m[1]?.sku).toBe("BB-SH-HSS-BLACK-41")
    expect(m[2]).toBeNull()
  })

  it("supplier summary shows pairs, shoes, paid and due for the dates", async () => {
    const { t, as, locationId, supplierId, v41, v42 } = await setup()
    const id = await as.mutation(api.purchasing.savePO, {
      supplierId, locationId, lines: [{ variantId: v41, orderedQty: 12, unitCost: 500 }, { variantId: v42, orderedQty: 8, unitCost: 500 }],
      discount: 0, shippingCost: 0, otherCost: 0, status: "ordered", supplierRef: "PI-2", invoiceFile: await fakeFile(t),
    })
    await as.mutation(api.purchasing.addSupplierPayment, { id, amount: 3000, method: "bKash", reference: "TRX1", slipId: (await fakeFile(t)).storageId })
    const day = 86400000
    const sum = (await as.query(api.purchasing.summary, { from: Date.now() - day, to: Date.now() + day }))!
    expect(sum.totals).toMatchObject({ purchases: 1, pairs: 20, received: 0, value: 10000, paid: 3000, dueNow: 7000 })
    expect(sum.purchases[0]).toMatchObject({ pairs: 20, paid: 3000, due: 7000 })
    expect(sum.products[0]).toMatchObject({ ordered: 20, sizes: "41: 12, 42: 8" })
    expect(sum.payments[0]).toMatchObject({ amount: 3000, method: "bKash", supplier: "Guangzhou Factory" })
    // outside the dates: nothing ordered or paid, but what we owe stays visible
    const old = (await as.query(api.purchasing.summary, { from: 0, to: Date.now() - 10 * day }))!
    expect(old.totals).toMatchObject({ purchases: 0, pairs: 0, paid: 0, dueNow: 7000 })
  })
})

describe("purchase rules", () => {
  it("needs invoice no. + invoice file to place, and a slip for every payment", async () => {
    const { t, as, locationId, supplierId, v41 } = await setup()
    const base = { supplierId, locationId, lines: [{ variantId: v41, orderedQty: 1, unitCost: 500 }], discount: 0, shippingCost: 0, otherCost: 0 }
    await expect(as.mutation(api.purchasing.savePO, { ...base, status: "ordered" })).rejects.toThrow(/invoice/)
    await expect(as.mutation(api.purchasing.savePO, { ...base, status: "ordered", supplierRef: "PI-9" })).rejects.toThrow(/Attach the supplier invoice/)
    const draft = await as.mutation(api.purchasing.savePO, { ...base })
    await expect(as.mutation(api.purchasing.setPOStatus, { id: draft, status: "ordered" })).rejects.toThrow(/invoice/)
    const id = await as.mutation(api.purchasing.savePO, { ...base, status: "ordered", supplierRef: "PI-9", invoiceFile: await fakeFile(t) })
    await expect(as.mutation(api.purchasing.addSupplierPayment, { id, amount: 100, method: "Cash" })).rejects.toThrow(/slip/)
    await expect(as.mutation(api.purchasing.paySupplier, { id: supplierId, amount: 100, method: "Cash" })).rejects.toThrow(/slip/)
  })
})

describe("delete purchase", () => {
  it("takes the stock back and removes its payments", async () => {
    const { t, as, locationId, supplierId, v41 } = await setup()
    const id = await as.mutation(api.purchasing.savePO, { supplierId, locationId, lines: [{ variantId: v41, orderedQty: 3, unitCost: 100 }], discount: 0, shippingCost: 0, otherCost: 0, status: "ordered", supplierRef: "T", invoiceFile: await fakeFile(t) })
    const before = (await stockOf(t, v41))?.available ?? 0
    await as.mutation(api.purchasing.receivePO, { id, costMode: "keep", lines: [{ variantId: v41, qty: 3, damaged: 0 }] })
    await as.mutation(api.purchasing.addSupplierPayment, { id, amount: 300, method: "Cash", slipId: (await fakeFile(t)).storageId })
    expect((await stockOf(t, v41))!.available).toBe(before + 3)
    await as.mutation(api.purchasing.deletePO, { id })
    expect((await stockOf(t, v41))!.available).toBe(before)
    const st = (await as.query(api.purchasing.supplierStatement, { id: supplierId }))!
    expect(st.paid).toBe(0)
    expect(st.purchased).toBe(0)
  })
})
