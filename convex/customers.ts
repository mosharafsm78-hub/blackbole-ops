import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { currentStaff, requirePerm } from "./lib"
import { normalizePhone } from "./rules"

export const list = query({
  args: { search: v.optional(v.string()), tag: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { search, tag, limit }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const term = (search ?? "").trim()
    let rows
    if (term) {
      const phone = normalizePhone(term)
      if (/^01\d{3,}/.test(phone)) {
        rows = (await ctx.db.query("customers").withIndex("by_created").order("desc").take(5000)).filter((c) => c.phone.includes(phone))
      } else {
        rows = await ctx.db.query("customers").withSearchIndex("search_name", (q) => q.search("name", term)).take(100)
      }
    } else {
      rows = await ctx.db.query("customers").withIndex("by_created").order("desc").take(tag ? 5000 : limit + 1)
    }
    if (tag) rows = rows.filter((c) => c.tag === tag)
    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "customer")).unique()
    const total = counter ? counter.value - 10000 : 0
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit, total }
  },
})

export const byPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const p = normalizePhone(phone)
    if (!/^01\d{9}$/.test(p)) return null
    return await ctx.db.query("customers").withIndex("by_phone", (q) => q.eq("phone", p)).unique()
  },
})

export const get = query({
  args: { id: v.id("customers") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const customer = await ctx.db.get(id)
    if (!customer) return { missing: true as const }
    const orders = await ctx.db.query("orders").withIndex("by_customer", (q) => q.eq("customerId", id)).order("desc").take(100)
    return { missing: false as const, customer, orders }
  },
})

export const update = mutation({
  args: { id: v.id("customers"), name: v.string(), email: v.optional(v.string()), address: v.optional(v.string()), tag: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "customers.manage")
    await ctx.db.patch(a.id, { name: a.name, email: a.email, address: a.address, tag: a.tag, note: a.note })
  },
})
