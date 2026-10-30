import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { baseSku, splitVariant } from "../../convex/inventoryReport"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  return { t, as, locationId }
}

describe("inventory report helpers", () => {
  it("splits a variant title into colour and size", () => {
    expect(splitVariant("Black / 42")).toEqual({ color: "Black", size: "42" })
    expect(splitVariant("Black-41")).toEqual({ color: "Black", size: "41" })
    expect(splitVariant("42")).toEqual({ color: "", size: "42" })
    expect(splitVariant("", "Navy / 40")).toEqual({ color: "Navy", size: "40" })
    expect(splitVariant("Tan / 43 / Wide")).toEqual({ color: "Tan", size: "43" })
  })

  it("strips the size off a SKU to get the base SKU", () => {
    expect(baseSku("BB-HSS-41", "41")).toBe("BB-HSS")
    expect(baseSku("BB-HSS_42", "42")).toBe("BB-HSS")
    expect(baseSku("BB-HSS", "")).toBe("BB-HSS")
    expect(baseSku("41", "41")).toBe("41") // never returns an empty string
  })
})

describe("inventory report summary", () => {
  it("groups sizes 40–44 per product + colour with available, committed and velocity", async () => {
    const { as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [
        { sku: "BB-HSS-40", title: "Black / 40", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
        { sku: "BB-HSS-41", title: "Black / 41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
        { sku: "BB-HSS-42", title: "Black / 42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      ],
    })
    const variants = (await as.query(api.catalog.listProducts, {}))!
    const product = variants.find((p) => p.name === "Harbor Shore Sandal")!
    const v41 = product.variants.find((v) => v.sku === "BB-HSS-41")!
    const v42 = product.variants.find((v) => v.sku === "BB-HSS-42")!

    await as.mutation(api.catalog.receiveStock, {
      locationId,
      updateCost: true,
      items: [
        { variantId: v41._id, qty: 10, unitCost: 500 },
        { variantId: v42._id, qty: 1, unitCost: 500 },
      ],
    })

    // One unshipped order commits 2 units of size 41.
    await as.mutation(api.orders.create, {
      source: "Facebook",
      customerName: "Test",
      phone: "01711000001",
      address: "House 1, Road 2, Lalmatia",
      locationId,
      deliveryType: "pickup",
      items: [{ variantId: v41._id, qty: 2, price: 1480, discount: 0 }],
      discount: 0,
      deliveryFee: 0,
      advanceAmount: 0,
      advanceMethod: "bKash",
      approve: false,
    })

    const report = (await as.query(api.inventoryReport.summary, {}))!
    expect(report).not.toBeNull()
    expect(report.rows).toHaveLength(1)

    const row = report.rows[0]
    expect(row.productTitle).toBe("Harbor Shore Sandal")
    expect(row.color).toBe("Black")
    expect(row.sku).toBe("BB-HSS")
    expect(row.available).toBe(11)
    expect(row.committed).toBe(2)
    expect(row.units30).toBe(2)

    // All five report sizes are present, even the ones with no variant.
    expect(row.sizes.map((s) => s.size)).toEqual(["40", "41", "42", "43", "44"])
    const bySize = Object.fromEntries(row.sizes.map((s) => [s.size, s]))
    // Size 40 exists as a variant but has no stock yet.
    expect(bySize["40"]).toMatchObject({ exists: true, available: 0, committed: 0 })
    expect(bySize["41"]).toMatchObject({ exists: true, available: 10, committed: 2 })
    expect(bySize["42"]).toMatchObject({ exists: true, available: 1, committed: 0 })
    expect(bySize["43"].exists).toBe(false)

    // Size 42 has 1 unit, so with the default threshold of 3 the row is "low".
    expect(row.status).toBe("low")
    expect(report.totals.available).toBe(11)
    expect(report.totals.committed).toBe(2)
    expect(report.bySize.find((s) => s.size === "41")).toMatchObject({ available: 10, committed: 2 })
  })

  it("honours a custom low-stock threshold and flags out-of-stock rows", async () => {
    const { as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "Trail Runner",
      active: true,
      variants: [
        { sku: "BB-TR-44", title: "Grey / 44", weightKg: 0.4, price: 2000, purchasePrice: 800, active: true },
      ],
    })
    const product = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Trail Runner")!
    const v44 = product.variants[0]
    await as.mutation(api.catalog.receiveStock, {
      locationId,
      updateCost: true,
      items: [{ variantId: v44._id, qty: 4, unitCost: 800 }],
    })

    const strict = (await as.query(api.inventoryReport.summary, { lowStockThreshold: 5 }))!
    expect(strict.rows[0].status).toBe("low")

    const loose = (await as.query(api.inventoryReport.summary, { lowStockThreshold: 2 }))!
    expect(loose.rows[0].status).toBe("ok")

    // Sell everything → out of stock.
    await as.mutation(api.catalog.adjustStock, {
      variantId: v44._id,
      locationId,
      bucket: "available",
      change: -4,
      note: "test drain",
    })
    const drained = (await as.query(api.inventoryReport.summary, {}))!
    expect(drained.rows[0].status).toBe("out")
    expect(drained.totals.out).toBe(1)
  })

  it("excludes cancelled orders from committed stock and velocity", async () => {
    const { as, locationId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      name: "City Loafer",
      active: true,
      variants: [
        { sku: "BB-CL-40", title: "Brown / 40", weightKg: 0.4, price: 1800, purchasePrice: 700, active: true },
      ],
    })
    const product = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "City Loafer")!
    const v40 = product.variants[0]
    await as.mutation(api.catalog.receiveStock, {
      locationId,
      updateCost: true,
      items: [{ variantId: v40._id, qty: 5, unitCost: 700 }],
    })
    const created = await as.mutation(api.orders.create, {
      source: "Facebook",
      customerName: "Test",
      phone: "01711000002",
      address: "House 1, Road 2, Lalmatia",
      locationId,
      deliveryType: "pickup",
      items: [{ variantId: v40._id, qty: 3, price: 1800, discount: 0 }],
      discount: 0,
      deliveryFee: 0,
      advanceAmount: 0,
      advanceMethod: "bKash",
      approve: false,
    })
    expect((await as.query(api.inventoryReport.summary, {}))!.rows[0].committed).toBe(3)

    await as.mutation(api.orders.changeStatus, { ids: [created.orderId], to: "cancelled" })
    const after = (await as.query(api.inventoryReport.summary, {}))!
    expect(after.rows[0].committed).toBe(0)
    expect(after.rows[0].units30).toBe(0)
  })

  it("splits stock held at two different warehouses into two separate, clearly-labelled rows", async () => {
    const { as, locationId } = await setup()
    const locations = await as.query(api.team.listLocations, {})
    const secondLocationId =
      locations.find((l) => l._id !== locationId)?._id ??
      (await as.mutation(api.team.saveLocation, { name: "BlackBole CTG", active: true, isDefault: false }))

    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal",
      active: true,
      variants: [
        { sku: "BB-HSS-44", title: "Black / 44", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true },
      ],
    })
    const product = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal")!
    const v44 = product.variants[0]

    await as.mutation(api.catalog.receiveStock, {
      locationId,
      updateCost: true,
      items: [{ variantId: v44._id, qty: 7, unitCost: 500 }],
    })
    await as.mutation(api.catalog.receiveStock, {
      locationId: secondLocationId,
      updateCost: true,
      items: [{ variantId: v44._id, qty: 3, unitCost: 500 }],
    })

    const report = (await as.query(api.inventoryReport.summary, {}))!
    const rows = report.rows.filter((r) => r.productTitle === "Harbor Shore Sandal")
    expect(rows).toHaveLength(2)

    // Every row says which warehouse it belongs to, and the quantities are never mixed together.
    expect(rows.every((r) => r.locationId && r.locationName)).toBe(true)
    expect(new Set(rows.map((r) => r.locationId)).size).toBe(2)
    const totalAvailable = rows.reduce((sum, r) => sum + r.available, 0)
    expect(totalAvailable).toBe(10)
    expect(rows.map((r) => r.available).sort()).toEqual([3, 7])
  })

  it("returns null for a signed-out visitor", async () => {
    const { t } = await setup()
    expect(await t.query(api.inventoryReport.summary, {})).toBeNull()
  })
})
