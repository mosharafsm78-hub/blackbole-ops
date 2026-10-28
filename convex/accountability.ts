// Accountability: once a return call confirms a reason was really our own fault, the department that caused
// it gets a flag it has to answer — inside this ops system, not a side chat nobody can trace later. See
// ACCOUNTABILITY_ROUTING in rules.ts for which department owns which reason.
import { v, ConvexError } from "convex/values"
import { query, type MutationCtx } from "./_generated/server"
import { mutation } from "./functions"
import { requirePerm, invoiceLabel, logOrder, notify } from "./lib"
import { ACCOUNTABILITY_ROUTING } from "./rules"
import type { Doc } from "./_generated/dataModel"

/** Called from logReturnCsat once a return call outcome is logged. Raises one open flag for the owning
 *  department — if one's already open for this order (e.g. the call was re-logged by a Super Admin), it's
 *  reused rather than duplicated, so a department never sees the same order twice in its queue. */
export async function raiseAccountabilityFlag(ctx: MutationCtx, order: Doc<"orders">, outcome: string, note: string | undefined, byName: string) {
  const team = ACCOUNTABILITY_ROUTING[outcome]
  if (!team) return // not an at-fault reason with an owning department (e.g. "Customer changed mind")
  const existing = await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", order._id)).filter((q) => q.eq(q.field("status"), "open")).first()
  if (existing) {
    await ctx.db.patch(existing._id, { reason: outcome, team, note, raisedByName: byName, raisedAt: Date.now() })
    return
  }
  await ctx.db.insert("opsFlags", { orderId: order._id, reason: outcome, team, note, status: "open", raisedByName: byName, raisedAt: Date.now() })
  await logOrder(ctx, order._id, `Accountability: ${outcome} — flagged to ${team}`, byName)
  await notify(ctx, `${team}: ${outcome}`, `${invoiceLabel(order)} needs a response from ${team} before this can close out.`, order._id, "accountability")
}

/** The open flag on one order, if any — shown as a banner on the order page. */
export const openForOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).filter((q) => q.eq(q.field("status"), "open")).first()
  },
})

/** How many flags are open right now, broken down by department — drives the dashboard tile per team. */
export const openCounts = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const byTeam: Record<string, number> = {}
    for (const r of rows) byTeam[r.team] = (byTeam[r.team] ?? 0) + 1
    return { total: rows.length, byTeam }
  },
})

/** Every open flag, newest first, with enough order context to act on it without a second click. */
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").collect()
    const out: any[] = []
    for (const r of rows) {
      const o = await ctx.db.get(r.orderId)
      if (!o) continue
      out.push({ ...r, orderInvoice: invoiceLabel(o), orderStatus: o.status, customerName: o.customerName, phone: o.phone })
    }
    return out
  },
})

/** A department closes its own flag with a real response — required, so the record actually says what was
 *  done about it, not just that someone clicked a button. */
export const respond = mutation({
  args: { id: v.id("opsFlags"), response: v.string() },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.accountability")
    const flag = await ctx.db.get(a.id)
    if (!flag) throw new ConvexError("Flag not found")
    if (flag.status !== "open") throw new ConvexError("Already resolved")
    const response = a.response.trim()
    if (!response) throw new ConvexError("Write what was done about it before closing this out.")
    await ctx.db.patch(a.id, { status: "resolved", response, resolvedByName: me.staff.name, resolvedAt: Date.now() })
    await logOrder(ctx, flag.orderId, `Accountability resolved by ${flag.team}: ${response}`, me.staff.name)
  },
})
