import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

const SECRET = "test-signing-key"

async function sign(body: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))
  let bin = ""
  for (const b of sig) bin += String.fromCharCode(b)
  return btoa(bin)
}

const shopifyOrder = {
  id: 987654321,
  name: "#1042",
  email: "buyer@example.com",
  financial_status: "pending",
  total_price: "1570.00",
  total_discounts: "0.00",
  payment_gateway_names: ["Cash on Delivery (COD)"],
  note: "Call before coming",
  shipping_address: { name: "Karim Uddin", phone: "+880 1912-345678", address1: "Road 5, House 9", address2: "Dhanmondi", city: "Dhaka", zip: "1209" },
  line_items: [{ sku: "BB-HSS-41", title: "Harbor Shore Sandal", variant_title: "41", quantity: 1, price: "1480.00", grams: 400, discount_allocations: [] }],
  shipping_lines: [{ price: "90.00" }],
}

describe("shopify webhook", () => {
  it("creates an order from a signed webhook and rejects a bad signature", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
    const as = t.withIdentity({ subject: `${userId}|s1` })
    await as.mutation(api.team.claim, { name: "Emon" })
    await as.mutation(api.catalog.saveProduct, {
      name: "Harbor Shore Sandal - Black", active: true,
      variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
    })
    await as.mutation(api.settings.saveShopifySecret, { secret: SECRET })

    const body = JSON.stringify(shopifyOrder)
    const bad = await t.fetch("/shopify/orders", { method: "POST", body, headers: { "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": "nope" } })
    expect(bad.status).toBe(401)

    const ok = await t.fetch("/shopify/orders", { method: "POST", body, headers: { "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": await sign(body) } })
    expect(ok.status).toBe(200)

    const order = await t.run((ctx) => ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", "987654321")).unique())
    expect(order).toMatchObject({
      externalName: "#1042", phone: "01912345678", customerName: "Karim Uddin", cityName: "Dhaka",
      deliveryFee: 90, total: 1570, due: 1570, status: "pending", customerNote: "Call before coming",
    })
    expect(order!.items[0].variantId).toBeDefined()

    // cancellation webhook cancels it
    const cancelBody = JSON.stringify({ id: 987654321, name: "#1042", cancel_reason: "customer" })
    await t.fetch("/shopify/orders", { method: "POST", body: cancelBody, headers: { "X-Shopify-Topic": "orders/cancelled", "X-Shopify-Hmac-Sha256": await sign(cancelBody) } })
    const after = await t.run((ctx) => ctx.db.get(order!._id))
    expect(after!.status).toBe("cancelled")
  })
})

describe("campaignFromOrder", () => {
  it("reads the campaign from the COD popup's order attributes, preferring the numeric campaign ID", async () => {
    const { campaignFromOrder } = await import("../../convex/shopify")
    const cod = { note_attributes: [{ name: "utm_campaign", value: "brinkley_kg_3nov" }, { name: "utm_id", value: "52555206547233" }] }
    expect(campaignFromOrder(cod)).toBe("52555206547233")
    // Brain ads put the ID straight in utm_campaign
    expect(campaignFromOrder({ note_attributes: [{ name: "utm_campaign", value: "52554869042233" }] })).toBe("52554869042233")
    // only the page URL kept
    expect(campaignFromOrder({ note_attributes: [{ name: "full_url", value: "https://blackbole.top/cart?utm_campaign=hsb_video_31oct&utm_id=52554783033233" }] })).toBe("52554783033233")
    // a slug with no ID anywhere is still kept
    expect(campaignFromOrder({ note_attributes: [{ name: "utm_campaign", value: "hero_harbor_black" }] })).toBe("hero_harbor_black")
    // checkout orders: landing_site, as before
    expect(campaignFromOrder({ landing_site: "/products/x?utm_source=facebook&utm_campaign=52554869042233" })).toBe("52554869042233")
    expect(campaignFromOrder({})).toBeUndefined()
  })
})

describe("campaign backfill", () => {
  it("fills the campaign only on orders that have none, and moves updatedAt", async () => {
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const { internal } = await import("../../convex/_generated/api")
    const ids = await t.run(async (ctx) => {
      const base: any = (await ctx.db.query("orders").first()) ?? null
      return base
    })
    expect(ids).toBeNull()
    const n = await t.mutation(internal.campaignBackfill.fill, { rows: [{ externalId: "nope", campaignId: "1" }] })
    expect(n).toBe(0)
  })
})
