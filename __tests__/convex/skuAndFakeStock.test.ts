import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

const args = { handle: "brz", title: "Brinkley Bronze", skuPrefix: "BB-SN-BBSFN-BRZ", sizes: ["39", "40"], weightKg: 0.2, fakeQty: 10, price: 1980, costFrom: "Khaki Green" }

describe("skuAndFakeStock", () => {
  it("renames WEB- placeholders to real SKUs, sets weight, copies cost, adds 10 fake pairs per size", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx) => {
      await ctx.db.insert("locations", { name: "Dhaka", isDefault: true, active: true } as any)
      const p = await ctx.db.insert("products", { name: "Brinkley Bronze", handle: "brz", active: true, createdAt: 1 })
      for (const s of [39, 40]) await ctx.db.insert("variants", { productId: p, sku: `WEB-${s}1`, title: `Bronze / ${s}`, weightKg: 0.5, price: 1980, purchasePrice: 0, active: true })
      const k = await ctx.db.insert("products", { name: "Brinkley Khaki Green", active: true, createdAt: 1 })
      for (const s of [39, 40]) await ctx.db.insert("variants", { productId: k, sku: `BB-SN-BBSFN-KGF-${s}`, title: `${s}`, weightKg: 0.2, price: 1580, purchasePrice: 700, active: true })
    })
    expect(await t.mutation(internal.catalog.skuAndFakeStock, args)).toMatchObject({ sizes: 2, created: false })
    const out = await t.run(async (ctx) => {
      const p = (await ctx.db.query("products").collect()).find((x) => x.handle === "brz")!
      const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()
      const st = await Promise.all(vs.map((v) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", v._id)).first()))
      return { vs, st }
    })
    expect(out.vs.map((v) => v.sku).sort()).toEqual(["BB-SN-BBSFN-BRZ-39", "BB-SN-BBSFN-BRZ-40"])
    expect(out.vs.every((v) => v.weightKg === 0.2 && v.purchasePrice === 700)).toBe(true)
    expect(out.st.every((s) => s?.available === 10 && s?.virtual === 10)).toBe(true)
  })
})
