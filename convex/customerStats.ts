import { v } from "convex/values"
import { internal } from "./_generated/api"
import { type QueryCtx } from "./_generated/server"
import { internalMutation } from "./functions"
import type { Doc } from "./_generated/dataModel"

const DELIVERED = new Set(["delivered_due", "delivered_paid"])
const RETURNED = new Set(["pending_returned", "returned", "damaged"])
const OPEN = new Set(["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship", "in_transit"])

export type CustomerStats = { orders: number; delivered: number; returned: number; cancelled: number; open: number; spent: number; lastOrderAt?: number; successRate: number | null }

/** Real history for a phone number, counted from every order we hold (all customer records with that phone). */
export async function statsForPhone(ctx: QueryCtx, phone: string, stored?: Doc<"customers"> | null): Promise<CustomerStats> {
  const orders = (await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", phone)).collect()).filter((o) => !o.deletedAt)
  let delivered = 0, returned = 0, cancelled = 0, open = 0, spent = 0, last = 0
  for (const o of orders) {
    if (DELIVERED.has(o.status)) { delivered++; spent += o.total }
    else if (RETURNED.has(o.status)) returned++
    else if (o.status === "cancelled") cancelled++
    else if (OPEN.has(o.status)) open++
    last = Math.max(last, o.createdAt)
  }
  // Nuport's own counters can include very old orders we never imported — keep whichever is higher.
  const s = {
    orders: Math.max(orders.length, stored?.orderCount ?? 0),
    delivered: Math.max(delivered, stored?.deliveredCount ?? 0),
    returned: Math.max(returned, stored?.returnedCount ?? 0),
    cancelled: Math.max(cancelled, stored?.cancelledCount ?? 0),
    open,
    spent: Math.max(spent, stored?.totalSpent ?? 0),
    lastOrderAt: last || stored?.lastOrderAt,
  }
  const done = s.delivered + s.returned
  return { ...s, successRate: done ? Math.round((s.delivered / done) * 100) : null }
}

/** One-time repair: rewrite every customer's counters from their real orders. Runs itself in batches. */
export const recomputeAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), fixed: v.optional(v.number()) },
  handler: async (ctx, { cursor, fixed = 0 }) => {
    const page = await ctx.db.query("customers").paginate({ cursor: cursor ?? null, numItems: 150 })
    for (const c of page.page) {
      const s = await statsForPhone(ctx, c.phone, c)
      const tag = c.tag === "NEW" && s.delivered > 0 ? "REGULAR" : c.tag
      if (s.orders !== c.orderCount || s.delivered !== c.deliveredCount || s.returned !== c.returnedCount || s.cancelled !== c.cancelledCount || s.spent !== c.totalSpent || tag !== c.tag) {
        await ctx.db.patch(c._id, { orderCount: s.orders, deliveredCount: s.delivered, returnedCount: s.returned, cancelledCount: s.cancelled, totalSpent: s.spent, lastOrderAt: s.lastOrderAt, tag })
        fixed++
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.customerStats.recomputeAll, { cursor: page.continueCursor, fixed })
    else console.log(`Customer stats recomputed, ${fixed} fixed`)
    return { fixed, done: page.isDone }
  },
})
