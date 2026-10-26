import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { EXPORT_URL } from "../../convex/website"

const FEED_KEY = "feed-key-for-tests-0123456789"

// Small fixture in the site's catalog-export.json shape
const EXPORT = {
  products: [
    {
      id: "gid://shopify/Product/111", handle: "harbor-shore-sandal", title: "Harbor Shore Sandal", html: "<p>Comfy</p>",
      vendor: "BlackBole", type: "Sandals", tags: ["men", "pre-order"], category: null,
      seo: { title: "Harbor", description: "Sandal" }, options: [{ name: "Size", values: ["41", "42"] }],
      images: [{ url: "https://blackbole-site.pages.dev/img/a-1200.webp", alt: "Harbor", w: 1200, h: 1200 }],
      mf: { "bb26.short": "Light and soft", "bb26.pre_days": "15" }, createdAt: "2025-01-01T00:00:00Z", publishedAt: "2025-01-02T00:00:00Z",
      variants: [
        { id: "4529001", title: "41", sku: "bb-hss-41 ", price: 1480, compareAt: 1800, options: { Size: "41" }, available: true, image: null },
        { id: "4529002", title: "42", sku: "BB-HSS-42", price: 1480, compareAt: 1800, options: { Size: "42" }, available: true, image: null },
      ],
    },
    {
      id: "gid://shopify/Product/222", handle: "city-loafer", title: "City Loafer", html: "", vendor: "BlackBole", type: "Loafers",
      tags: [], category: null, seo: { title: "", description: "" }, options: [{ name: "Size", values: ["40"] }], images: [], mf: {},
      createdAt: "2025-01-01T00:00:00Z", publishedAt: "2025-01-02T00:00:00Z",
      variants: [{ id: "4529100", title: "40", sku: "BB-CL-40", price: 2200, compareAt: null, options: { Size: "40" }, available: true, image: null }],
    },
  ],
  collections: [{ handle: "men", title: "Men", html: "", image: null, seo: { title: "", description: "" }, productHandles: ["city-loafer", "harbor-shore-sandal", "gone"] }],
}

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [
      { sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-HSS-42", title: "42", weightKg: 0.4, price: 1500, purchasePrice: 500, active: true },
    ],
  })
  return { t, as }
}

function stubExport() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url) === EXPORT_URL) return new Response(JSON.stringify(EXPORT), { status: 200 })
    return new Response("nope", { status: 404 })
  }))
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("website catalog", () => {
  it("imports by SKU, creates what's missing, and is idempotent", async () => {
    const { t, as } = await setup()
    stubExport()
    const r1 = await as.action(api.website.importCatalog, {})
    expect(r1).toMatchObject({ products: 2, created: 1, updated: 1, variantsMatched: 2, variantsCreated: 1, collections: 1 })
    const r2 = await as.action(api.website.importCatalog, {})
    expect(r2).toMatchObject({ created: 0, updated: 2, variantsMatched: 3, variantsCreated: 0 })

    const counts = await t.run(async (ctx) => ({
      products: (await ctx.db.query("products").collect()).length,
      variants: (await ctx.db.query("variants").collect()).length,
      collections: (await ctx.db.query("webCollections").collect()).length,
    }))
    expect(counts).toEqual({ products: 2, variants: 3, collections: 1 })
    const loafer = await t.run(async (ctx) => (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-CL-40")).first())!)
    expect(loafer).toMatchObject({ weightKg: 0.5, purchasePrice: 0, active: true, price: 2200 })
  })

  it("serves only published products with Ops prices, behind the feed key", async () => {
    const { t, as } = await setup()
    stubExport()
    await as.action(api.website.importCatalog, {})
    vi.unstubAllGlobals()
    expect((await t.fetch("/website/catalog", { headers: { "X-Feed-Key": FEED_KEY } })).status).toBe(401)
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)

    const loafer = await t.run(async (ctx) => (await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", "city-loafer")).first())!)
    await as.mutation(api.website.setPublished, { id: loafer._id, published: false })

    const data = await (await t.fetch("/website/catalog", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(data.products.map((p: any) => p.handle)).toEqual(["harbor-shore-sandal"])
    const p = data.products[0]
    expect(p).toMatchObject({ id: "gid://shopify/Product/111", title: "Harbor Shore Sandal", mf: { "bb26.short": "Light and soft" } })
    expect(p.options).toEqual([{ name: "Size", values: ["41", "42"] }])
    // price comes from Ops (1500), not the export (1480); id and compare-at from the website
    expect(p.variants[1]).toMatchObject({ id: "4529002", sku: "BB-HSS-42", price: 1500, compareAt: 1800, options: { Size: "42" } })
    // no stock but tagged pre-order → available
    expect(p.variants.every((x: any) => x.available)).toBe(true)
    // unpublished and unknown handles are left out of collections
    expect(data.collections[0].productHandles).toEqual(["harbor-shore-sandal"])
  })

  it("editor saves compare-at, options, collections and queues one rebuild", async () => {
    const { t, as } = await setup()
    stubExport()
    await as.action(api.website.importCatalog, {})
    const id = await t.run(async (ctx) => (await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", "harbor-shore-sandal")).first())!._id)
    const ed = (await as.query(api.website.product, { id }))!
    const handle = await as.mutation(api.website.saveProduct, {
      id, handle: "harbor-sandal", title: "Harbor Sandal", html: "<p>x</p>", vendor: "BlackBole", type: "Sandals", tags: ["men"],
      seo: { title: "", description: "" }, options: ["Size"], images: [], mf: { "bb26.short": "New line" }, published: true,
      variants: ed.variants.map((x) => ({ id: x._id, compareAt: 2000, options: { Size: x.title } })),
      collections: [],
    })
    expect(handle).toBe("harbor-sandal")
    const after = (await as.query(api.website.collections, {}))!
    expect(after.collections[0].productHandles).toEqual(["city-loafer", "gone"])
    const st = (await as.query(api.website.status, {}))!
    expect(st.rebuild?.pending).toBe(true)
    expect(st.hook).toBe(false)
  })
})
