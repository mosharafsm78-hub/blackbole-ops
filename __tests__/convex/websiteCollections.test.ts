import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { collectionTemplates } from "../../convex/websiteCollections"
import { describeRules } from "../../convex/websiteRules"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  // two Ops products set up on the website: a men's sandal (in stock) and a women's loafer (sold out)
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Sandal", active: true,
    variants: [
      { sku: "HS-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 500, active: true },
      { sku: "HS-42", title: "42", weightKg: 0.4, price: 1500, purchasePrice: 500, active: true },
    ],
  })
  await as.mutation(api.catalog.saveProduct, {
    name: "City Loafer", active: true,
    variants: [{ sku: "CL-40", title: "40", weightKg: 0.5, price: 2200, purchasePrice: 900, active: true }],
  })
  const ids = await t.run(async (ctx) => {
    const ps = await ctx.db.query("products").collect()
    const sandal = ps.find((p) => p.name === "Harbor Sandal")!
    const loafer = ps.find((p) => p.name === "City Loafer")!
    const web = (title: string, tags: string[], type: string) => ({ title, html: "", vendor: "BlackBole", type, tags, seo: { title: "", description: "" }, options: [], images: [], mf: {}, published: true, createdAt: "2026-01-01T00:00:00Z" })
    await ctx.db.patch(sandal._id, { handle: "harbor-sandal", web: web("Harbor Sandal", ["bb-men"], "Sandals") })
    await ctx.db.patch(loafer._id, { handle: "city-loafer", web: web("City Loafer", ["bb-women"], "Loafers") })
    const loc = (await ctx.db.query("locations").collect()).find((l) => l.isDefault)!
    const vs = await ctx.db.query("variants").collect()
    const v41 = vs.find((x) => x.sku === "HS-41")!
    await ctx.db.insert("stock", { variantId: v41._id, locationId: loc._id, available: 5, processing: 2, inTransit: 1, returning: 0, damaged: 1 })
    return { sandal: sandal._id, loafer: loafer._id, loc: loc._id, v41: v41._id }
  })
  return { t, as, ...ids }
}

const blank = { html: "", image: null, seo: { title: "", description: "" } }

describe("rule summaries", () => {
  it("reads like Shopify", () => {
    expect(describeRules({ match: "all", conditions: [
      { field: "tag", op: "is", values: ["bb-men"] },
      { field: "tag", op: "is", values: ["a", "b"], all: true },
      { field: "type", op: "is_not", values: ["Socks"] },
      { field: "price", op: "lt", values: ["2000"] },
      { field: "stock", op: "gt", values: ["0"] },
    ] })).toEqual([
      "Product tag is equal to bb-men",
      "Product tag is equal to a and b",
      "Product type is not equal to Socks",
      "Price is less than ৳2,000",
      "Inventory stock is greater than 0",
    ])
    expect(describeRules(null)).toEqual([])
  })

  it("finds collection layouts in the theme", () => {
    expect(collectionTemplates(JSON.stringify({ templates: { index: {}, collection: {}, "collection.sale": {}, "product.big": {} } }))).toEqual(["sale"])
    expect(collectionTemplates("not json")).toEqual([])
    expect(collectionTemplates(null)).toEqual([])
  })
})

describe("website collections", () => {
  it("lists real product counts for automatic collections, with condition summaries", async () => {
    const { as } = await setup()
    await as.mutation(api.websiteCollections.save, {
      ...blank, title: "Men", handle: "", productHandles: [], published: true,
      rules: { match: "all", conditions: [{ field: "tag", op: "is", values: ["bb-men", "x"], all: false }] },
    })
    await as.mutation(api.websiteCollections.save, { ...blank, title: "Picked", handle: "picked", productHandles: ["city-loafer", "gone"], published: true })
    const list = (await as.query(api.websiteCollections.list, {}))!
    expect(list.map((c) => [c.title, c.total, c.automatic, c.conditions])).toEqual([
      ["Men", 1, true, ["Product tag is equal to bb-men or x"]],
      ["Picked", 1, false, []],
    ])
  })

  it("saves 'needs all these tags', hides collections from the website and deletes in bulk", async () => {
    const { t, as } = await setup()
    const id = await as.mutation(api.websiteCollections.save, {
      ...blank, title: "Both", handle: "", productHandles: [], published: true, templateSuffix: "sale",
      rules: { match: "any", conditions: [{ field: "tag", op: "is", values: ["bb-men", " bb-women "], all: true }] },
    })
    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row).toMatchObject({ handle: "both", templateSuffix: "sale", published: true, rules: { match: "any", conditions: [{ field: "tag", op: "is", values: ["bb-men", "bb-women"], all: true }] } })
    expect((await as.query(api.websiteCollections.meta, { id }))).toMatchObject({ published: true, templateSuffix: "sale" })

    const keep = await as.mutation(api.websiteCollections.save, { ...blank, title: "Keep", handle: "", productHandles: ["harbor-sandal"], published: true })
    expect(await as.mutation(api.websiteCollections.setPublished, { ids: [keep], published: false })).toBe(1)
    const feed = await t.query(internal.website.catalogData, {})
    expect(feed.collections.map((c: any) => c.handle)).toEqual(["both"])
    expect(feed.collections[0].templateSuffix).toBe("sale")

    expect(await as.mutation(api.websiteCollections.remove, { ids: [id, keep] })).toBe(2)
    expect(await t.run((ctx) => ctx.db.query("webCollections").collect())).toEqual([])
  })

  it("refuses a handle another collection uses", async () => {
    const { as } = await setup()
    await as.mutation(api.websiteCollections.save, { ...blank, title: "Sale", handle: "", productHandles: [], published: true })
    await expect(as.mutation(api.websiteCollections.save, { ...blank, title: "Sale 2", handle: "sale", productHandles: [], published: true })).rejects.toThrow(/already exists/)
  })
})

describe("website inventory", () => {
  it("shows one row per size with Unavailable / Committed / Available / On hand from Ops stock", async () => {
    const { as, loc, sandal } = await setup()
    const coll = await as.mutation(api.websiteCollections.save, {
      ...blank, title: "Men", handle: "", productHandles: [], published: true,
      rules: { match: "all", conditions: [{ field: "tag", op: "is", values: ["bb-men"] }] },
    })
    const all = (await as.query(api.websiteInventory.list, {}))!
    expect(all.rows.map((r) => [r.productTitle, r.variantTitle, r.sku, r.unavailable, r.committed, r.available, r.onHand])).toEqual([
      ["City Loafer", "40", "CL-40", 0, 0, 0, 0],
      ["Harbor Sandal", "41", "HS-41", 1, 2, 5, 8],
      ["Harbor Sandal", "42", "HS-42", 0, 0, 0, 0],
    ])
    expect(all.rows[1]).toMatchObject({ productId: sandal, onWebsite: true, type: "Sandals", collections: [coll], inTransit: 1 })
    expect(all.types).toEqual(["Loafers", "Sandals"])
    expect(all.canAdjust).toBe(true)

    // another warehouse has none of it
    const other = all.locations.find((l) => l._id !== loc)!
    const there = (await as.query(api.websiteInventory.list, { locationId: other._id }))!
    expect(there.rows.every((r) => r.onHand === 0)).toBe(true)
  })

  it("hides everything from staff without website access", async () => {
    const { t } = await setup()
    const uid = await t.run((ctx) => ctx.db.insert("users", { email: "x@y.z" }))
    expect(await t.withIdentity({ subject: `${uid}|s2` }).query(api.websiteInventory.list, {})).toBeNull()
  })
})
