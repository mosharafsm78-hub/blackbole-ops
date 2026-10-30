import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

function makeT() {
  return convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
}

/** One staff user with settings rights, one product with sizes 40 and 41, and a CTG warehouse that holds
 *  no stock at all — the exact situation that used to render as "No warehouse rows". */
async function setup() {
  const t = makeT()
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "lead@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Lead" })).toBe("ok")
  const locations = await as.query(api.team.listLocations, {})
  const dhakaId = locations.find((l) => l.isDefault)!._id

  await as.mutation(api.team.saveLocation, { name: "BlackBole CTG", isDefault: false, active: true })
  const ctg = (await as.query(api.team.listLocations, {})).find((l) => l.name === "BlackBole CTG")!

  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black",
    active: true,
    variants: [
      { sku: "BB-HSS-40", title: "40", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      { sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
    ],
  })
  const variants = await t.run((ctx) => ctx.db.query("variants").collect())
  const v41 = variants.find((v) => v.sku === "BB-HSS-41")!
  await as.mutation(api.catalog.receiveStock, {
    locationId: dhakaId, updateCost: true, items: [{ variantId: v41._id, qty: 12, unitCost: 520 }],
  })
  const product = (await t.run((ctx) => ctx.db.query("products").collect()))[0]
  return { t, as, product, v41, dhakaId, ctgId: ctg._id }
}

const detail = async (as: Awaited<ReturnType<typeof setup>>["as"], id: string) =>
  (await as.query(api.catalog.productDetail, { id }))!

describe("product detail — stock by warehouse", () => {
  it("lists EVERY active warehouse for a size, including one holding zero", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    const names = v41.warehouses.map((w) => w.locationName)
    // CTG has no stock row at all for this variant — it must still appear, at 0.
    expect(names).toContain("BlackBole CTG")
    expect(v41.warehouses.find((w) => w.locationName === "BlackBole CTG")!.available).toBe(0)
  })

  it("reports the real count for the warehouse that does hold stock", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    const stocked = v41.warehouses.filter((w) => w.available > 0)
    expect(stocked).toHaveLength(1)
    expect(stocked[0]!.available).toBe(12)
  })

  it("keeps the per-warehouse split consistent with the headline Available card", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    const sum = v41.warehouses.reduce((s, w) => s + w.available, 0)
    expect(sum).toBe(v41.stock.available)
  })

  it("puts the default warehouse first", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    expect(v41.warehouses[0]!.isDefault).toBe(true)
  })

  it("shows zero for a size that has no stock anywhere, but still lists the warehouses", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    const v40 = d.variants.find((v) => v.title === "40")!
    expect(v40.stock.available).toBe(0)
    expect(v40.warehouses.length).toBeGreaterThanOrEqual(2)
    expect(v40.warehouses.every((w) => w.available === 0)).toBe(true)
  })

  it("hides a deactivated warehouse that holds no stock", async () => {
    const { as, product, ctgId } = await setup()
    // Deactivate CTG (which holds nothing) — it should drop out of the table entirely.
    await as.mutation(api.team.saveLocation, { id: ctgId, name: "BlackBole CTG", isDefault: false, active: false })
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    expect(v41.warehouses.map((w) => w.locationName)).not.toContain("BlackBole CTG")
  })

  it("still surfaces a deactivated warehouse that actually holds stock, flagged inactive", async () => {
    const { as, product, dhakaId } = await setup()
    const d0 = await detail(as, product._id)
    const dhakaName = d0.variants[0]!.warehouses.find((w) => w.isDefault)!.locationName
    await as.mutation(api.team.saveLocation, { id: dhakaId, name: dhakaName, isDefault: true, active: false })
    const d = await detail(as, product._id)
    const v41 = d.variants.find((v) => v.title === "41")!
    const dhaka = v41.warehouses.find((w) => w.locationName === dhakaName)!
    // Real inventory must never vanish from the page just because a warehouse was switched off.
    expect(dhaka).toBeTruthy()
    expect(dhaka.active).toBe(false)
    expect(dhaka.available).toBe(12)
  })

  it("gives every warehouse row a stable locationId key (not a display name)", async () => {
    const { as, product } = await setup()
    const d = await detail(as, product._id)
    for (const v of d.variants) {
      for (const w of v.warehouses) expect(typeof w.locationId).toBe("string")
      const ids = v.warehouses.map((w) => w.locationId)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
