import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { matchByName } from "../../convex/checkouts"

describe("match product by name + size", () => {
  it("finds the right colour among look-alike names", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx) => {
      const out: Record<string, any> = {}
      for (const name of ["BlackBole Harbor Shore Sandal For Men - Brown", "BlackBole Harbor Shore Sandal For Men - Combo", "BlackBole Harbor Shore Sandal For Men - Black", "BlackBole Harbor Shore Sandal For Men - Black New", "BlackBole Pathfinder"]) {
        const p = await ctx.db.insert("products", { name, active: true, createdAt: 0 })
        for (const s of ["42", "43"]) out[`${name}|${s}`] = await ctx.db.insert("variants", { productId: p, sku: `${name}-${s}`, title: s, weightKg: 0.5, price: 1, purchasePrice: 0, active: true })
      }
      const old = await ctx.db.insert("products", { name: "BlackBole Harbor Shore Sandal For Men - Black", active: true, createdAt: 0 })
      await ctx.db.insert("variants", { productId: old, sku: "OLD-43-DELETED", title: "43", weightKg: 0.5, price: 1, purchasePrice: 0, active: true })
      const g = await ctx.db.insert("products", { name: "BlackBole Pathfinder Boot", active: true, createdAt: 0 })
      out.grey43 = await ctx.db.insert("variants", { productId: g, sku: "PF-GREY-43", title: "Grey / 43", weightKg: 0.5, price: 1, purchasePrice: 0, active: true })
      return out
    })
    const got = await t.run((ctx) => matchByName(ctx, "BlackBole Harbor Shore Sandal For Men - Black", "EU 43"))
    expect(got?.sku).toBe("BlackBole Harbor Shore Sandal For Men - Black-43")
    const grey = await t.run((ctx) => matchByName(ctx, "BlackBole Pathfinder Boot - Grey", "43"))
    expect(grey?.sku).toBe("PF-GREY-43")
    expect(await t.run((ctx) => matchByName(ctx, "Something else", "43"))).toBeNull()
  })
})
