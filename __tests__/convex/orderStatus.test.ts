import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { normPhone, parseInvoice } from "../../convex/orderStatus"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-42", title: "42", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  const v = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-42")).unique()))!
  const created = await as.mutation(api.orders.create, {
    source: "Website", customerName: "Rahim", phone: "+8801711000000", address: "House 1, Road 2, Lalmatia",
    locationId, deliveryType: "regular", items: [{ variantId: v._id, qty: 1, price: 1480, discount: 0 }],
    discount: 0, deliveryFee: 90, advanceAmount: 500, advanceMethod: "SSLCommerz", approve: false,
  })
  return { t, invoiceNo: created.invoiceNo as number, orderId: created.orderId as Id<"orders"> }
}

const get = (t: any, q: string, ip = "1.2.3.4") => t.fetch(`/website/order-status?${q}`, { headers: { "X-Client-IP": ip } })

describe("website order status", () => {
  it("parses invoice and phone forms", () => {
    expect(parseInvoice("BB-12345")).toBe(12345)
    expect(parseInvoice(" bb 77 ")).toBe(77)
    expect(parseInvoice("#9")).toBe(9)
    expect(parseInvoice("BB-12a")).toBeNull()
    expect(normPhone("+880 1711-000000")).toBe("01711000000")
  })

  it("answers with safe fields only when the mobile matches", async () => {
    const { t, invoiceNo } = await setup()
    const ok = await get(t, `invoice=BB-${invoiceNo}&phone=01711000000`)
    expect(ok.status).toBe(200)
    const { order } = await ok.json()
    expect(Object.keys(order).sort()).toEqual(["courier", "createdAt", "due", "invoice", "items", "note", "paid", "status", "step", "total", "tracking", "trackingUrl"])
    expect(order).toMatchObject({ invoice: `BB-${invoiceNo}`, status: "Order received", total: 1570, paid: 500, due: 1070, courier: null, trackingUrl: null })
    expect(order.items).toEqual([{ name: "Harbor Shore Sandal - Black", size: "42", qty: 1 }])
    const raw = JSON.stringify(order)
    for (const secret of ["Rahim", "Lalmatia", "01711000000", "BB-HSS-42", "purchase"]) expect(raw).not.toContain(secret)
  })

  it("gives the same not-found for a wrong mobile or invoice", async () => {
    const { t, invoiceNo } = await setup()
    const wrongPhone = await get(t, `invoice=BB-${invoiceNo}&phone=01999999999`)
    const wrongInvoice = await get(t, `invoice=BB-1&phone=01711000000`)
    expect(wrongPhone.status).toBe(404)
    expect(wrongInvoice.status).toBe(404)
    expect(await wrongPhone.json()).toEqual(await wrongInvoice.json())
    expect((await get(t, `invoice=&phone=017`)).status).toBe(400)
  })

  it("limits each IP to 10 lookups a minute", async () => {
    const { t, invoiceNo } = await setup()
    for (let i = 0; i < 10; i++) expect((await get(t, `invoice=BB-${invoiceNo}&phone=01999999999`, "9.9.9.9")).status).toBe(404)
    expect((await get(t, `invoice=BB-${invoiceNo}&phone=01711000000`, "9.9.9.9")).status).toBe(429)
    expect((await get(t, `invoice=BB-${invoiceNo}&phone=01711000000`, "8.8.8.8")).status).toBe(200)
  })
})
