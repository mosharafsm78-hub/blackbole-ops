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

  it("sends the Ops price (and the website price beside it), and one product live by name", async () => {
    const t = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    await t.run(async (ctx) => {
      const vr = (await ctx.db.query("variants").collect()).find((x) => x.sku === "BB-HSS-41")!
      await ctx.db.patch(vr._id, { price: 2280, web: { ...(vr.web ?? {}), price: 1980 } })
    })
    const one = await (await t.fetch(`/marketing/product?name=${encodeURIComponent("Harbor Shore Sandal - Black")}`, { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(one.stock).toEqual([expect.objectContaining({ sku: "BB-HSS-41", price: 2280, webPrice: 1980 })])
    const none = await (await t.fetch("/marketing/product?name=Nope", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(none.stock).toEqual([])
    expect((await t.fetch("/marketing/product?name=x")).status).toBe(401)
  })
})

describe("target feed", () => {
  it("needs the feed key", async () => {
    const { convexTest } = await import("convex-test")
    const schema = (await import("../../convex/schema")).default
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    const res = await t.fetch("/marketing/target", { method: "GET" })
    expect(res.status).toBe(401)
  })
})

describe("target feed without a signed-in person", () => {
  it("computes the month for Marketing OS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"))
    const { convexTest } = await import("convex-test")
    const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
    await t.run(async (ctx) => { await ctx.db.insert("revenueTargets", { month: "2026-11", amount: 1200000, setByName: "Emon", updatedAt: 0, start: "2026-11-01" }) })
    const p = await t.action((await import("../../convex/_generated/api")).internal.targets.progressForFeed, {})
    expect(p.target?.amount).toBe(1200000)
    expect(p.plan?.focus?.target).toBeGreaterThan(0)
    expect(p.profit).toBeNull()
    vi.useRealTimers()
  })
})

describe("push to Marketing OS", () => {
  it("collects changed products for a few seconds and sends their names once, signed with the feed key", async () => {
    vi.useFakeTimers()
    const t = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const calls: { url: string; init: any }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}") }))
    const { marketingChanged } = await import("../../convex/marketingPush")
    await t.run(async (ctx) => {
      const vr = (await ctx.db.query("variants").collect()).find((x) => x.sku === "BB-HSS-41")!
      await marketingChanged(ctx, { variantId: vr._id })
      await marketingChanged(ctx, { variantId: vr._id })
    })
    vi.advanceTimersByTime(5000)
    await t.finishInProgressScheduledFunctions()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/ops\/changed$/)
    expect(calls[0].init.headers["X-Feed-Key"]).toBe(FEED_KEY)
    expect(JSON.parse(calls[0].init.body)).toEqual({ products: ["Harbor Shore Sandal - Black"], all: false })
    vi.useRealTimers()
  })
})

describe("clearance discount for Marketing OS", () => {
  it("creates a product-scoped percent code and re-points it on the next call", async () => {
    const t = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const post = (body: unknown) => t.fetch("/marketing/discount", { method: "POST", headers: { "X-Feed-Key": FEED_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    expect((await post({ code: "LASTPAIRS10", percent: 10, handles: ["a-shoe"] })).status).toBe(200)
    const again = await (await post({ code: "LASTPAIRS10", title: "Last pairs – 10% off", percent: 10, handles: ["a-shoe", "b-shoe"], days: 5 })).json()
    expect(again).toMatchObject({ ok: true, code: "LASTPAIRS10" })
    const rows = await t.run(async (ctx) => ctx.db.query("discounts").collect())
    expect(rows.filter((d) => d.code === "LASTPAIRS10")).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: "percent", value: 10, scope: "products", items: ["a-shoe", "b-shoe"], active: true })
    expect((await post({ code: "X", percent: 80, handles: ["a"] })).status).toBe(400)
    expect((await t.fetch("/marketing/discount", { method: "POST", body: "{}" })).status).toBe(401)
  })
})
