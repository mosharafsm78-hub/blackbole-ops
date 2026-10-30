import { convexTest } from "convex-test"
import { describe, expect, it } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"
import { abandonedEmailContent, parseGift } from "../../convex/emailTemplates"

const makeT = () => convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
const H = 3600000

async function cart(t: ReturnType<typeof makeT>, over: Record<string, unknown> = {}) {
  return t.run((ctx) => ctx.db.insert("checkouts", {
    checkoutId: `c-${Math.random()}`, customerName: "Gift box · won Tk 500 (BB-X9U8UN)", phone: "01711111111", email: "a@b.com", address: "",
    items: [{ sku: "S", name: "Wave Sneaker", price: 2994, qty: 1, discount: 0, weightKg: 0.5 }], subtotal: 2994, discount: 0, deliveryFee: 90, total: 3084,
    shopCreatedAt: Date.now() - 2 * H, shopUpdatedAt: Date.now() - 2 * H, status: "open", callCount: 0, ...over,
  } as any))
}

describe("abandoned cart email", () => {
  it("reads the gift out of the lead name and builds the email", () => {
    expect(parseGift("Gift box · won Tk 500 (BB-X9U8UN)")).toEqual({ amount: 500, code: "BB-X9U8UN" })
    const m = abandonedEmailContent({ customerName: "Gift box · won Tk 500 (BB-X9U8UN)", items: [{ name: "Wave Sneaker", price: 2994, qty: 1, attrs: "43" }], subtotal: 2994, url: "https://blackbole.com/cart?add=1:1" })
    expect(m.subject).toContain("500")
    expect(m.html).toContain("BB-X9U8UN")
    expect(m.html).toContain("Complete my order")
    const f = abandonedEmailContent({ customerName: "Rafi Khan", items: [], subtotal: 0, step: 2, picks: [{ name: "Other Boot", price: 3500, url: "https://blackbole.com/products/x" }] })
    expect(f.subject).toContain("Rafi")
    expect(f.subject.toLowerCase()).toContain("still")
    expect(f.html).toContain("Other Boot")
  })

  it("emails new carts once, then every 2 days, and stops after an order, a failure or 5 emails", async () => {
    const t = makeT()
    const fresh = await cart(t)
    const tooNew = await cart(t, { shopUpdatedAt: Date.now() - 10 * 60000 })
    const noEmail = await cart(t, { email: undefined })
    const sentToday = await cart(t, { emailSentAt: Date.now() - 5 * H, emailCount: 1 })
    const due = await cart(t, { emailSentAt: Date.now() - 48 * H, emailCount: 1 })
    const done5 = await cart(t, { emailSentAt: Date.now() - 48 * H, emailCount: 5 })
    const failed = await cart(t, { emailSentAt: Date.now() - 48 * H, emailCount: 0, emailError: "smtp down" })
    const archived = await cart(t, { isArchived: true })
    const ids = await t.query(internal.abandonedEmail.candidates, {})
    expect(new Set(ids)).toEqual(new Set([fresh, due]))
    expect([tooNew, noEmail, sentToday, done5, failed, archived].some((x) => ids.includes(x))).toBe(false)
  })

  it("records a sent email on the cart and in the log", async () => {
    const t = makeT()
    const id = await cart(t)
    await t.mutation(internal.abandonedEmail.markResult, { checkoutId: id, subject: "Hi" })
    const c = await t.run((ctx) => ctx.db.get(id))
    expect(c?.emailCount).toBe(1)
    expect(c?.emailSentAt).toBeGreaterThan(0)
    const logs = await t.run((ctx) => ctx.db.query("smsLogs").collect())
    expect(logs[0]).toMatchObject({ phone: "a@b.com", channel: "email", status: "sent" })
  })
})
