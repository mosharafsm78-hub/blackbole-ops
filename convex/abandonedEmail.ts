// Automatic "finish your order" email for abandoned carts that left an email address.
import { v } from "convex/values"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation, mutation } from "./functions"
import { currentStaff, requirePerm } from "./lib"
import { ABANDON_AFTER, laterOrderFor } from "./checkouts"

const BD_OFFSET = 6 * 3600000
const REPEAT_EVERY = 47 * 3600000 // a reminder every 2 days
const MAX_EMAILS = 15 // a safety stop: one every 2 days for a month
const MAX_AGE = 30 * 24 * 3600000 // carts older than a month are too cold
const PER_RUN = 20
export const validEmail = (e?: string) => !!e && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e.trim())

export const get = internalQuery({ args: { checkoutId: v.id("checkouts") }, handler: async (ctx, { checkoutId }) => ctx.db.get(checkoutId) })

/** Open carts with an email, left 30+ minutes ago, not ordered since: first email, then one every 2 days until they order (stops after a month). */
export const candidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(300)
    const out: Id[] = []
    for (const c of rows) {
      if (out.length >= PER_RUN) break
      if (c.isArchived || !validEmail(c.email)) continue
      if (now - c.shopUpdatedAt < ABANDON_AFTER * 2 || now - c.shopUpdatedAt > MAX_AGE) continue
      // first email once; then a reminder every 2 days until they order (a failed send is not repeated by itself)
      if (c.emailSentAt && (c.emailError || (c.emailCount ?? 0) >= MAX_EMAILS || now - c.emailSentAt < REPEAT_EVERY)) continue
      if (await laterOrderFor(ctx, c)) continue
      out.push(c._id)
    }
    return out
  },
})
type Id = import("./_generated/dataModel").Id<"checkouts">

export const markResult = internalMutation({
  args: { checkoutId: v.id("checkouts"), subject: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { checkoutId, subject, error }) => {
    const c = await ctx.db.get(checkoutId)
    if (!c) return
    await ctx.db.patch(checkoutId, error ? { emailError: error, emailSentAt: Date.now() } : { emailSentAt: Date.now(), emailCount: (c.emailCount ?? 0) + 1, emailError: undefined })
    await ctx.db.insert("smsLogs", { phone: c.email ?? "", text: subject, status: error ? "failed" : "sent", error, channel: "email", at: Date.now() })
  },
})

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const bdHour = new Date(Date.now() + BD_OFFSET).getUTCHours()
    if (bdHour < 9 || bdHour >= 22) return
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    if (!email?.enabled) return
    for (const id of await ctx.runQuery(internal.abandonedEmail.candidates, {})) {
      await ctx.runAction(internal.emailNode.sendAbandonedEmail, { checkoutId: id })
    }
  },
})

/** Team button: send (or send again) the email for one cart right now. */
export const sendNow = mutation({
  args: { id: v.id("checkouts") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(id)
    if (!c || !validEmail(c.email)) throw new Error("This cart has no valid email address")
    await ctx.scheduler.runAfter(0, internal.emailNode.sendAbandonedEmail, { checkoutId: id })
  },
})

/** Pre-order products to show in the email. Each email moves on to the next 8 (wrapping round), so the customer sees new ones every time. */
export const picks = internalQuery({
  args: { exclude: v.array(v.string()), step: v.optional(v.number()), kind: v.optional(v.string()) },
  handler: async (ctx, { exclude, step, kind }) => {
    const wantPre = kind !== "regular" && kind !== "welcome"
    const all: { name: string; imageUrl?: string; price: number; url: string }[] = []
    for await (const p of ctx.db.query("products").order("desc")) {
      if (all.length >= 120) break
      if (exclude.includes(p.name)) continue // already in their cart
      if (!p.active || !p.imageUrl || !p.handle || p.web?.published === false || p.web?.archived) continue
      const isPre = !!p.preOrder || ((p.web?.tags as string[] | undefined) ?? []).some((t) => t.toLowerCase() === "pre-order")
      // pre-order emails show pre-order products only (this grows the pre-order model); normal emails show normal products that are in stock
      if (wantPre !== isPre) continue
      const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).take(30)
      const v = vs[0]
      if (!v) continue
      if (!wantPre) {
        let inStock = false
        for (const x of vs) {
          const rows = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", x._id)).collect()
          if (rows.some((r) => r.available > 0)) { inStock = true; break }
        }
        if (!inStock) continue
      }
      // pre-order web price is only the booking money, so show the pair's full price
      all.push({ name: p.web?.title || p.name, imageUrl: p.imageUrl, price: wantPre ? v.price : (v.web?.price as number) || v.price, url: `https://blackbole.com/products/${p.handle}` })
    }
    if (all.length <= 8) return all
    const start = (((step ?? 1) - 1) * 8) % all.length
    return Array.from({ length: 8 }, (_, k) => all[(start + k) % all.length])
  },
})

/** What kind of email this cart gets: "welcome" = left the Tk 50 popup with no products; "preorder" = gift-box / pre-order
 *  product; "regular" = a normal product. Also returns the product page to send them back to. */
export const context = internalQuery({
  args: { checkoutId: v.id("checkouts") },
  handler: async (ctx, { checkoutId }) => {
    const c = await ctx.db.get(checkoutId)
    if (!c) return null
    let kind: "welcome" | "preorder" | "regular" = c.items.length === 0 ? "welcome" : "regular"
    let productUrl: string | null = null
    if (/won\s+Tk/i.test(c.customerName)) kind = "preorder"
    for (const i of c.items) {
      const vr = i.variantId ? await ctx.db.get(i.variantId) : null
      const p = vr ? await ctx.db.get(vr.productId) : null
      if (!p) continue
      if (!productUrl && p.handle) productUrl = `https://blackbole.com/products/${p.handle}`
      if (p.preOrder || ((p.web?.tags as string[] | undefined) ?? []).some((t) => t.toLowerCase() === "pre-order")) kind = "preorder"
    }
    return { kind, productUrl }
  },
})

/** The product page the customer was on (the pre-order page with the gift box), so the email takes them back there. */
export const productUrl = internalQuery({
  args: { checkoutId: v.id("checkouts") },
  handler: async (ctx, { checkoutId }) => {
    const c = await ctx.db.get(checkoutId)
    for (const i of c?.items ?? []) {
      const vr = i.variantId ? await ctx.db.get(i.variantId) : null
      const p = vr ? await ctx.db.get(vr.productId) : null
      if (p?.handle) return `https://blackbole.com/products/${p.handle}`
    }
    return null
  },
})

/** Numbers for the strip at the top of the Abandoned carts page. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) return null
    const dayStart = Math.floor((Date.now() + BD_OFFSET) / 86400000) * 86400000 - BD_OFFSET
    let carts = 0, emails = 0, today = 0, failed = 0, won = 0, waiting = 0
    for (const status of ["open", "ordered", "converted", "lost"]) {
      for (const c of await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(1500)) {
        if (!c.emailSentAt) { if (status === "open" && !c.isArchived && validEmail(c.email)) waiting++; continue }
        carts++
        emails += c.emailCount ?? 0
        if (c.emailSentAt >= dayStart) today++
        if (c.emailError) failed++
        if (status === "ordered" || status === "converted") won++
      }
    }
    return { carts, emails, today, failed, won, waiting }
  },
})
