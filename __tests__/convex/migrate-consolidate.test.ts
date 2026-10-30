import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  return { t, as, locationId }
}

describe("consolidateDuplicateProducts", () => {
  it("moves stock stranded on a throwaway duplicate product back onto the real product's matching size", async () => {
    const { as, locationId } = await setup()

    // The real, customer-facing product: 6 SKUs, a real price, an image — exactly what the live catalogue
    // looks like for a normal product.
    await as.mutation(api.catalog.saveProduct, {
      name: "BlackBole Harbor Shore Sandal For Men - Black",
      active: true,
      imageUrl: "https://example.com/hss.jpg",
      variants: [
        { sku: "BB-SH-BHSS-BLACK-39", title: "39", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true },
        { sku: "BB-SH-BHSS-BLACK-40", title: "40", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true },
      ],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name.includes("Harbor Shore"))!
    const realV39 = real.variants.find((v) => v.sku === "BB-SH-BHSS-BLACK-39")!

    // An order reserves 1 pair of the real size 39, so its "available" is already down to -? — no, start clean:
    // give the real product's size 39 a small amount of available stock that is already short.
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: realV39._id, qty: 2, unitCost: 500 }] })
    // Simulate the real-world symptom: an order reserved more than the recorded available (negative available).
    await as.mutation(api.catalog.adjustStock, { variantId: realV39._id, locationId, bucket: "available", change: -5, note: "test: simulate oversell / stranded reservation" })

    // The throwaway duplicate: same name verbatim, ৳0 price, exactly 1 SKU, no image — holding the REAL
    // physical stock that should have stayed on the live product's size 39.
    await as.mutation(api.catalog.saveProduct, {
      name: "BlackBole Harbor Shore Sandal For Men - Black",
      active: true,
      variants: [{ sku: "BB-SH-BHSS-BLACK-39-DELETED", title: "39", weightKg: 0.4, price: 0, purchasePrice: 0, active: true }],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name.includes("Harbor Shore") && p._id !== real._id)!
    const dupeV39 = dupe.variants[0]
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: dupeV39._id, qty: 10, unitCost: 500 }] })

    // Dry run changes nothing.
    const dry = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.moves).toBeGreaterThan(0)
    expect(dry.totalUnits).toBe(10)
    const beforeReal = (await as.query(api.catalog.listProducts, {}))!
    const realStillShort = beforeReal.find((p) => p._id === real._id)!.variants.find((v) => v.sku === "BB-SH-BHSS-BLACK-39")!
    expect(realStillShort.stock.available).toBe(-3) // unchanged by dry run

    // Apply for real.
    const applied = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: false })
    expect(applied.dryRun).toBe(false)
    expect(applied.totalUnits).toBe(10)
    expect(applied.deactivated.some((d: string) => d.includes(dupe._id as string))).toBe(true)

    const after = (await as.query(api.catalog.listProducts, {}))!
    const realAfter = after.find((p) => p._id === real._id)!.variants.find((v) => v.sku === "BB-SH-BHSS-BLACK-39")!
    // -3 (2 received - 5 adjusted) + 10 transferred in = 7
    expect(realAfter.stock.available).toBe(7)

    const dupeAfter = after.find((p) => p._id === dupe._id)!
    expect(dupeAfter.active).toBe(false)
    expect(dupeAfter.variants[0].stock.available).toBe(0)

    // Running it again is a no-op — nothing left to move, nothing double-counted.
    const again = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    expect(again.totalUnits).toBe(0)
  })

  it("leaves a duplicate's size alone (and reports it) when the live product has no matching size", async () => {
    const { as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "City Loafer",
      active: true,
      imageUrl: "https://example.com/cl.jpg",
      variants: [{ sku: "BB-CL-40", title: "40", weightKg: 0.4, price: 1800, purchasePrice: 700, active: true }],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "City Loafer")!

    await as.mutation(api.catalog.saveProduct, {
      name: "City Loafer",
      active: true,
      variants: [{ sku: "BB-CL-46-ORPHAN", title: "46", weightKg: 0.4, price: 0, purchasePrice: 0, active: true }],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "City Loafer" && p._id !== real._id)!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: dupe.variants[0]._id, qty: 4, unitCost: 700 }] })

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    expect(res.totalUnits).toBe(0)
    expect(res.skipped.some((s: string) => s.includes("size 46"))).toBe(true)
  })
})
