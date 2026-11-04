import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

const args = { productMatch: "Calder Slide Mule", from: "Beige", to: "Maroon", fromCode: "BCSM-BRN", toCode: "BCSM-MRN", handle: "calder-maroon", html: "<p>Maroon</p>", imageUrls: ["https://x/1.jpg"], fakeQty: 10 }

describe("cloneColour (new colour of an existing product)", () => {
  it("copies sizes, prices and cost, swaps colour and SKU code, adds 10 fake pairs per size, and is safe to re-run", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx) => {
      await ctx.db.insert("locations", { name: "Dhaka", isDefault: true, active: true } as any)
      const p = await ctx.db.insert("products", { name: "BlackBole Calder Slide Mule – Beige", active: true, preOrder: true, category: "Sandals", createdAt: 1 })
      for (const s of [39, 40]) await ctx.db.insert("variants", { productId: p, sku: `BB-SH-BCSM-BRN-${s}`, title: `Beige / ${s}`, attrs: `Color: Beige / Size: ${s}`, weightKg: 0.5, price: 1980, purchasePrice: 900, active: true, shopifyItemId: "gid://x" })
    })
    expect(await t.mutation(internal.catalog.cloneColour, args)).toMatchObject({ sizes: 2 })
    const out = await t.run(async (ctx) => {
      const p = (await ctx.db.query("products").collect()).find((x) => x.name.includes("Maroon"))!
      const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()
      const st = await Promise.all(vs.map((v) => ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", v._id)).first()))
      return { p, vs, st }
    })
    expect(out.p.name).toBe("BlackBole Calder Slide Mule – Maroon")
    expect(out.p.preOrder).toBeUndefined()
    expect(out.vs.map((v) => v.sku).sort()).toEqual(["BB-SH-BCSM-MRN-39", "BB-SH-BCSM-MRN-40"])
    expect(out.vs.every((v) => v.price === 1980 && v.purchasePrice === 900 && v.weightKg === 0.5 && !v.shopifyItemId && v.title.startsWith("Maroon"))).toBe(true)
    expect(out.st.every((s) => s?.available === 10 && s?.virtual === 10)).toBe(true)
    expect(await t.mutation(internal.catalog.cloneColour, args)).toEqual({ skipped: "already exists" })
  })
})
