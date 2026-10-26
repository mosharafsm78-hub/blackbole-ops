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
    const { codes } = await r.json()
    // off and scheduled codes are not served; percent goes out as a fraction
    expect(codes).toEqual([{ code: "EID10", type: "percent", value: 0.1, scope: "all", items: [], minSubtotal: 1500, onlineOnly: true, used: 0 }])
  })

  it("brings in the Shopify codes once", async () => {
    const { as } = await setup()
    expect(await as.mutation(api.discounts.importShopifyCodes, {})).toBe(14)
    const list = await as.query(api.discounts.list, {})
    expect(list!.find((d) => d.code === "ADVANCE5")).toMatchObject({ type: "percent", value: 5, scope: "collections", items: ["ready-to-ship-advance5"], onlineOnly: true })
    await expect(as.mutation(api.discounts.importShopifyCodes, {})).rejects.toThrow(/already exist/)
  })
})
