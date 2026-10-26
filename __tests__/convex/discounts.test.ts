import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { statusOf, validateDiscount } from "../../convex/discounts"

const FEED_KEY = "feed-key-for-tests-0123456789"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}

afterEach(() => { vi.unstubAllEnvs() })

const base = { code: "eid10", type: "percent" as const, value: 10, scope: "all" as const, items: [], active: true }

describe("discount validation", () => {
  it("cleans and checks input", () => {
    expect(validateDiscount(base)).toMatchObject({ code: "EID10", value: 10, items: [] })
    expect(() => validateDiscount({ ...base, code: " " })).toThrow(/Enter a discount code/)
    expect(() => validateDiscount({ ...base, code: "EID@10" })).toThrow(/letters, numbers/)
    expect(() => validateDiscount({ ...base, value: 0 })).toThrow(/between 1 and 100/)
    expect(() => validateDiscount({ ...base, value: 120 })).toThrow(/between 1 and 100/)
    expect(() => validateDiscount({ ...base, type: "amount", value: -5 })).toThrow(/above/)
    expect(() => validateDiscount({ ...base, scope: "collections" })).toThrow(/at least one collection/)
    expect(() => validateDiscount({ ...base, startsAt: 2000, endsAt: 1000 })).toThrow(/end date/)
    expect(validateDiscount({ ...base, code: "thanks for 1st order" }).code).toBe("THANKS FOR 1ST ORDER")
  })

  it("works out the status", () => {
    const now = 10_000
    expect(statusOf({ active: false }, now)).toBe("off")
    expect(statusOf({ active: true, startsAt: 20_000 }, now)).toBe("scheduled")
    expect(statusOf({ active: true, endsAt: 5_000 }, now)).toBe("expired")
    expect(statusOf({ active: true, usageLimit: 2, usedCount: 2 }, now)).toBe("used_up")
    expect(statusOf({ active: true }, now)).toBe("active")
  })
})

describe("discounts in Ops", () => {
  it("saves, refuses duplicates, and serves the website feed", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    await as.mutation(api.discounts.save, { ...base, minSubtotal: 1500, onlineOnly: true })
    await expect(as.mutation(api.discounts.save, { ...base, code: "EID10" })).rejects.toThrow(/already exists/)
    await as.mutation(api.discounts.save, { code: "OFF150", type: "amount", value: 150, scope: "collections", items: ["sandals"], active: false })
    await as.mutation(api.discounts.save, { code: "LATER", type: "percent", value: 5, scope: "all", items: [], active: true, startsAt: Date.now() + 86_400_000 })

    expect((await t.fetch("/website/discounts")).status).toBe(401)
    const r = await t.fetch("/website/discounts", { headers: { "X-Feed-Key": FEED_KEY } })
    const { codes, total } = await r.json()
    expect(total).toBe(3)
    // off and scheduled codes are not served; percent goes out as a fraction
    expect(codes).toEqual([{ code: "EID10", type: "percent", value: 0.1, scope: "all", items: [], minSubtotal: 1500, onlineOnly: true, used: 0 }])
  })

  it("keeps the Shopify codes in the feed exactly as before (older websites read only `codes`)", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    await as.mutation(api.discounts.importShopifyCodes, {})
    const { codes, extra, total } = await (await t.fetch("/website/discounts", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(total).toBe(14)
    expect(extra).toEqual([])
    const by = (c: string) => codes.find((x: any) => x.code === c)
    expect(by("ADVANCE5")).toEqual({ code: "ADVANCE5", type: "percent", value: 0.05, scope: "collections", items: ["ready-to-ship-advance5"], onlineOnly: true, used: 0 })
    expect(by("FIFA150")).toEqual({ code: "FIFA150", type: "amount", value: 150, scope: "all", items: [], minSubtotal: 2000, used: 0 })
    expect(by("THANKS FOR 1ST ORDER")).toEqual({ code: "THANKS FOR 1ST ORDER", type: "percent", value: 0.1, scope: "products", items: ["chunky-loafer-black-edition"], used: 0 })
    for (const c of codes) expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(["code", "type", "value", "scope", "items", "used"]))
    for (const c of codes) for (const k of ["kind", "automatic", "combines", "minQty", "buyQty"]) expect(c).not.toHaveProperty(k)
  })

  it("automatic discounts, Buy X get Y, free shipping and combinations go to the website in `extra`", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const autoId = await as.mutation(api.discounts.save, { method: "automatic", kind: "shipping", code: "", title: "Eid free delivery", type: "amount", value: 0, scope: "collections", items: ["x"], active: true, minSubtotal: 2000, usageLimit: 5, oncePerCustomer: true, combines: { products: true, shipping: true } })
    await as.mutation(api.discounts.save, { kind: "bxgy", code: "b2g1", type: "percent", value: 100, scope: "collections", items: ["sandals"], buyQty: 2, buyScope: "all", buyItems: [], getQty: 1, maxUses: 1, active: true })
    await as.mutation(api.discounts.save, { kind: "products", code: "san10", type: "percent", value: 10, scope: "collections", items: ["sandals"], minQty: 2, active: true, combines: { order: true } })
    await as.mutation(api.discounts.save, { kind: "order", code: "order5", type: "percent", value: 5, scope: "products", items: ["a"], active: true, combines: { shipping: true, order: true } })
    const auto = (await as.query(api.discounts.get, { id: autoId }))!
    expect(auto.code).toMatch(/^AUTO-[A-Z0-9]{8}$/)
    // automatic discounts have no usage limits (like Shopify); free shipping is the whole order
    expect(auto).toMatchObject({ method: "automatic", kind: "shipping", type: "percent", value: 100, scope: "all", items: [], combines: { products: true } })
    expect(auto.usageLimit).toBeUndefined()
    expect(auto.oncePerCustomer).toBeUndefined()

    const { codes, extra, total } = await (await t.fetch("/website/discounts", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(total).toBe(4)
    // an order discount without new features stays readable by older websites
    expect(codes).toEqual([{ code: "ORDER5", type: "percent", value: 0.05, scope: "all", items: [], used: 0, combines: { shipping: true } }])
    const by = (c: string) => extra.find((x: any) => x.code === c)
    expect(by(auto.code)).toEqual({ code: auto.code, type: "percent", value: 1, scope: "all", items: [], minSubtotal: 2000, used: 0, kind: "shipping", automatic: true, title: "Eid free delivery", combines: { products: true } })
    expect(by("B2G1")).toEqual({ code: "B2G1", type: "percent", value: 1, scope: "collections", items: ["sandals"], used: 0, kind: "bxgy", buyQty: 2, buyScope: "all", buyItems: [], getQty: 1, maxUses: 1 })
    expect(by("SAN10")).toMatchObject({ minQty: 2, combines: { order: true } })

    // automatic discounts can't be typed as codes
    const check = await (await t.fetch(`/website/discount-check?code=${auto.code}&phone=01711111111`, { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(check.ok).toBe(false)
  })

  it("checks the new kinds before saving", () => {
    expect(() => validateDiscount({ ...base, method: "automatic" })).toThrow(/title for the automatic/)
    expect(() => validateDiscount({ ...base, code: "AUTO-X" })).toThrow(/AUTO-/)
    expect(() => validateDiscount({ ...base, minSubtotal: 100, minQty: 2 })).toThrow(/either a minimum amount or a minimum number/)
    expect(() => validateDiscount({ ...base, kind: "bxgy", buyQty: 2, getQty: null })).toThrow(/customer gets/)
    expect(() => validateDiscount({ ...base, kind: "bxgy", buyQty: 2, getQty: 1, buyScope: "products", buyItems: [] })).toThrow(/at least one product the customer buys/)
    expect(() => validateDiscount({ ...base, kind: "bxgy", buyQty: 2, getQty: 1, scope: "collections", items: [] })).toThrow(/at least one collection the customer gets/)
    // a product discount can't "combine" with another product discount (one per kind)
    expect(validateDiscount({ ...base, kind: "products", scope: "products", items: ["a"], combines: { products: true, shipping: true } }).combines).toEqual({ shipping: true })
    // older-style rows keep no kind
    expect(validateDiscount(base).kind).toBeUndefined()
    expect(validateDiscount({ ...base, scope: "collections", items: ["x"] }).kind).toBeUndefined()
  })

  it("counts automatic discounts used on website orders", async () => {
    const { t, as } = await setup()
    const id = await as.mutation(api.discounts.save, { method: "automatic", kind: "order", code: "", title: "Eid 10", type: "percent", value: 10, scope: "all", items: [], active: true })
    const auto = (await as.query(api.discounts.get, { id }))!
    const { recordAutomaticUses } = await import("../../convex/discounts")
    await t.run((ctx) => recordAutomaticUses(ctx, [auto.code.toLowerCase(), auto.code, "FIFA150"]))
    expect((await as.query(api.discounts.get, { id }))!.usedCount).toBe(1)
  })

  it("brings in the Shopify codes once", async () => {
    const { as } = await setup()
    expect(await as.mutation(api.discounts.importShopifyCodes, {})).toBe(14)
    const list = await as.query(api.discounts.list, {})
    expect(list!.find((d) => d.code === "ADVANCE5")).toMatchObject({ type: "percent", value: 5, scope: "collections", items: ["ready-to-ship-advance5"], onlineOnly: true })
    await expect(as.mutation(api.discounts.importShopifyCodes, {})).rejects.toThrow(/already exist/)
  })
})
