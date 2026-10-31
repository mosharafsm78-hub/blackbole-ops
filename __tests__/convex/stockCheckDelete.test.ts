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
    expect(await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-D-42")).first())).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(variant.productId))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", variant._id)).collect())).toHaveLength(0)
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


describe("clear deleted SKUs", () => {
  it("removes retired sizes with no stock for good and keeps ones that hold stock", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Old", active: true, variants: [
      { sku: "BB-O-40-DELETED", title: "40", weightKg: 0.4, price: 1, purchasePrice: 1, active: false },
      { sku: "BB-O-41", title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: false },
      { sku: "BB-O-42", title: "42", weightKg: 0.4, price: 1, purchasePrice: 1, active: true },
    ] })
    const get = (sku: string) => t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first())
    const v41 = (await get("BB-O-41"))!
    await t.run((ctx) => ctx.db.insert("stock", { variantId: v41._id, locationId, available: 2, processing: 0, inTransit: 0, returning: 0, damaged: 0 } as any))
    const r = await as.mutation(api.stockCheck.purgeRetired, {})
    expect(r.purged).toBe(1)
    expect(r.kept).toBe(1)
    expect(await get("BB-O-40-DELETED")).toBeNull()
    expect(await get("BB-O-41")).not.toBeNull()
    expect(await get("BB-O-42")).not.toBeNull()
  })
})

describe("everything not counted is real", () => {
  it("counts uncounted lines as real and leaves counted test stock alone", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    await as.mutation(api.catalog.saveProduct, { name: "Real Sandal", active: true, variants: [
      { sku: "BB-R-41", title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: true },
      { sku: "BB-R-42", title: "42", weightKg: 0.4, price: 1, purchasePrice: 1, active: true },
    ] })
    const get = (sku: string) => t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first())
    const a = (await get("BB-R-41"))!, b = (await get("BB-R-42"))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: a._id, qty: 5, unitCost: 1 }, { variantId: b._id, qty: 5, unitCost: 1 }] })
    await as.mutation(api.stockCheck.saveCounts, { items: [{ variantId: b._id, locationId, real: 3 }] }) // counted: 2 test pairs
    const r = await as.mutation(api.stockCheck.markUncountedReal, {})
    expect(r.done).toBe(1)
    const row = (v: any) => t.run((ctx) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", v._id)).first())
    expect((await row(a))!.countedAt).toBeDefined()
    expect((await row(a))!.virtual ?? 0).toBe(0)
    expect((await row(b))!.virtual).toBe(2)
  })
})

describe("fake-stock filter is not cut short by pagination", () => {
  it("finds a fake-stock product even when 40 other products come before it", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    for (let i = 0; i < 40; i++) await as.mutation(api.catalog.saveProduct, { name: `Plain ${i}`, active: true, variants: [{ sku: `BB-P-${i}`, title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: true }] })
    await as.mutation(api.catalog.saveProduct, { name: "Fakey Sandal", active: true, variants: [{ sku: "BB-F-41", title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: true }] })
    const v = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-F-41")).first()))!
    await as.mutation(api.stockCheck.addTestStock, { items: [{ variantId: v._id, locationId, qty: 10 }] })
    const r = (await as.query(api.stockCheck.list, { filter: "test", cursor: null }))!
    expect(r.products.map((p) => p.name)).toEqual(["Fakey Sandal"])
    expect(r.products[0].fake).toBe(10)
  })
})

describe("counted filter", () => {
  it("lists only fully counted products", async () => {
    const t = makeT()
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
    for (const n of ["Counted One", "Not Yet Two"]) {
      await as.mutation(api.catalog.saveProduct, { name: n, active: true, variants: [{ sku: `BB-${n.slice(0, 3)}-41`, title: "41", weightKg: 0.4, price: 1, purchasePrice: 1, active: true }] })
      const v = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", `BB-${n.slice(0, 3).toUpperCase()}-41`)).first()))!
      await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v._id, qty: 4, unitCost: 1 }] })
      if (n === "Counted One") await as.mutation(api.stockCheck.saveCounts, { items: [{ variantId: v._id, locationId, real: 4 }] })
    }
    const names = async (f: "counted" | "uncounted") => ((await as.query(api.stockCheck.list, { filter: f, cursor: null }))!.products.map((p) => p.name))
    expect(await names("counted")).toEqual(["Counted One"])
    expect(await names("uncounted")).toEqual(["Not Yet Two"])
  })
})
