import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** One staff user, one product "Harbor Shore Sandal" with two sizes, stock on the 41. */
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "lead@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Lead" })).toBe("ok")
  const locations = await as.query(api.team.listLocations, {})
  const locationId = locations.find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [
      { sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-HSS-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ],
  })
  const product = (await t.run((ctx) => ctx.db.query("products").collect()))[0]
  const variants = await t.run((ctx) => ctx.db.query("variants").collect())
  const v41 = variants.find((v) => v.sku === "BB-HSS-41")!
  await as.mutation(api.catalog.receiveStock, {
    locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }],
  })
  return { t, as, product, v41 }
}

describe("order line-item product links", () => {
  it("routes on an explicit productId (preferred when the line carries one)", async () => {
    const { as, product, v41 } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, {
      items: [{ productId: product._id, variantId: v41._id, sku: "BB-HSS-41" }],
    })
    expect(links[0]).toEqual({ id: product._id, via: "productId" })
  })

  it("falls back to variantId when productId is missing on an older line item", async () => {
    const { as, v41 } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, { items: [{ sku: "BB-HSS-41", variantId: v41._id }] })
    expect(links[0]).toEqual({ id: v41._id, via: "variantId" })
    // and that id genuinely opens the product, not the catalog
    const detail = await as.query(api.catalog.productDetail, { id: links[0]!.id })
    expect(detail?.name).toBe("Harbor Shore Sandal - Black")
    expect(detail?.variants.map((v) => v.title)).toEqual(["41", "42"])
  })

  it("falls back to SKU when both productId and variantId are missing", async () => {
    const { as, v41 } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, { items: [{ sku: "BB-HSS-42" }] })
    expect(links[0]?.via).toBe("sku")
    const variant = await as.query(api.catalog.productDetail, { id: links[0]!.id })
    expect(variant?.name).toBe("Harbor Shore Sandal - Black")
    // resolution must land on the 42, not whichever variant happened to be first
    const target = await as.query(api.catalog.productDetail, { id: links[0]!.id })
    expect(target?.variants.some((v) => v.sku === "BB-HSS-42")).toBe(true)
    expect(v41.sku).toBe("BB-HSS-41")
  })

  it("matches SKU case-insensitively so hand-typed / legacy SKUs still link", async () => {
    const { as } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, { items: [{ sku: "bb-hss-41" }] })
    expect(links[0]?.via).toBe("sku")
  })

  it("returns null (plain text, no dead link) when nothing resolves", async () => {
    const { as } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, { items: [{ sku: "DOES-NOT-EXIST" }] })
    expect(links[0]).toBeNull()
  })

  it("keeps each line item independent and preserves order", async () => {
    const { as, product, v41 } = await setup()
    const links = await as.query(api.catalog.resolveProductLinks, {
      items: [
        { sku: "BB-HSS-41", variantId: v41._id },
        { sku: "NOPE-X" },
        { productId: product._id, sku: "BB-HSS-42" },
      ],
    })
    expect(links).toHaveLength(3)
    expect(links[0]?.via).toBe("variantId")
    expect(links[1]).toBeNull()
    expect(links[2]?.via).toBe("productId")
  })

  it("productDetail still accepts a bare product id and a bare variant id", async () => {
    const { as, product, v41 } = await setup()
    expect((await as.query(api.catalog.productDetail, { id: product._id }))?.name).toBe("Harbor Shore Sandal - Black")
    expect((await as.query(api.catalog.productDetail, { id: v41._id }))?.name).toBe("Harbor Shore Sandal - Black")
    expect(await as.query(api.catalog.productDetail, { id: "not-a-real-id" })).toBeNull()
  })
})
