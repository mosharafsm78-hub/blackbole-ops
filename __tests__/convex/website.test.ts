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
    // price is the website selling price from the export (1480), not the Ops price (1500); id and compare-at from the website
    expect(p.variants[1]).toMatchObject({ id: "4529002", sku: "BB-HSS-42", price: 1480, compareAt: 1800, options: { Size: "42" } })
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

describe("website add product", () => {
  it("creates a China pre-order: booking on the website, full price in Ops, pre-order flag, collection", async () => {
    const { t, as } = await setup()
    const coll = await t.run((ctx) => ctx.db.insert("webCollections", { handle: "pre-order", title: "Pre-order", html: "", image: null, seo: { title: "", description: "" }, productHandles: [], updatedAt: 0 }))
    const id = await as.mutation(api.website.createProduct, {
      title: "Cloud Runner", handle: "", html: "<p>Light</p>", vendor: "BlackBole", type: "Sneakers", tags: [],
      seo: { title: "", description: "" }, options: ["Size"], images: [{ url: "https://x.y/a.jpg", alt: "a", w: 1, h: 1 }], mf: {},
      published: true, preOrder: true, preOrderFrom: "china", collections: [coll],
      variants: [
        { sku: "po-cr-40", title: "40", options: { Size: "40" }, price: 500, fullPrice: 3200, compareAt: 3200, cost: 1400, weightKg: 0.6 },
        { sku: "PO-CR-41", title: "41", options: { Size: "41" }, price: 500, fullPrice: 3200, compareAt: 3200, cost: 1400, weightKg: 0.6 },
      ],
    })
    const p = await t.run((ctx) => ctx.db.get(id))
    expect(p).toMatchObject({ name: "Cloud Runner", preOrder: true, preOrderFrom: "china", handle: "cloud-runner", active: true })
    expect((p as any).web.tags).toContain("pre-order")
    const vs = await t.run((ctx) => ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", id)).collect())
    expect(vs.map((v) => [v.sku, v.price, v.purchasePrice, (v.web as any).price, (v.web as any).compareAt])).toEqual([
      ["PO-CR-40", 3200, 1400, 500, 3200], ["PO-CR-41", 3200, 1400, 500, 3200],
    ])
    const c = await t.run((ctx) => ctx.db.get(coll))
    expect(c!.productHandles).toEqual(["cloud-runner"])
    // a SKU that already exists is refused
    await expect(as.mutation(api.website.createProduct, {
      title: "Copy", handle: "", html: "", vendor: "", type: "", tags: [], seo: { title: "", description: "" }, options: ["Size"], images: [], mf: {},
      published: false, preOrder: false, preOrderFrom: "china", collections: [],
      variants: [{ sku: "BB-HSS-41", title: "41", options: { Size: "41" }, price: 1000, fullPrice: 1000, compareAt: null, cost: 0, weightKg: 0.5 }],
    })).rejects.toThrow(/already used/)
  })
})

describe("website product status, bulk edits and Shopify fields", () => {
  async function imported() {
    const { t, as } = await setup()
    stubExport()
    await as.action(api.website.importCatalog, {})
    vi.unstubAllGlobals()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const byHandle = (h: string) => t.run(async (ctx) => (await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", h)).first())!)
    return { t, as, sandal: await byHandle("harbor-shore-sandal"), loafer: await byHandle("city-loafer") }
  }
  const feed = async (t: any) => (await (await t.fetch("/website/catalog", { headers: { "X-Feed-Key": FEED_KEY } })).json()).products as any[]

  it("archives and re-activates in bulk; archived products leave the website feed", async () => {
    const { t, as, sandal, loafer } = await imported()
    await as.mutation(api.website.bulkStatus, { ids: [loafer._id], status: "archived" })
    let rows = (await as.query(api.website.products, {}))!
    expect(rows.find((r) => r._id === loafer._id)!.status).toBe("archived")
    expect(rows.find((r) => r._id === sandal._id)!.status).toBe("active")
    expect((await feed(t)).map((p) => p.handle)).toEqual(["harbor-shore-sandal"])

    await as.mutation(api.website.bulkStatus, { ids: [loafer._id], status: "draft" })
    rows = (await as.query(api.website.products, {}))!
    expect(rows.find((r) => r._id === loafer._id)!.status).toBe("draft")
    await as.mutation(api.website.bulkStatus, { ids: [loafer._id], status: "active" })
    expect((await feed(t)).map((p) => p.handle).sort()).toEqual(["city-loafer", "harbor-shore-sandal"])
  })

  it("adds and removes tags in bulk (case-insensitive), skipping products not on the website", async () => {
    const { t, as, sandal, loafer } = await imported()
    const opsOnly = await t.run((ctx) => ctx.db.insert("products", { name: "Ops only", active: true, createdAt: 0 }))
    const n = await as.mutation(api.website.bulkTags, { ids: [sandal._id, loafer._id, opsOnly], tags: ["Summer", "MEN"], add: true })
    expect(n).toBe(2)
    const tagsOf = async (id: any) => ((await t.run((ctx) => ctx.db.get(id))) as any).web?.tags
    expect(await tagsOf(sandal._id)).toEqual(["men", "pre-order", "Summer"])
    expect(await tagsOf(loafer._id)).toEqual(["Summer", "MEN"])
    expect(await tagsOf(opsOnly)).toBeUndefined()
    await as.mutation(api.website.bulkTags, { ids: [sandal._id, loafer._id], tags: ["summer", "men"], add: false })
    expect(await tagsOf(sandal._id)).toEqual(["pre-order"])
    expect(await tagsOf(loafer._id)).toEqual([])
  })

  it("editor saves status, template, category, barcode, and changes cost/weight only when sent", async () => {
    const { t, as, sandal } = await imported()
    const ed = (await as.query(api.website.product, { id: sandal._id }))!
    expect(ed.status).toBe("active")
    expect(ed.variants[0]).toMatchObject({ cost: 500, weightKg: 0.4, byLocation: {} })
    expect(ed.templates).toEqual([""])
    const base = {
      id: sandal._id, handle: "harbor-shore-sandal", title: "Harbor", html: "", vendor: "BlackBole", type: "Sandals", tags: ["men", "pre-order"],
      seo: { title: "", description: "" }, options: ["Size"], images: [], mf: { "bb26.short": "Light and soft" }, published: true, collections: [],
    }
    await as.mutation(api.website.saveProduct, {
      ...base, status: "archived", templateSuffix: "wide", category: "Shoes > Sandals",
      variants: ed.variants.map((x, i) => ({ id: x._id, compareAt: 1800, options: { Size: x.title }, barcode: i === 0 ? " 123 " : "", ...(i === 0 ? { cost: 650, weightKg: 0.7 } : {}) })),
    })
    const p: any = await t.run((ctx) => ctx.db.get(sandal._id))
    expect(p.web).toMatchObject({ published: false, archived: true, templateSuffix: "wide", category: "Shoes > Sandals" })
    const vs = await Promise.all(ed.variants.map((x) => t.run((ctx) => ctx.db.get(x._id))))
    expect(vs.map((v: any) => [v.purchasePrice, v.weightKg, v.web.barcode])).toEqual([[650, 0.7, "123"], [500, 0.4, undefined]])
    // Ops prices are never touched by the website editor
    expect(vs.map((v: any) => v.price)).toEqual([1480, 1500])
    expect(await feed(t)).toEqual([expect.objectContaining({ handle: "city-loafer" })])

    // back to active: in the feed with its template; products without one carry no templateSuffix key
    await as.mutation(api.website.saveProduct, { ...base, status: "active", variants: ed.variants.map((x) => ({ id: x._id, compareAt: 1800, options: { Size: x.title } })) })
    const live = await feed(t)
    expect(live.find((x) => x.handle === "harbor-shore-sandal")).toMatchObject({ templateSuffix: "wide", category: "Shoes > Sandals" })
    expect("templateSuffix" in live.find((x) => x.handle === "city-loafer")).toBe(false)
    expect(((await t.run((ctx) => ctx.db.get(sandal._id))) as any).web.archived).toBeUndefined()
  })

  it("shows stock per location in the editor", async () => {
    const { t, as, sandal } = await imported()
    const ed = (await as.query(api.website.product, { id: sandal._id }))!
    const loc = ed.locations[0]
    expect(loc).toBeTruthy()
    await t.run((ctx) => ctx.db.insert("stock", { variantId: ed.variants[0]._id, locationId: loc._id as any, available: 7, processing: 2, inTransit: 0, returning: 0, damaged: 0 }))
    const again = (await as.query(api.website.product, { id: sandal._id }))!
    expect(again.variants[0].byLocation[loc._id]).toEqual({ available: 7, committed: 2 })
  })

  it("test (fake) pairs typed per size become stock marked 'not in hand'", async () => {
    const { t, as } = await setup()
    const id = await as.mutation(api.website.createProduct, {
      title: "Test Runner", handle: "", html: "", vendor: "BlackBole", type: "Sneakers", tags: [], seo: { title: "", description: "" }, options: ["Size"], images: [], mf: {},
      published: true, preOrder: false, preOrderFrom: "china", collections: [],
      variants: [
        { sku: "TR-40", title: "40", options: { Size: "40" }, price: 1500, fullPrice: 1500, compareAt: null, cost: 700, weightKg: 0.5, testQty: 5 },
        { sku: "TR-41", title: "41", options: { Size: "41" }, price: 1500, fullPrice: 1500, compareAt: null, cost: 700, weightKg: 0.5 },
      ],
    })
    const rows = await t.run(async (ctx) => {
      const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", id)).collect()
      const out: Record<string, unknown> = {}
      for (const v of vs) out[v.sku] = (await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", v._id)).collect()).map((r) => [r.available, r.virtual])
      return out
    })
    expect(rows).toEqual({ "TR-40": [[5, 5]], "TR-41": [] })
  })
})

describe("booking money", () => {
  it("changes only China pre-order sizes priced 500 to 200, keeps the full price, and counts first", async () => {
    const { t, as } = await setup()
    const mk = (title: string, from: "china" | "bangladesh", price: number, sku: string) => as.mutation(api.website.createProduct, {
      title, handle: "", html: "<p>x</p>", vendor: "BlackBole", type: "Sneakers", tags: [], seo: { title: "", description: "" }, options: ["Size"], images: [], mf: {},
      published: true, preOrder: true, preOrderFrom: from, collections: [],
      variants: [{ sku, title: "40", options: { Size: "40" }, price, fullPrice: 3200, compareAt: 3200, cost: 1400, weightKg: 0.6 }],
    })
    const china = await mk("China Pair", "china", 500, "PO-CH-40")
    const bd = await mk("BD Pair", "bangladesh", 90, "PO-BD-40")
    const webPrice = async (id: any) => ((await t.run((ctx) => ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", id)).collect()))[0].web as any)
    expect(await as.mutation(api.website.setBookingMoney, { from: 500, to: 200, apply: false })).toEqual({ products: 1, variants: 1, applied: false })
    expect((await webPrice(china)).price).toBe(500) // counting changes nothing
    expect(await as.mutation(api.website.setBookingMoney, { from: 500, to: 200, apply: true })).toEqual({ products: 1, variants: 1, applied: true })
    expect(await webPrice(china)).toMatchObject({ price: 200, compareAt: 3200 })
    expect((await webPrice(bd)).price).toBe(90) // Bangladesh delivery advance untouched
    expect(await as.mutation(api.website.setBookingMoney, { from: 500, to: 200, apply: false })).toMatchObject({ products: 0 })
  })
  it("also catches products that are pre-order only by their pre-order tag", async () => {
    const { t, as } = await setup()
    const id = await as.mutation(api.website.createProduct, {
      title: "Tag Pair", handle: "", html: "<p>x</p>", vendor: "BlackBole", type: "Sneakers", tags: ["pre-order"], seo: { title: "", description: "" }, options: ["Size"], images: [], mf: {},
      published: true, preOrder: false, preOrderFrom: "china", collections: [],
      variants: [{ sku: "TAG-40", title: "40", options: { Size: "40" }, price: 500, fullPrice: 3200, compareAt: 3200, cost: 1400, weightKg: 0.6 }],
    })
    await t.run(async (ctx) => { await ctx.db.patch(id, { preOrder: undefined }) })
    expect(await as.mutation(api.website.setBookingMoney, { from: 500, to: 200, apply: true })).toEqual({ products: 1, variants: 1, applied: true })
  })
})
