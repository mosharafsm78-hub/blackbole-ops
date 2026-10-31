import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

const makeT = () => convexTest(schema, import.meta.glob("../../convex/**/*.*s"))

describe("stock check: not needed for now / delete product", () => {
  it("hides a skipped product from the count lists, brings it back, and deletes it", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Old Sandal", active: true, variants: [{ sku: "BB-D-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-D-42")).unique()))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: variant._id, qty: 3, unitCost: 520 }] })
    const names = async (filter: "uncounted" | "all") => ((await as.query(api.stockCheck.list, { filter, cursor: null }))!.products.map((p) => p.name))
    expect(await names("uncounted")).toContain("Old Sandal")
    await as.mutation(api.stockCheck.skipProduct, { productId: variant.productId, skip: true })
    expect(await names("uncounted")).not.toContain("Old Sandal")
    expect(await names("all")).toContain("Old Sandal")
    await as.mutation(api.stockCheck.skipProduct, { productId: variant.productId, skip: false })
    expect(await names("uncounted")).toContain("Old Sandal")
    await as.mutation(api.stockCheck.deleteProduct, { productId: variant.productId })
    expect(await names("all")).not.toContain("Old Sandal")
  })

  it("refuses to delete a product that is on an open order", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Busy Sandal", active: true, variants: [{ sku: "BB-E-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
    const variant = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-E-42")).unique()))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: variant._id, qty: 3, unitCost: 520 }] })
    await as.mutation(api.orders.create, {
      source: "Facebook", customerName: "A", phone: "+8801711000000", address: "House 7, Dhanmondi", locationId, deliveryType: "pickup",
      items: [{ variantId: variant._id, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })
    await expect(as.mutation(api.stockCheck.deleteProduct, { productId: variant.productId })).rejects.toThrow(/open order/)
  })

  it("deletes one size only, and keeps the last size", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Sized Sandal", active: true, variants: [
      { sku: "BB-S-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-S-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ] })
    const get = (sku: string) => t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).unique())
    const v41 = (await get("BB-S-41"))!, v42 = (await get("BB-S-42"))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 2, unitCost: 520 }, { variantId: v42._id, qty: 2, unitCost: 520 }] })
    await as.mutation(api.stockCheck.deleteSize, { variantId: v41._id })
    const p = (await as.query(api.stockCheck.list, { filter: "all", cursor: null }))!.products.find((x) => x.name === "Sized Sandal")!
    expect(p.lines.map((l) => l.title)).toEqual(["42"])
    await expect(as.mutation(api.stockCheck.deleteSize, { variantId: v42._id })).rejects.toThrow(/only size left/)
  })
})

describe("inventory hides retired sizes", () => {
  it("does not list deleted sizes or deleted products with no stock", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    await as.mutation(api.catalog.saveProduct, { name: "Gone Sandal", active: true, variants: [
      { sku: "BB-G-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-G-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ] })
    await as.mutation(api.catalog.saveProduct, { name: "Kept Sandal", active: true, variants: [{ sku: "BB-K-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
    const skus = async () => ((await as.query(api.catalog.inventory, {}))!.rows.map((r) => r.sku))
    expect(await skus()).toEqual(expect.arrayContaining(["BB-G-41", "BB-G-42", "BB-K-41"]))
    const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-G-41")).unique()))!
    await as.mutation(api.stockCheck.deleteSize, { variantId: v41._id })
    expect(await skus()).not.toContain("BB-G-41")
    await as.mutation(api.stockCheck.deleteProduct, { productId: v41.productId })
    const after = await skus()
    expect(after).not.toContain("BB-G-42")
    expect(after).toContain("BB-K-41")
  })
})
