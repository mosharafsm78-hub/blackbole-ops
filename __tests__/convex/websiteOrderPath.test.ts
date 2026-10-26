// The website order path as Ops sees it (blackbole-storefront functions/api/order.js, cod.js, pay/* and the checkout
// lead): POST /api/orders exactly as the website sends it, and POST /cod-lead from the checkout page / COD popup.
import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { cartLink } from "../../convex/checkouts"

const KEY = "website-api-key-for-tests"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  await as.mutation(api.catalog.saveProduct, {
    name: "Retro Chunky Sole Sneaker - Brown", active: true,
    variants: [{ sku: "PO-RCS-BR-39", title: "39", weightKg: 0.6, price: 3070, purchasePrice: 1500, active: true }],
  })
  await t.run((ctx) => ctx.db.insert("settings", { key: "apiKey", value: KEY }))
  const post = (body: unknown, key = KEY) => t.fetch("/api/orders", { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const lead = (body: unknown) => t.fetch("/cod-lead", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) })
  const order = (externalId: string) => t.run((ctx) => ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", externalId)).collect())
  return { t, as, post, lead, order }
}

// the body the website builds (storefront server/lib.js opsOrderBody)
const body = (over: Record<string, unknown> = {}) => ({
  source: "Website", external_id: "WTEST0001", external_name: "WTEST0001",
  customer: { name: "Test Customer", phone: "01711000001", address: "House 1, Road 2, Dhanmondi", city: "Dhaka" },
  delivery_type: "regular", items: [{ sku: "BB-HSS-41", qty: 2, price: 1480, name: "Harbor Shore Sandal", attrs: "41" }],
  delivery_fee: 90, discount: 0, origin: "blackbole-site", ...over,
})

describe("website orders (POST /api/orders)", () => {
  it("wrong API key is 401 (the website keeps the order queued, never drops it)", async () => {
    const { post } = await setup()
    expect((await post(body(), "wrong")).status).toBe(401)
  })

  it("the same order sent twice, or twice at once, is one order with one invoice", async () => {
    const { post, order } = await setup()
    const a = await (await post(body())).json()
    const [b, c] = await Promise.all([post(body()), post(body())]).then((rs) => Promise.all(rs.map((r) => r.json())))
    expect(a).toMatchObject({ duplicate: false })
    expect(b).toMatchObject({ invoice: a.invoice, duplicate: true })
    expect(c).toMatchObject({ invoice: a.invoice, duplicate: true })
    expect(await order("WTEST0001")).toHaveLength(1)
  })

  it("COD amounts: subtotal, discount, delivery; all due on delivery", async () => {
    const { post, order } = await setup()
    await post(body({ discount: 296, discount_code: "TEST10" }))
    const [o] = await order("WTEST0001")
    expect(o).toMatchObject({ subtotal: 2960, discount: 296, deliveryFee: 90, total: 2754, paidAmount: 0, due: 2754, paymentMethod: "Cash On Delivery", source: "Website", status: "pending" })
  })

  it("paid online (China pre-order + a ready pair): full prices, paid = booking + ready pair + delivery, the rest due", async () => {
    const { post, order } = await setup()
    await post(body({
      items: [{ sku: "PO-RCS-BR-39", qty: 1, price: 3070, name: "Retro Chunky Sole Sneaker", attrs: "Brown / 39" }, { sku: "BB-HSS-41", qty: 1, price: 1480 }],
      paid_amount: 1480 + 500 + 90, payment_method: "SSLCommerz BKASH-BKash",
      note: "Pre-order: booking Tk 500 paid online, Tk 2570 due on delivery",
    }))
    const [o] = await order("WTEST0001")
    expect(o).toMatchObject({ subtotal: 4550, deliveryFee: 90, total: 4640, paidAmount: 2070, due: 2570, preOrder: true })
    expect(o.items.map((i) => [i.sku, i.price])).toEqual([["PO-RCS-BR-39", 3070], ["BB-HSS-41", 1480]])
  })

  it("fully paid online: due 0 and the payment method is the gateway", async () => {
    const { post, order } = await setup()
    await post(body({ paid_amount: 3050, payment_method: "SSLCommerz BKASH-BKash" }))
    const [o] = await order("WTEST0001")
    expect(o).toMatchObject({ total: 3050, paidAmount: 3050, due: 0, paymentMethod: "SSLCommerz BKASH-BKash" })
  })

  it("a SKU Ops does not know is kept as a named line (the paid order is never refused)", async () => {
    const { t, post, order } = await setup()
    const r = await post(body({ items: [{ sku: "NEW-WEB-SKU-1", qty: 1, price: 999, name: "Brand New Loafer", attrs: "42" }, { sku: "BB-HSS-41", qty: 1, price: 1480 }], paid_amount: 2569 }))
    expect(r.status).toBe(201)
    const [o] = await order("WTEST0001")
    expect(o.items[0]).toMatchObject({ sku: "NEW-WEB-SKU-1", name: "Brand New Loafer", attrs: "42", price: 999, qty: 1 })
    expect(o.items[0].variantId).toBeUndefined()
    expect(o.items[1].variantId).toBeDefined()
    expect(o).toMatchObject({ total: 2569, paidAmount: 2569, due: 0 })
    const logs = await t.run((ctx) => ctx.db.query("orderEvents").collect())
    expect(JSON.stringify(logs)).toContain("NEW-WEB-SKU-1")
  })

  it("a website SKU missing in Ops is linked by product name + size when it matches", async () => {
    const { post, order } = await setup()
    await post(body({ items: [{ sku: "OLD-SHOPIFY-SKU", qty: 1, price: 1480, name: "Harbor Shore Sandal - Black", attrs: "41" }] }))
    const [o] = await order("WTEST0001")
    expect(o.items[0]).toMatchObject({ sku: "BB-HSS-41" })
    expect(o.items[0].variantId).toBeDefined()
  })
})

describe("abandoned website checkouts (like Shopify's)", () => {
  const checkoutLead = (over: Record<string, unknown> = {}) => ({
    source: "checkout", phone: "01711000001", name: "Test Customer", email: "t@example.com", address: "House 1, Road 2, Dhanmondi", zone: "inside",
    url: "https://blackbole.com/checkout?utm_source=fb",
    items: [{ id: 42893397000329, sku: "BB-HSS-41", title: "Harbor Shore Sandal", variant: "41", qty: 2, price: 1480 }, { id: 48701337075849, sku: "PO-RCS-BR-39", title: "Retro Chunky Sole Sneaker", variant: "Brown / 39", qty: 1, price: 3070 }],
    ...over,
  })

  it("shows the customer, items, value and a cart link that refills the bag; closes when the order arrives", async () => {
    const { t, as, post, lead } = await setup()
    expect(await (await lead(checkoutLead())).json()).toMatchObject({ ok: true, res: "added" })
    // abandoned = nothing happened for 15 minutes
    await t.run(async (ctx) => { const c = (await ctx.db.query("checkouts").first())!; await ctx.db.patch(c._id, { shopUpdatedAt: Date.now() - 20 * 60000, shopCreatedAt: Date.now() - 20 * 60000 }) })
    const rows = (await as.query(api.checkouts.list, { tab: "new" }))!
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "webcheckout", customerName: "Test Customer", phone: "01711000001", email: "t@example.com", cityName: "Dhaka",
      subtotal: 2 * 1480 + 3070, deliveryFee: 90, total: 2 * 1480 + 3070 + 90,
      recoveryUrl: "https://blackbole.com/cart?add=42893397000329:2,48701337075849:1",
    })
    expect(rows[0].items.map((i) => [i.sku, i.qty, i.price, !!i.variantId])).toEqual([["BB-HSS-41", 2, 1480, true], ["PO-RCS-BR-39", 1, 3070, true]])
    // the customer pays later: the order closes the lead and links it
    await post(body({ paid_amount: 3050 }))
    expect(await as.query(api.checkouts.list, { tab: "new" })).toHaveLength(0)
    const done = (await as.query(api.checkouts.list, { tab: "ordered" }))!
    expect(done).toHaveLength(1)
    expect(done[0].orderInvoice).toMatch(/^BB-/)
  })

  it("a lead that arrives just after its order (same moment) does not reopen a cart", async () => {
    const { t, post, lead } = await setup()
    await post(body())
    expect(await (await lead(checkoutLead())).json()).toMatchObject({ res: "already ordered" })
    expect(await t.run((ctx) => ctx.db.query("checkouts").collect())).toHaveLength(0)
  })

  it("COD popup lead: link from the variant ids; without ids it keeps the page link", async () => {
    const { t, lead } = await setup()
    await lead({ phone: "01811000002", name: "Popup", address: "Agrabad, Chattogram", zone: "outside", url: "https://blackbole.com/products/x", items: [{ id: 42893397000329, title: "Harbor Shore Sandal - Black", variant: "EU 41", qty: 1, price: 1480 }] })
    await lead({ phone: "01811000003", name: "Popup", address: "Agrabad, Chattogram", zone: "outside", url: "https://blackbole.com/products/x", items: [{ title: "Harbor Shore Sandal - Black", variant: "EU 41", qty: 1, price: 1480 }] })
    const rows = await t.run((ctx) => ctx.db.query("checkouts").collect())
    expect(rows.find((r) => r.phone === "01811000002")).toMatchObject({ kind: "codform", recoveryUrl: "https://blackbole.com/cart?add=42893397000329:1", total: 1480 + 130 })
    expect(rows.find((r) => r.phone === "01811000003")).toMatchObject({ recoveryUrl: "https://blackbole.com/products/x" })
  })

  it("cartLink only builds website links from whole variant ids", () => {
    expect(cartLink("https://blackbole.com/checkout", [{ id: 1, qty: 2 }])).toBe("https://blackbole.com/cart?add=1:2")
    expect(cartLink("javascript:alert(1)", [{ id: 1, qty: 1 }])).toBeNull()
    expect(cartLink(undefined, [{ id: 1, qty: 1 }])).toBeNull()
    expect(cartLink("https://blackbole.com/", [{ id: 1, qty: 1 }, { qty: 1 }])).toBeNull()
    expect(cartLink("https://blackbole.com/", [{ id: 1, qty: 99 }])).toBe("https://blackbole.com/cart?add=1:10")
  })
})
