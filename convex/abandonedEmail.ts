// Automatic "finish your order" email for abandoned carts that left an email address.
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation, mutation } from "./functions"
import { requirePerm } from "./lib"
import { ABANDON_AFTER, laterOrderFor } from "./checkouts"

const BD_OFFSET = 6 * 3600000
const REPEAT_EVERY = 47 * 3600000 // a reminder every 2 days
const MAX_EMAILS = 5 // first email + 4 reminders, then stop
const MAX_AGE = 14 * 3600000 * 24 // carts older than 2 weeks are too cold
const PER_RUN = 20
export const validEmail = (e?: string) => !!e && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e.trim())

export const get = internalQuery({ args: { checkoutId: v.id("checkouts") }, handler: async (ctx, { checkoutId }) => ctx.db.get(checkoutId) })

/** Open carts with an email, left 30+ minutes ago, not ordered since: first email, then one every 2 days (max 5). */
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

/** Other products to show in the email: newest published ones with a picture and a price. */
export const picks = internalQuery({
  args: { exclude: v.array(v.string()) },
  handler: async (ctx) => {
    const out: { name: string; imageUrl?: string; price: number; url: string }[] = []
    for await (const p of ctx.db.query("products").order("desc")) {
      if (out.length >= 4) break
      if (!p.active || !p.imageUrl || !p.handle || p.web?.published === false || p.web?.archived) continue
      const v = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).first()
      if (!v) continue
      out.push({ name: p.web?.title || p.name, imageUrl: p.imageUrl, price: (v.web?.price as number) || v.price, url: `https://blackbole.com/products/${p.handle}` })
    }
    return out
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
