import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
afterEach(() => vi.unstubAllGlobals())
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

/** Shopify → Ops: marketing edits in Shopify reach Ops; Ops edits are never overwritten by an old Shopify value. */
async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const ids = await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", { name: "Pair", active: true, createdAt: 1, handle: "pair", web: { title: "Pair", html: "<p>old</p>", vendor: "BlackBole", type: "Sneakers", tags: ["a"], seo: { title: "t", description: "d" } } } as any)
    const variantId = await ctx.db.insert("variants", { productId, sku: "PR-40", title: "40", weightKg: 0.5, price: 2000, purchasePrice: 900, active: true, web: { price: 2000, compareAt: 3000 } } as any)
    return { productId, variantId }
  })
  return { t, ...ids }
}
const shop = (o: any = {}) => ({ handle: "pair", title: "Pair", html: "<p>old</p>", vendor: "BlackBole", type: "Sneakers", tags: ["a"], seoT: "t", seoD: "d", variants: [{ sku: "PR-40", price: 2000, compareAt: 3000 }], ...o })
const webOf = (t: any, id: any) => t.run(async (ctx: any) => (await ctx.db.get(id)).web)
const varOf = (t: any, id: any) => t.run(async (ctx: any) => (await ctx.db.get(id)).web)

describe("Shopify → Ops product sync", () => {
  it("copies a Shopify price, compare-at, title, description and tags into Ops", async () => {
    const { t, productId, variantId } = await setup()
    const r = await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop({ title: "Pair NEW", html: "<p>new</p>", tags: ["a", "sale"], variants: [{ sku: "PR-40", price: 1800, compareAt: 3200 }] }) })
    expect(r.found).toBe(true)
    expect(r.changed).toEqual(expect.arrayContaining(["title", "description", "tags", "prices"]))
    const w = await webOf(t, productId)
    expect(w).toMatchObject({ title: "Pair NEW", html: "<p>new</p>", tags: ["a", "sale"] })
    expect(await varOf(t, variantId)).toMatchObject({ price: 1800, compareAt: 3200 })
  })

  it("does not overwrite an Ops edit with an unchanged Shopify value (the snapshot protects it)", async () => {
    const { t, productId, variantId } = await setup()
    await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop() }) // first sync: snapshot taken, nothing differs
    await t.run(async (ctx) => { // someone edits the price in Ops (it is pushed to Shopify straight away, not yet pulled back)
      const vr: any = await ctx.db.get(variantId); await ctx.db.patch(variantId, { web: { ...vr.web, price: 2500 } })
      const p: any = await ctx.db.get(productId); await ctx.db.patch(productId, { web: { ...p.web, title: "Ops title" } })
    })
    const r = await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop() }) // Shopify still shows the old values
    expect(r.changed).toEqual([])
    expect((await varOf(t, variantId)).price).toBe(2500)
    expect((await webOf(t, productId)).title).toBe("Ops title")
  })

  it("Shopify wins when Shopify changed the field after the last sync", async () => {
    const { t, variantId } = await setup()
    await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop() })
    await t.run(async (ctx) => { const vr: any = await ctx.db.get(variantId); await ctx.db.patch(variantId, { web: { ...vr.web, price: 2500 } }) })
    await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop({ variants: [{ sku: "PR-40", price: 1900, compareAt: 3000 }] }) })
    expect((await varOf(t, variantId)).price).toBe(1900)
  })

  it("finds the product by SKU when the handle differs, and ignores products not in Ops", async () => {
    const { t, variantId } = await setup()
    const r = await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop({ handle: "renamed", variants: [{ sku: "PR-40", price: 1700, compareAt: 3000 }] }) })
    expect(r.found).toBe(true)
    expect((await varOf(t, variantId)).price).toBe(1700)
    expect(await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop({ handle: "nope", variants: [{ sku: "NOPE-1", price: 1, compareAt: 0 }] }) })).toMatchObject({ found: false })
  })

  it("remembers what Ops pushed, so it is not read back as a Shopify edit", async () => {
    const { t, productId, variantId } = await setup()
    await t.mutation(internal.shopifyPull.saveSnapshot, { productId, snap: { title: "Pair", html: "<p>old</p>", vendor: "BlackBole", type: "Sneakers", tags: "a", seoT: "t", seoD: "d", v: { "PR-40": [2000, 3000] } } })
    await t.run(async (ctx) => { const vr: any = await ctx.db.get(variantId); await ctx.db.patch(variantId, { web: { ...vr.web, price: 2600 } }) })
    expect((await t.mutation(internal.shopifyPull.applyFromShopify, { p: shop() })).changed).toEqual([])
    expect((await varOf(t, variantId)).price).toBe(2600)
  })

  it("the 5-minute run reads changed products from Shopify and updates Ops", async () => {
    const { t, variantId } = await setup()
    await t.run(async (ctx) => {
      await ctx.db.insert("settings", { key: "shopifyApi", value: { shop: "x.myshopify.com", clientId: "c", on: true } })
      await ctx.db.insert("settings", { key: "shopifyApiSecret", value: "shpat_test" })
    })
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { handle: "pair", title: "Pair", descriptionHtml: "<p>old</p>", vendor: "BlackBole", productType: "Sneakers", tags: ["a"], seo: { title: "t", description: "d" }, variants: { nodes: [{ sku: "PR-40", price: "1650.00", compareAtPrice: "3000.00" }] } },
    ] } } }), { status: 200 }))
    await t.action(internal.shopifyPull.run, {})
    expect((await varOf(t, variantId)).price).toBe(1650)
    const st = await t.query(internal.shopifyPull.state, {})
    expect(st.busy).toBe(0)
    expect(st.since).toBeGreaterThan(0)
  })
})
