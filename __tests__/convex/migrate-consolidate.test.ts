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

  it("picks the website-synced product as canonical, never the fuller-looking duplicate", async () => {
    // Regression test: a first version of this repair picked "canonical" purely by variant count / price,
    // which can go backwards when a bad fix script built out a full, even higher-priced duplicate product
    // that was never actually synced to the storefront. Being linked to the website (`web`/`shopifyItemId`)
    // is the one signal that can't be faked by an orphan script, so it must always win.
    const { as, t, locationId } = await setup()

    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [{ sku: "BB-HSS-39", title: "39", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true }],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal")!
    const realV39 = real.variants[0]
    // Mark it as actually synced to the storefront — the ground-truth signal of "this is the real one".
    await t.run((ctx) => ctx.db.patch(realV39._id, { web: { id: 123 } }))
    await as.mutation(api.catalog.adjustStock, { variantId: realV39._id, locationId, bucket: "available", change: -4, note: "test: oversold" })

    // A "fuller" duplicate: more variants AND a higher price than the real one, but never synced anywhere.
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [
        { sku: "BB-HSS-NEW-39", title: "39", weightKg: 0.4, price: 9999, purchasePrice: 500, active: true },
        { sku: "BB-HSS-NEW-40", title: "40", weightKg: 0.4, price: 9999, purchasePrice: 500, active: true },
      ],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal" && p._id !== real._id)!
    const dupeV39 = dupe.variants.find((v) => v.sku === "BB-HSS-NEW-39")!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: dupeV39._id, qty: 10, unitCost: 500 }] })

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    const move = res.sample.find((m: any) => m.size === "39")
    expect(move).toBeDefined()
    // Stock must flow INTO the real, website-synced variant — never out of it.
    expect(move!.toSku).toBe("BB-HSS-39")
    expect(move!.fromSku).toBe("BB-HSS-NEW-39")
  })

  it("uses order history to pick the canonical product when neither candidate is storefront-synced", async () => {
    // Regression test: the exact real-world case that slipped through the `synced` fix — neither the real
    // product nor its duplicate has `web`/`shopifyItemId` set (common for older catalogue entries), so the
    // tie-break must fall to something else that can't be gamed by a throwaway duplicate: real order history.
    const { as, t, locationId } = await setup()

    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      imageUrl: "https://example.com/hss.jpg",
      variants: [{ sku: "BB-SH-BHSS-BLACK-44", title: "44", weightKg: 0.4, price: 1380, purchasePrice: 500, active: true }],
    })
    const real = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal")!
    const realV44 = real.variants[0]

    // A duplicate with MORE variants and a HIGHER price — on the old heuristic alone this would win.
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [
        { sku: "BB-SH-BHSS-BLACK-NEW-44", title: "44", weightKg: 0.4, price: 9999, purchasePrice: 500, active: true },
        { sku: "BB-SH-BHSS-BLACK-NEW-45", title: "45", weightKg: 0.4, price: 9999, purchasePrice: 500, active: true },
      ],
    })
    const dupe = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal" && p._id !== real._id)!
    const dupeV44 = dupe.variants.find((v) => v.sku === "BB-SH-BHSS-BLACK-NEW-44")!
    await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: dupeV44._id, qty: 10, unitCost: 500 }] })

    // Give the REAL variant actual order history — a customer genuinely bought this one.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { code: 1, name: "Test Customer", phone: "01700000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 0 }),
    )
    await t.run((ctx) =>
      ctx.db.insert("orders", {
        invoiceNo: 90001,
        status: "delivered_paid" as any,
        source: "web",
        customerId,
        customerName: "Test Customer",
        phone: "01700000000",
        address: "Test address",
        locationId,
        deliveryType: "regular",
        items: [{ variantId: realV44._id, sku: "BB-SH-BHSS-BLACK-44", name: "Harbor Shore Sandal", price: 1380, qty: 1, discount: 0, weightKg: 0.4 }],
        subtotal: 1380,
        discount: 0,
        deliveryFee: 0,
        paidAmount: 1380,
        total: 1380,
        due: 0,
        callCount: 0,
        createdByName: "Test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        statusChangedAt: Date.now(),
      } as any),
    )

    const res = await as.mutation(api.migrate.consolidateDuplicateProducts, { dryRun: true })
    const move = res.sample.find((m: any) => m.size === "44")
    expect(move).toBeDefined()
    expect(move!.toSku).toBe("BB-SH-BHSS-BLACK-44")
    expect(move!.fromSku).toBe("BB-SH-BHSS-BLACK-NEW-44")
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
