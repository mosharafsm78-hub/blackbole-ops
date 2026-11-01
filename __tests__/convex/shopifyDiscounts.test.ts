import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

afterEach(() => vi.unstubAllGlobals())

/** A Marketing OS clearance code (LASTPAIRS10) must exist at the Shopify checkout, scoped to the clearance products. */
describe("clearance codes in Shopify", () => {
  it("creates the code in Shopify for the products by handle, and updates it when it already exists", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx) => {
      await ctx.db.insert("settings", { key: "shopifyApi", value: { shop: "x.myshopify.com", clientId: "c", on: true } })
      await ctx.db.insert("settings", { key: "shopifyApiSecret", value: "shpat_test" })
    })
    await t.mutation(internal.discounts.upsertMarketing, { code: "LASTPAIRS10", title: "Last pairs – 10% off", percent: 10, handles: ["jacques-black", "street-sage"], days: 7 })
    let exists = false
    const calls: { q: string; v: any }[] = []
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      const { query, variables } = JSON.parse(init.body)
      calls.push({ q: query, v: variables })
      let data: any = {}
      if (query.includes("products(first:50")) data = { products: { nodes: [{ id: "gid://p/1", handle: "jacques-black" }, { id: "gid://p/2", handle: "street-sage" }] } }
      else if (query.includes("codeDiscountNodeByCode")) data = { codeDiscountNodeByCode: exists ? { id: "gid://d/1" } : null }
      else if (query.includes("discountCodeBasicCreate")) data = { discountCodeBasicCreate: { userErrors: [], codeDiscountNode: { id: "gid://d/1" } } }
      else if (query.includes("discountCodeBasicUpdate")) data = { discountCodeBasicUpdate: { userErrors: [] } }
      return new Response(JSON.stringify({ data }), { status: 200 })
    })
    expect(await t.action(internal.shopifyDiscounts.syncAll, {})).toEqual({ LASTPAIRS10: "ok (2 products)" })
    const create = calls.find((c) => c.q.includes("discountCodeBasicCreate"))!
    expect(create.v.input).toMatchObject({ code: "LASTPAIRS10", customerGets: { value: { percentage: 0.1 }, items: { products: { productsToAdd: ["gid://p/1", "gid://p/2"] } } } })
    exists = true; calls.length = 0
    await t.action(internal.shopifyDiscounts.syncAll, {})
    expect(calls.some((c) => c.q.includes("discountCodeBasicUpdate"))).toBe(true)
    expect(calls.some((c) => c.q.includes("discountCodeBasicCreate"))).toBe(false)
  })
})
