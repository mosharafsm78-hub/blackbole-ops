import { v } from "convex/values"
import { query, type QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { requirePerm } from "./lib"

const DELIVERED = new Set(["delivered_due", "delivered_paid"])
const RETURNED = new Set(["pending_returned", "returned", "damaged"])
const OPEN = new Set(["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship", "in_transit"])

/** Return rate by how the order was confirmed and by the customer's Pathao record (cached checks only). */
export const report = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    await requirePerm(ctx, "reports.view")
    const since = Date.now() - (days ?? 45) * 86400000
    const orders = await ctx.db.query("orders").withIndex("by_created", (q) => q.gt("createdAt", since)).take(6000)
    const cells: Record<string, { delivered: number; returned: number }> = {}
    const add = (k: string, d: boolean) => { const c = (cells[k] ??= { delivered: 0, returned: 0 }); if (d) c.delivered++; else c.returned++ }
    for (const o of orders) {
      if (o.deletedAt) continue
      const d = DELIVERED.has(o.status), r = RETURNED.has(o.status)
      if (!d && !r) continue
      const how = o.waVerify?.result === "confirmed" ? "whatsapp" : "team"
      const ch = await ctx.db.query("courierChecks").withIndex("by_phone", (q) => q.eq("phone", o.phone).eq("provider", "pathao")).first()
      const h: any = ch?.data
      const done = (h?.delivered ?? 0) + (h?.returned ?? 0)
      const rate = done ? (h.delivered / done) * 100 : null
      const band = rate === null || done < 3 ? "no history" : rate < 70 ? "<70%" : rate < 85 ? "70-84%" : "85%+"
      add(`${how} | all`, d); add(`${how} | ${band}`, d); add(`all | ${band}`, d)
    }
    return Object.entries(cells).map(([k, c]) => ({ k, ...c, returnRate: Math.round((c.returned / (c.delivered + c.returned)) * 100) })).sort((a, b) => a.k.localeCompare(b.k))
  },
})

export type RiskTier = "trusted" | "call" | "risky"

/** How much to trust a new order before approving it on a WhatsApp tap. Uses only stored data (cached Pathao check + our own orders). */
export async function riskFor(ctx: QueryCtx, o: Doc<"orders">): Promise<{ tier: RiskTier; reason: string }> {
  const mine = (await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", o.phone)).collect()).filter((x) => !x.deletedAt && x._id !== o._id)
  const dup = mine.find((x) => OPEN.has(x.status) && Math.abs(x.createdAt - o.createdAt) < 7 * 86400000)
  const bbDelivered = mine.filter((x) => DELIVERED.has(x.status)).length
  const bbReturned = mine.filter((x) => RETURNED.has(x.status)).length
  const ch = await ctx.db.query("courierChecks").withIndex("by_phone", (q) => q.eq("phone", o.phone).eq("provider", "pathao")).first()
  const h: any = ch?.data
  const done = (h?.delivered ?? 0) + (h?.returned ?? 0)
  const rate = done ? Math.round((h.delivered / done) * 100) : null
  const ratio = rate === null ? "no Pathao history" : `Pathao ${rate}% delivered (${h.delivered}/${done})`
  if (bbReturned >= 2 && bbReturned >= bbDelivered) return { tier: "risky", reason: `returned ${bbReturned} BlackBole orders before` }
  if (rate !== null && done >= 3 && rate < 70) return { tier: "risky", reason: ratio }
  if (dup) return { tier: "call", reason: `possible double order (another open order on this phone)` }
  if (bbDelivered >= 1 && bbReturned === 0) return { tier: "trusted", reason: `received ${bbDelivered} BlackBole order${bbDelivered > 1 ? "s" : ""} before` }
  if (rate !== null && done >= 3 && rate >= 85) return { tier: "trusted", reason: ratio }
  return { tier: "call", reason: ratio }
}
