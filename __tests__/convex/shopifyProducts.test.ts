import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

/** A product with stock in Ops that is not in Shopify yet is created there automatically (matched by SKU after). */
afterEach(() => vi.unstubAllGlobals())

function shopify(existing: Record<string, string> = {}) {
  const calls: { q: string; v: any }[] = []
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body)
    calls.push({ q: query, v: variables })
    let data: any = {}
    if (query.includes("productVariants(first: 250")) data = { productVariants: { nodes: Object.entries(existing).map(([sku, id]) => ({ sku, product: { id: "gid://p/1" }, inventoryItem: { id } })) } }
    else if (query.includes("productSet")) data = { productSet: { userErrors: [], product: { id: "gid://p/9", variants: { nodes: variables.input.variants.map((x: any, i: number) => ({ sku: x.sku, inventoryItem: { id: `gid://i/${i}` } })) } } } }
    else if (query.includes("productVariantsBulkCreate")) data = { productVariantsBulkCreate: { userErrors: [], productVariants: variables.v.map((x: any, i: number) => ({ sku: x.sku, inventoryItem: { id: `gid://n/${i}` } })) } }
    else if (query.includes("inventorySetQuantities")) data = { inventorySetQuantities: { userErrors: [] } }
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  return calls
}

async function setup(price = 1500, qty = 5) {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { key: "shopifyApi", value: { shop: "x.myshopify.com", clientId: "c", on: true } })
    await ctx.db.insert("settings", { key: "shopifyApiSecret", value: "shpat_test" })
    const locationId = await ctx.db.insert("locations", { name: "Main", isDefault: true, active: true, shopifyLocationId: "gid://loc/1" } as any)
    const productId = await ctx.db.insert("products", { name: "Test product", active: true, createdAt: 1, imageUrl: "https://img.example/a.jpg" })
    const mk = async (size: string, n: number) => {
      const variantId = await ctx.db.insert("variants", { productId, sku: `BB-TP-${size}`, title: size, weightKg: 0.4, price, purchasePrice: 700, active: true })
      await ctx.db.insert("stock", { variantId, locationId, available: n, processing: 0, inTransit: 0, returning: 0, damaged: 0 })
      return variantId
    }
    return { a: await mk("41", qty), b: await mk("42", qty) }
  })
  return { t, ...ids }
}

describe("Ops → Shopify product creation", () => {
  it("creates a new product with its sizes, price and stock, then stores the Shopify item ids", async () => {
    const calls = shopify()
    const { t, a, b } = await setup()
    await t.run((ctx) => ctx.db.insert("shopifyDirty", { variantId: a, at: 1 }))
    await t.action(internal.shopifyStock.flush, {})
    const set = calls.find((c) => c.q.includes("productSet"))!
    expect(set.v.input).toMatchObject({ title: "Test product", status: "ACTIVE" })
    expect(set.v.input.variants.map((x: any) => [x.sku, x.price])).toEqual([["BB-TP-41", "1500"], ["BB-TP-42", "1500"]])
    expect(set.v.input.variants[0].inventoryQuantities).toEqual([{ locationId: "gid://loc/1", name: "available", quantity: 5 }])
    const rows = await t.run(async (ctx) => [(await ctx.db.get(a))!.shopifyItemId, (await ctx.db.get(b))!.shopifyItemId])
    expect(rows).toEqual(["gid://i/0", "gid://i/1"])
  })

  it("does not create a product with no stock, or with a zero price, and says why", async () => {
    let calls = shopify()
    let s = await setup(1500, 0)
    await s.t.run((ctx) => ctx.db.insert("shopifyDirty", { variantId: s.a, at: 1 }))
    await s.t.action(internal.shopifyStock.flush, {})
    expect(calls.some((c) => c.q.includes("productSet"))).toBe(false)

    calls = shopify()
    s = await setup(0, 5)
    await s.t.run((ctx) => ctx.db.insert("shopifyDirty", { variantId: s.a, at: 1 }))
    await s.t.action(internal.shopifyStock.flush, {})
    expect(calls.some((c) => c.q.includes("productSet"))).toBe(false)
    const err = await s.t.run(async (ctx) => (await ctx.db.query("settings").collect()).find((x) => x.key === "shopifyApiError")?.value)
    expect(String(err)).toContain("set a selling price")
  })

  it("adds only the new size when the product is already in Shopify", async () => {
    const calls = shopify({ "BB-TP-41": "gid://i/old" })
    const { t, b } = await setup()
    await t.run((ctx) => ctx.db.insert("shopifyDirty", { variantId: b, at: 1 }))
    await t.action(internal.shopifyStock.flush, {})
    expect(calls.some((c) => c.q.includes("productSet"))).toBe(false)
    const bulk = calls.find((c) => c.q.includes("productVariantsBulkCreate"))!
    expect(bulk.v.v.map((x: any) => x.sku)).toEqual(["BB-TP-42"])
  })

  it("once Shopify holds the photo, Ops points at Shopify's copy and deletes its own file", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const { productId, fileId, storageId } = await t.run(async (ctx) => {
      await ctx.db.insert("settings", { key: "shopifyApi", value: { shop: "x.myshopify.com", clientId: "c", on: true } })
      await ctx.db.insert("settings", { key: "shopifyApiSecret", value: "shpat_test" })
      const storageId = await ctx.storage.store(new Blob(["img"]))
      const url = "https://ops.convex.cloud/api/storage/abc"
      const productId = await ctx.db.insert("products", { name: "P", active: true, createdAt: 1, imageUrl: url })
      const fileId = await ctx.db.insert("webFiles", { storageId, url, name: "a.jpg", type: "image/jpeg", size: 3, src: "product", createdAt: 1 })
      return { productId, fileId, storageId }
    })
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { product: { featuredMedia: { status: "READY", image: { url: "https://cdn.shopify.com/a.jpg" } } } } }), { status: 200 }))
    await t.action(internal.shopifyStock.adoptImage, { productId, shopifyProductId: "gid://p/1", oldUrl: "https://ops.convex.cloud/api/storage/abc", tries: 0 })
    expect(await t.run(async (ctx) => [(await ctx.db.get(productId))!.imageUrl, await ctx.db.get(fileId), await ctx.storage.getUrl(storageId)])).toEqual(["https://cdn.shopify.com/a.jpg", null, null])
  })
})

