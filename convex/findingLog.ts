// Action Center's audit trail — turns a finding from "here's a problem and a suggestion" into a real record of
// what actually happened: who looked at it, what they decided, what they did, and whether it's resolved.
import { v } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import { requirePerm } from "./lib"

/** Full history for one finding, oldest first. */
export const list = query({
  args: { findingId: v.string() },
  handler: async (ctx, { findingId }) => {
    await requirePerm(ctx, "dashboard.view")
    return await ctx.db.query("findingLogs").withIndex("by_finding", (q) => q.eq("findingId", findingId)).order("asc").collect()
  },
})

/** Latest status per finding, for the status badge — one query covers every finding on the page. */
export const latest = query({
  args: { findingIds: v.array(v.string()) },
  handler: async (ctx, { findingIds }) => {
    await requirePerm(ctx, "dashboard.view")
    const out: Record<string, { status: string; at: number; byName: string }> = {}
    for (const id of findingIds) {
      const row = await ctx.db.query("findingLogs").withIndex("by_finding", (q) => q.eq("findingId", id)).order("desc").first()
      if (row) out[id] = { status: row.status, at: row.at, byName: row.byName }
    }
    return out
  },
})

export const log = mutation({
  args: { findingId: v.string(), text: v.string(), status: v.union(v.literal("open"), v.literal("in_progress"), v.literal("resolved")) },
  handler: async (ctx, { findingId, text, status }) => {
    const s = await requirePerm(ctx, "dashboard.view")
    const clean = text.trim()
    if (!clean) throw new Error("Write what was done before logging it")
    await ctx.db.insert("findingLogs", { findingId, text: clean, status, byName: s.staff.name, at: Date.now() })
  },
})
