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

  it("picks the real product by price alone, even when the ৳0 duplicate has more SKUs", async () => {
    // Regression test: a first version of this repair picked "canonical" by variant count / price among ALL
    // candidates, which goes backwards when a bad fix script built out a fuller-looking ৳0 duplicate with more
    // sizes than the real product. ৳0 is the one signal the live data never contradicted — a product that was
    // never actually priced can never be "the real one", however many sizes it was given, so it's a hard
    // filter now, not a tie-break that a bigger duplicate can out-score.
    const { as, locationId } = await setup()

    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      imageUrl: "https://example.com/hss.jpg",
      variants: [{ sku: "BB-HSS-39", title: "39", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true }],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal")!
    const realV39 = real.variants[0]
    await as.mutation(api.catalog.adjustStock, { variantId: realV39._id, locationId, bucket: "available", change: -4, note: "test: oversold" })

    // A "fuller" duplicate: more variants than the real one, ৳0 price (the documented duplicate signature).
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [
        { sku: "BB-HSS-NEW-39", title: "39", weightKg: 0.4, price: 0, purchasePrice: 500, active: true },
        { sku: "BB-HSS-NEW-40", title: "40", weightKg: 0.4, price: 0, purchasePrice: 500, active: true },
      ],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal" && p._id !== real._id)!
    const dupeV39 = dupe.variants.find((v) => v.sku === "BB-HSS-NEW-39")!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: dupeV39._id, qty: 10, unitCost: 500 }] })

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    const move = res.sample.find((m: any) => m.size === "39")
    expect(move).toBeDefined()
    // Stock must flow INTO the real, priced variant — never out of it.
    expect(move!.toSku).toBe("BB-HSS-39")
    expect(move!.fromSku).toBe("BB-HSS-NEW-39")
  })

  it("leaves a whole group alone when two priced, multi-SKU products share a name — too ambiguous to auto-pick", async () => {
    // The exact real-world case that slipped through every earlier version of this heuristic: two products
    // sharing a name both have a real price and several SKUs (e.g. an old SKU scheme sitting alongside a new
    // one, or a genuinely different product that happens to share a name). Live dry runs showed that guessing
    // between two real-looking candidates — by sync status, order history, variant count, price, or age — gets
    // it backwards often enough that this can't be auto-picked; it needs a human to actually look.
    const { as, locationId } = await setup()

    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      imageUrl: "https://example.com/hss-a.jpg",
      variants: [{ sku: "BB-HSS-A-44", title: "44", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true }],
    })
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      imageUrl: "https://example.com/hss-b.jpg",
      variants: [
        { sku: "BB-HSS-B-44", title: "44", weightKg: 0.4, price: 1980, purchasePrice: 700, active: true },
        { sku: "BB-HSS-B-45", title: "45", weightKg: 0.4, price: 1980, purchasePrice: 700, active: true },
      ],
    })
    const b = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal" && p.variants.some((v) => v.sku === "BB-HSS-B-44"))!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: b.variants[0]._id, qty: 10, unitCost: 700 }] })

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    expect(res.totalUnits).toBe(0)
    expect(res.moves).toBe(0)
    expect(res.skipped.some((s: string) => s.includes("Harbor Shore Sandal") && s.includes("all look real"))).toBe(true)
  })

  it("never transfers a negative bucket off a duplicate — that's a deficit, not stock to hand over", async () => {
    const { as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "Trail Runner",
      active: true,
      imageUrl: "https://example.com/tr.jpg",
      variants: [{ sku: "BB-TR-41", title: "41", weightKg: 0.4, price: 2000, purchasePrice: 800, active: true }],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Trail Runner")!

    await as.mutation(api.catalog.saveProduct, {
      name: "Trail Runner",
      active: true,
      variants: [{ sku: "BB-TR-41-DELETED", title: "41", weightKg: 0.4, price: 0, purchasePrice: 0, active: true }],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Trail Runner" && p._id !== real._id)!
    // The duplicate's own stock is itself negative (a symptom of the same bug elsewhere) — nothing real to move.
    await as.mutation(api.catalog.adjustStock, { variantId: dupe.variants[0]._id, locationId, bucket: "available", change: -2, note: "test: duplicate itself corrupted" })

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    expect(res.totalUnits).toBe(0)
    expect(res.moves).toBe(0)
    expect(res.skipped.some((s: string) => s.includes("is itself negative"))).toBe(true)
  })
})
