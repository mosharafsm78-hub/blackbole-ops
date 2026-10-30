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
    expect(m.html).toContain("Use this code at checkout")
    expect(m.html).toContain("Go to my pre-order")
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
    const done5 = await cart(t, { emailSentAt: Date.now() - 48 * H, emailCount: 15 })
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

describe("abandoned cart email — product row", () => {
  it("shows only published pre-order products", async () => {
    const t = makeT()
    const mk = (name: string, over: Record<string, unknown>) => t.run(async (ctx) => {
      const id = await ctx.db.insert("products", { name, active: true, imageUrl: "https://x.test/a.jpg", handle: name.toLowerCase().replace(/\s+/g, "-"), createdAt: Date.now(), ...over } as any)
      await ctx.db.insert("variants", { productId: id, sku: name, title: "42", price: 3000, purchasePrice: 1000, weightKg: 0.5, active: true } as any)
    })
    await mk("Pre Boot", { preOrder: true })
    await mk("Tagged Loafer", { web: { tags: ["Pre-Order"] } })
    await mk("Stock Sandal", {})
    await mk("Hidden Pre", { preOrder: true, web: { published: false } })
    const picks = await t.query(internal.abandonedEmail.picks, { exclude: [] })
    expect(picks.map((p) => p.name).sort()).toEqual(["Pre Boot", "Tagged Loafer"])
  })
})

describe("abandoned cart email — 8 products", () => {
  it("lays out 8 pre-order products in two rows", () => {
    const picks = Array.from({ length: 8 }, (_, i) => ({ name: `Boot ${i + 1}`, price: 3000, url: "https://blackbole.com/products/b" + i }))
    const m = abandonedEmailContent({ customerName: "Rafi", items: [], subtotal: 0, picks })
    for (let i = 1; i <= 8; i++) expect(m.html).toContain(`Boot ${i}<`)
    expect(m.html.match(/width="25%"/g)?.length).toBe(8)
  })
})

describe("abandoned cart email — rotating products", () => {
  it("shows a different 8 products in each email", async () => {
    const t = makeT()
    for (let i = 1; i <= 20; i++) {
      await t.run(async (ctx) => {
        const id = await ctx.db.insert("products", { name: `P${i}`, active: true, preOrder: true, imageUrl: "https://x.test/a.jpg", handle: `p${i}`, createdAt: i } as any)
        await ctx.db.insert("variants", { productId: id, sku: `P${i}`, title: "42", price: 3000, purchasePrice: 1000, weightKg: 0.5, active: true } as any)
      })
    }
    const a = await t.query(internal.abandonedEmail.picks, { exclude: [], step: 1 })
    const b = await t.query(internal.abandonedEmail.picks, { exclude: [], step: 2 })
    expect(a).toHaveLength(8)
    expect(b).toHaveLength(8)
    expect(a.some((x) => b.some((y) => y.name === x.name))).toBe(false)
  })
})

describe("abandoned cart email — normal products and the Tk 50 welcome offer", () => {
  it("picks the right kind of email for each cart", async () => {
    const t = makeT()
    const mkProduct = (name: string, over: Record<string, unknown>) => t.run(async (ctx) => {
      const pid = await ctx.db.insert("products", { name, active: true, imageUrl: "https://x.test/a.jpg", handle: name.toLowerCase(), createdAt: 1, ...over } as any)
      const vid = await ctx.db.insert("variants", { productId: pid, sku: name, title: "42", price: 2000, purchasePrice: 900, weightKg: 0.5, active: true } as any)
      return vid
    })
    const normal = await mkProduct("Normal", {})
    const pre = await mkProduct("PreBoot", { preOrder: true })
    const item = (variantId: any) => ({ variantId, sku: "S", name: "X", price: 2000, qty: 1, discount: 0, weightKg: 0.5 })
    const welcome = await cart(t, { customerName: "Customer", items: [] })
    const reg = await cart(t, { customerName: "Rafi Khan", items: [item(normal)] })
    const prec = await cart(t, { customerName: "Rafi Khan", items: [item(pre)] })
    const gift = await cart(t, { items: [] })
    expect((await t.query(internal.abandonedEmail.context, { checkoutId: welcome }))?.kind).toBe("welcome")
    expect((await t.query(internal.abandonedEmail.context, { checkoutId: reg }))?.kind).toBe("regular")
    expect((await t.query(internal.abandonedEmail.context, { checkoutId: prec }))?.kind).toBe("preorder")
    expect((await t.query(internal.abandonedEmail.context, { checkoutId: gift }))?.kind).toBe("preorder")
  })

  it("shows only in-stock normal products in a normal email", async () => {
    const t = makeT()
    await t.run(async (ctx) => {
      const loc = await ctx.db.insert("locations", { name: "W", active: true } as any)
      for (const [name, stock, pre] of [["Stocked", 5, false], ["Empty", 0, false], ["PreOne", 5, true]] as const) {
        const pid = await ctx.db.insert("products", { name, active: true, imageUrl: "https://x.test/a.jpg", handle: name.toLowerCase(), createdAt: 1, ...(pre ? { preOrder: true } : {}) } as any)
        const vid = await ctx.db.insert("variants", { productId: pid, sku: name, title: "42", price: 2000, purchasePrice: 900, weightKg: 0.5, active: true } as any)
        await ctx.db.insert("stock", { variantId: vid, locationId: loc, available: stock, processing: 0, inTransit: 0, returning: 0, damaged: 0 } as any)
      }
    })
    const regular = await t.query(internal.abandonedEmail.picks, { exclude: [], kind: "regular" })
    expect(regular.map((p) => p.name)).toEqual(["Stocked"])
    const preorder = await t.query(internal.abandonedEmail.picks, { exclude: [], kind: "preorder" })
    expect(preorder.map((p) => p.name)).toEqual(["PreOne"])
  })

  it("writes the welcome and normal-cart emails without pre-order wording", () => {
    const w = abandonedEmailContent({ customerName: "Customer", items: [], subtotal: 0, kind: "welcome", url: "https://blackbole.com" })
    expect(w.subject).toContain("50")
    expect(w.html).toContain("WELCOME50")
    expect(w.html).toContain("Start shopping")
    expect(w.html).not.toContain("pre-order")
    const r = abandonedEmailContent({ customerName: "Rafi Khan", items: [{ name: "Boot", price: 2000, qty: 1 }], subtotal: 2000, kind: "regular", url: "https://blackbole.com/cart?add=1:1" })
    expect(r.html).toContain("Back to my cart")
    expect(r.html).toContain("Cash on delivery")
    expect(r.html.toLowerCase()).not.toContain("pre-order")
  })
})
