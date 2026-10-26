// Newsletter sign-ups from the website (footer "Join Now"). The website posts each sign-up to
// POST /website/subscribe (X-Feed-Key = MARKETING_FEED_KEY); staff see them under Website → Subscribers.
import { v, ConvexError } from "convex/values"
import { httpAction, internalMutation, query } from "./_generated/server"
import { internal } from "./_generated/api"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i

/** Adds or refreshes one sign-up (deduplicated by email). */
export const add = internalMutation({
  args: { email: v.string(), name: v.optional(v.string()), phone: v.optional(v.string()), source: v.optional(v.string()), tags: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const email = a.email.trim().toLowerCase().slice(0, 120)
    if (!EMAIL.test(email)) throw new ConvexError("Invalid email")
    const now = Date.now()
    const name = a.name?.trim().slice(0, 60) || undefined
    const phone = a.phone?.trim().slice(0, 20) || undefined
    const old = await ctx.db.query("subscribers").withIndex("by_email", (q) => q.eq("email", email)).first()
    if (old) {
      await ctx.db.patch(old._id, { name: name ?? old.name, phone: phone ?? old.phone, tags: a.tags?.slice(0, 200) || old.tags, updatedAt: now })
      return "updated"
    }
    await ctx.db.insert("subscribers", { email, name, phone, source: (a.source || "footer").slice(0, 30), tags: a.tags?.slice(0, 200) || undefined, createdAt: now, updatedAt: now })
    return "added"
  },
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const rows = await ctx.db.query("subscribers").collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ _id: r._id, email: r.email, name: r.name ?? "", phone: r.phone ?? "", source: r.source, createdAt: r.createdAt }))
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const feedOk = (req: Request) => { const key = process.env.MARKETING_FEED_KEY; return !!key && key.length >= 24 && req.headers.get("X-Feed-Key") === key }

export const subscribeHttp = httpAction(async (ctx, req) => {
  if (!feedOk(req)) return json({ error: "Invalid feed key" }, 401)
  let b: any
  try { b = await req.json() } catch { return json({ error: "Bad request" }, 400) }
  try {
    const res = await ctx.runMutation(internal.subscribers.add, {
      email: String(b?.email ?? ""), name: b?.name ? String(b.name) : undefined, phone: b?.phone ? String(b.phone) : undefined,
      source: b?.source ? String(b.source) : undefined, tags: b?.tags ? String(b.tags) : undefined,
    })
    return json({ ok: true, res })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "error" }, 400)
  }
})
