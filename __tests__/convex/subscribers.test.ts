import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

const FEED_KEY = "feed-key-for-tests-0123456789"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}

afterEach(() => { vi.unstubAllEnvs() })

describe("website subscribers", () => {
  it("needs the feed key, dedupes by email, lists for website managers", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const post = (body: unknown, key = FEED_KEY) => t.fetch("/website/subscribe", { method: "POST", headers: { "X-Feed-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    expect((await post({ email: "a@b.com" }, "wrong-key")).status).toBe(401)
    expect((await post({ email: "not-an-email" })).status).toBe(400)
    expect(await (await post({ email: "Rahim@Mail.com", name: "Rahim", source: "footer" })).json()).toMatchObject({ ok: true, res: "added" })
    expect(await (await post({ email: "rahim@mail.com", phone: "01700000000" })).json()).toMatchObject({ ok: true, res: "updated" })
    const rows = await as.query(api.subscribers.list, {})
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({ email: "rahim@mail.com", name: "Rahim", phone: "01700000000", source: "footer" })
    // not signed in → nothing
    expect(await t.query(api.subscribers.list, {})).toBeNull()
  })
})

describe("website checkout leads", () => {
  it("checkout page leads show as Website checkout and share the phone's lead", async () => {
    const { t } = await setup()
    const lead = (body: unknown) => t.fetch("/cod-lead", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) })
    const r = await (await lead({ phone: "01711111111", name: "Karim", address: "Mirpur", zone: "inside", source: "checkout", items: [{ id: 1, title: "Harbor Shore Sandal", variant: "42", qty: 1, price: 1380 }] })).json()
    expect(r).toMatchObject({ ok: true, res: "added" })
    const rows = await t.run((ctx) => ctx.db.query("checkouts").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkoutId: "codform:01711111111", kind: "webcheckout", status: "open", customerName: "Karim", subtotal: 1380, deliveryFee: 90 })
    // the COD popup (no source) keeps its own kind
    const r2 = await (await lead({ phone: "01722222222", name: "Rina", address: "Agrabad", items: [] })).json()
    expect(r2).toMatchObject({ ok: true, res: "added" })
    const pop = await t.run((ctx) => ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", "codform:01722222222")).first())
    expect(pop!.kind).toBe("codform")
  })
})
