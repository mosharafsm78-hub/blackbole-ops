import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const wh = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  const outlet = await as.mutation(api.team.saveLocation, { name: "Dhaka Eye Catch", isDefault: false, active: true, isOutlet: true })
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal", active: true,
    variants: [{ sku: "BB-HSS-41", title: "Black / 41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v = (await as.query(api.catalog.listProducts, {}))!.find((p) => p.name === "Harbor Shore Sandal")!.variants[0]
  return { t, as, wh, outlet, variantId: v._id }
}
const avail = (t: any, variantId: any, locationId: any) =>
  t.run(async (ctx: any) => (await ctx.db.query("stock").withIndex("by_variant_location", (q: any) => q.eq("variantId", variantId).eq("locationId", locationId)).unique())?.available ?? 0)

describe("outlets", () => {
  it("an outlet is never a courier location and can't be the default", async () => {
    const { as, outlet } = await setup()
    const l = (await as.query(api.team.listLocations, {})).find((x) => x._id === outlet)!
    expect(l.isOutlet).toBe(true)
    expect(l.noCourier).toBe(true)
    await expect(as.mutation(api.team.saveLocation, { name: "X", isDefault: true, active: true, isOutlet: true })).rejects.toThrow(/default/)
  })

  it("splits a stock-in between the warehouse and an outlet", async () => {
    const { t, as, wh, outlet, variantId } = await setup()
    await as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 10, unitCost: 500 }], splits: [{ variantId, locationId: outlet, qty: 4 }] })
    expect(await avail(t, variantId, wh)).toBe(6)
    expect(await avail(t, variantId, outlet)).toBe(4)
    await expect(as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 2, unitCost: 500 }], splits: [{ variantId, locationId: outlet, qty: 3 }] })).rejects.toThrow(/more than/)
  })

  it("moves stock both ways and refuses more than is there", async () => {
    const { t, as, wh, outlet, variantId } = await setup()
    await as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 5, unitCost: 500 }] })
    await as.mutation(api.outlets.moveStock, { variantId, fromId: wh, toId: outlet, qty: 3 })
    await expect(as.mutation(api.outlets.moveStock, { variantId, fromId: wh, toId: outlet, qty: 3 })).rejects.toThrow(/only 2/)
    await as.mutation(api.outlets.moveStock, { variantId, fromId: outlet, toId: wh, qty: 1, note: "for online order" })
    expect(await avail(t, variantId, wh)).toBe(3)
    expect(await avail(t, variantId, outlet)).toBe(2)
  })

  it("records an outlet sale, shows it in the overview, and undo puts the pair back", async () => {
    const { t, as, wh, outlet, variantId } = await setup()
    await as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 5, unitCost: 500 }], splits: [{ variantId, locationId: outlet, qty: 3 }] })
    await as.mutation(api.outlets.recordSale, { locationId: outlet, soldAt: Date.now() - 3600_000, lines: [{ variantId, qty: 2, unitPrice: 1800 }] })
    expect(await avail(t, variantId, outlet)).toBe(1)
    await expect(as.mutation(api.outlets.recordSale, { locationId: outlet, soldAt: Date.now(), lines: [{ variantId, qty: 2, unitPrice: 1800 }] })).rejects.toThrow(/only 1/)
    await expect(as.mutation(api.outlets.recordSale, { locationId: wh, soldAt: Date.now(), lines: [{ variantId, qty: 1, unitPrice: 1800 }] })).rejects.toThrow(/outlet/i)
    const range = { from: Date.now() - 86_400_000, to: Date.now() + 1000 }
    const ov = (await as.query(api.outlets.salesOverview, range))!
    expect(ov.outlets[0]).toMatchObject({ name: "Dhaka Eye Catch", pairs: 2, amount: 3600 })
    expect(ov.outletStockLeft).toBe(1)
    const rows = await as.query(api.outlets.listSales, range)
    await as.mutation(api.outlets.undoSale, { id: rows[0]._id })
    expect(await avail(t, variantId, outlet)).toBe(3)
    expect((await as.query(api.outlets.salesOverview, range))!.outlets[0].pairs).toBe(0)
    await expect(as.mutation(api.outlets.undoSale, { id: rows[0]._id })).rejects.toThrow(/Already/)
  })

  it("finds a shoe per location and shows outlet availability for orders", async () => {
    const { as, wh, outlet, variantId } = await setup()
    await as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 5, unitCost: 500 }], splits: [{ variantId, locationId: outlet, qty: 2 }] })
    const hit = (await as.query(api.outlets.whereIs, { q: "Harbor Shore" }))[0]
    expect(hit.at.find((x) => x.outlet)!.available).toBe(2)
    expect(hit.at.find((x) => x.locationId === wh)!.available).toBe(3)
    const av = await as.query(api.outlets.outletAvailability, { variantIds: [variantId] })
    expect(av[variantId]).toEqual([{ name: "Dhaka Eye Catch", available: 2 }])
  })

  it("orders can't be created from an outlet", async () => {
    const { as, outlet, variantId } = await setup()
    await expect(as.mutation(api.orders.create, {
      source: "Facebook", customerName: "Test", phone: "01711000001", address: "House 1, Road 2, Lalmatia", locationId: outlet, deliveryType: "pickup",
      items: [{ variantId, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 0, advanceAmount: 0, advanceMethod: "bKash", approve: false,
    })).rejects.toThrow(/outlet/i)
  })

  it("opening-stock import sets pairs by SKU, matches by name, creates missing, and is safe to run twice", async () => {
    const { t, as, outlet, variantId } = await setup()
    const rows = [
      { sku: "BB-HSS-41", name: "Harbor Shore Sandal", color: "Black", size: "41", price: 1480, qty: 3 },
      { sku: "NEW-SKU-42", name: "Harbor Shore Sandal", color: "black", size: "42", price: 1480, qty: 2 },
      { sku: "NEW-9-40", name: "Brand New Boot", color: "Tan", size: "40", price: 2000, qty: 1 },
    ]
    const r1 = await t.mutation(internal.outlets.importOutletStock, { outletName: "Dhaka Eye Catch", rows })
    expect(r1).toMatchObject({ matchedSku: 1, createdVariants: 2, createdProducts: 1, pairs: 6 })
    await t.mutation(internal.outlets.importOutletStock, { outletName: "Dhaka Eye Catch", rows })
    expect(await avail(t, variantId, outlet)).toBe(3)
    const ov = (await as.query(api.outlets.salesOverview, { from: 0, to: Date.now() }))!
    expect(ov.outletStockLeft).toBe(6)
  })

  it("lists everything the outlets hold, grouped by shoe, without searching", async () => {
    const { as, wh, outlet, variantId } = await setup()
    await as.mutation(api.catalog.receiveStock, { locationId: wh, updateCost: false, items: [{ variantId, qty: 5, unitCost: 500 }], splits: [{ variantId, locationId: outlet, qty: 2 }] })
    const r = (await as.query(api.outlets.outletStockList, {}))!
    expect(r.totalPairs).toBe(2)
    expect(r.products).toHaveLength(1)
    expect(r.products[0].sizes[0]).toMatchObject({ sku: "BB-HSS-41", total: 2, at: { "Dhaka Eye Catch": 2 } })
  })
})
