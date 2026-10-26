import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

const SECRET = "test-signing-key"
const FEED_KEY = "feed-key-for-tests-0123456789"

async function sign(body: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))
  let bin = ""
  for (const b of sig) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  await as.mutation(api.catalog.saveProduct, {
    name: "Harbor Shore Sandal - Black", active: true,
    variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }],
  })
  await as.mutation(api.settings.saveShopifySecret, { secret: SECRET })
  const body = JSON.stringify({
    id: 555, name: "#2001", financial_status: "pending", total_price: "1570.00", total_discounts: "0.00",
    payment_gateway_names: ["Cash on Delivery (COD)"],
    landing_site: "/products/harbor?utm_source=facebook&utm_campaign=52550715827833",
    referring_site: "https://m.facebook.com/",
    shipping_address: { name: "Karim Uddin", phone: "+880 1912-345678", address1: "Road 5", city: "Dhaka" },
    line_items: [{ sku: "BB-HSS-41", title: "Harbor Shore Sandal", variant_title: "41", quantity: 1, price: "1480.00", grams: 400, discount_allocations: [] }],
    shipping_lines: [{ price: "90.00" }],
  })
  const res = await t.fetch("/shopify/orders", { method: "POST", body, headers: { "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": await sign(body) } })
  expect(res.status).toBe(200)
  return t
}

afterEach(() => vi.unstubAllEnvs())

describe("marketing feed", () => {
  it("is off without a key and refuses a wrong key", async () => {
    const t = await setup()
    expect((await t.fetch("/marketing/orders", { headers: { "X-Feed-Key": FEED_KEY } })).status).toBe(401)
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    expect((await t.fetch("/marketing/orders", { headers: { "X-Feed-Key": "wrong" } })).status).toBe(401)
    expect((await t.fetch("/marketing/stock")).status).toBe(401)
  })

  it("returns changed orders with the ad campaign and a hashed phone, never the raw phone", async () => {
    const t = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const res = await t.fetch("/marketing/orders?since=0", { headers: { "X-Feed-Key": FEED_KEY } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.orders).toHaveLength(1)
    const o = data.orders[0]
    expect(o).toMatchObject({ campaignId: "52550715827833", status: "pending", total: 1570, city: "Dhaka" })
    expect(o.items[0]).toMatchObject({ sku: "BB-HSS-41", qty: 1, price: 1480 })
    expect(o.phone).toBeUndefined()
    expect(o.phoneHash).toBe(await sha256("8801912345678"))
    expect(JSON.stringify(data)).not.toContain("1912345678")
    expect(data.next).toBe(o.updatedAt)

    // nothing newer than the last change
    const later = await (await t.fetch(`/marketing/orders?since=${o.updatedAt + 1}`, { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(later.orders).toHaveLength(0)
    expect(later.more).toBe(false)
  })

  it("returns stock per SKU", async () => {
    const t = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const data = await (await t.fetch("/marketing/stock", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(data.stock).toEqual([expect.objectContaining({ sku: "BB-HSS-41", product: "Harbor Shore Sandal - Black", variant: "41" })])
    expect(typeof data.stock[0].available).toBe("number")
  })
})
