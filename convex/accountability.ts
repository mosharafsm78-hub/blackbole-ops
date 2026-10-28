// Accountability: once a return call confirms a reason was really our own fault, the department that caused
// it gets a flag it has to answer — inside this ops system, not a side chat nobody can trace later. See
// ACCOUNTABILITY_ROUTING in rules.ts for which department owns which reason, and Settings → Accountability for
// who, by name, currently owns each department (so a flag lands on an actual person, not just a bucket) and
// who the operations head is (gets pinged if something sits open past 2 days — see overdue/escalate below).
import { v, ConvexError } from "convex/values"
import { query, internalQuery, internalAction, type MutationCtx } from "./_generated/server"
import { mutation, internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { requirePerm, invoiceLabel, logOrder, notify, getSetting, setSetting } from "./lib"
import { ACCOUNTABILITY_ROUTING } from "./rules"
import type { Doc } from "./_generated/dataModel"

const DAY = 86400000
const SLA_DAYS = 2

type Owners = { byTeam: Record<string, { name: string; email: string }>; opsHead?: { name: string; email: string } }

async function ownersConf(ctx: MutationCtx | any): Promise<Owners> {
  return (await getSetting<Owners>(ctx, "accountabilityOwners")) ?? { byTeam: {} }
}

/** Called from logReturnCsat once a return call outcome is logged. Raises one open flag for the owning
 *  department — if one's already open for this order (e.g. the call was re-logged by a Super Admin), it's
 *  reused rather than duplicated, so a department never sees the same order twice in its queue. Looks up the
 *  named owner for that team (Settings → Accountability) and emails them right away, on top of the in-app flag. */
export async function raiseAccountabilityFlag(ctx: MutationCtx, order: Doc<"orders">, outcome: string, note: string | undefined, byName: string) {
  const team = ACCOUNTABILITY_ROUTING[outcome]
  if (!team) return // not an at-fault reason with an owning department (e.g. "Customer changed mind")
  const owners = await ownersConf(ctx)
  const owner = owners.byTeam[team]
  const existing = await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", order._id)).filter((q) => q.eq(q.field("status"), "open")).first()
  let flagId
  if (existing) {
    await ctx.db.patch(existing._id, { reason: outcome, team, note, raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email, escalatedAt: undefined })
    flagId = existing._id
  } else {
    flagId = await ctx.db.insert("opsFlags", { orderId: order._id, reason: outcome, team, note, status: "open", raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
  }
  await logOrder(ctx, order._id, `Accountability: ${outcome} — flagged to ${owner ? `${owner.name} (${team})` : team}`, byName)
  await notify(ctx, `${owner?.name ?? team}: ${outcome}`, `${invoiceLabel(order)} needs a response from ${owner?.name ?? team} before this can close out.`, order._id, "accountability")
  if (owner?.email) {
    await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
      to: owner.email,
      subject: `Accountability: ${invoiceLabel(order)} needs your answer`,
      text: `Hi ${owner.name.split(" ")[0]},\n\n${invoiceLabel(order)} (${order.customerName}, ${order.phone}) came back with: "${outcome}"${note ? ` — note from the call: "${note}"` : ""}.\n\nThis is routed to you as ${team}. Please open it in Ops → Accountability and write what happened, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
    })
  }
  return flagId
}

/** Saju (or whoever's set as the operations head) opening a question that isn't tied to one order — "why is
 *  our return ratio high this month", a pattern across several orders, anything that needs a named answer.
 *  Same flag, same mandatory-response, same 2-day SLA as an order-triggered one. */
export const raiseFreeform = mutation({
  args: { team: v.string(), question: v.string() },
  handler: async (ctx, { team, question }) => {
    const me = await requirePerm(ctx, "team.manage")
    const q = question.trim()
    if (!q) throw new ConvexError("Write the question before raising it.")
    const owners = await ownersConf(ctx)
    const owner = owners.byTeam[team]
    const id = await ctx.db.insert("opsFlags", { reason: q, team, status: "open", raisedByName: me.staff.name, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
    await notify(ctx, `${owner?.name ?? team}: question raised`, q, undefined, "accountability")
    if (owner?.email) {
      await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
        to: owner.email,
        subject: `Accountability: a question needs your answer`,
        text: `Hi ${owner.name.split(" ")[0]},\n\n${me.staff.name} raised this in Accountability, routed to you as ${team}:\n\n"${q}"\n\nPlease open it in Ops → Accountability and answer, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
      })
    }
    return id
  },
})

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

/** Every open flag, newest first, with enough order context to act on it without a second click. Free-form
 *  questions (no orderId) carry orderInvoice: null instead. */
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").collect()
    const out: any[] = []
    for (const r of rows) {
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (!o) continue
        out.push({ ...r, orderInvoice: invoiceLabel(o), orderStatus: o.status, customerName: o.customerName, phone: o.phone })
      } else {
        out.push({ ...r, orderInvoice: null })
      }
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
    if (flag.orderId) await logOrder(ctx, flag.orderId, `Accountability resolved by ${flag.team}: ${response}`, me.staff.name)
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Settings → Accountability: who owns each team's flags by name, and who the operations head is.
// ---------------------------------------------------------------------------------------------------------------

export const ownersSettings = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    return await ownersConf(ctx)
  },
})

export const saveOwners = mutation({
  args: {
    byTeam: v.record(v.string(), v.object({ name: v.string(), email: v.string() })),
    opsHead: v.optional(v.object({ name: v.string(), email: v.string() })),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    await setSetting(ctx, "accountabilityOwners", a)
  },
})

// ---------------------------------------------------------------------------------------------------------------
// 2-day SLA: a daily cron (see crons.ts) nudges the assignee again and pings the operations head once a flag's
// been open past SLA_DAYS — repeating every day it stays open, so nothing quietly sits unanswered.
// ---------------------------------------------------------------------------------------------------------------

export const overdue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SLA_DAYS * DAY
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const owners = await ownersConf(ctx)
    return rows.filter((r) => r.raisedAt <= cutoff).map((r) => ({
      _id: r._id, reason: r.reason, team: r.team, raisedAt: r.raisedAt, orderId: r.orderId,
      assignee: r.assignee, assigneeEmail: r.assigneeEmail, opsHead: owners.opsHead,
    }))
  },
})

export const markEscalated = internalMutation({
  args: { id: v.id("opsFlags") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { escalatedAt: Date.now() })
  },
})

/** Runs daily (see crons.ts). For every flag open past the 2-day SLA: nudges the assignee again by email, and
 *  separately alerts the operations head (Settings → Accountability) so they can chase it personally — exactly
 *  once per day, every day it stays open, until someone actually answers it. */
export const checkOverdue = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.accountability.overdue, {})
    for (const r of rows) {
      const days = Math.floor((Date.now() - r.raisedAt) / DAY)
      const subject = `Accountability: still open after ${days} days — ${r.reason.slice(0, 60)}`
      if (r.assigneeEmail) {
        await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
          to: r.assigneeEmail,
          subject,
          text: `Hi ${r.assignee?.split(" ")[0] ?? "there"},\n\nThis has been open ${days} days and still needs your answer: "${r.reason}"\n\nPlease close it out in Ops → Accountability.\n\n— BlackBole Ops`,
        })
      }
      if (r.opsHead?.email) {
        await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
          to: r.opsHead.email,
          subject: `Accountability: ${r.team} hasn't answered in ${days} days`,
          text: `Hi ${r.opsHead.name.split(" ")[0]},\n\n${r.team}${r.assignee ? ` (${r.assignee})` : ""} still hasn't answered this, ${days} days in: "${r.reason}"\n\nWorth a direct chase.\n\n— BlackBole Ops`,
        })
      }
      await ctx.runMutation(internal.accountability.markEscalated, { id: r._id })
    }
  },
})
