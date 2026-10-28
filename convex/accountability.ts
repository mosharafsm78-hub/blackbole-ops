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
import { bdDay, statsFromDays } from "./stats"
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

const MIN_CAPA_CHARS = 15

/** A department closes its own flag with a CAPA answer (Corrective & Preventive Action — the standard format
 *  for this across manufacturing and retail ops): what actually went wrong, what was done about this case, and
 *  what concretely changes so it doesn't happen again. All three are required and checked for real substance
 *  (not "fixed it" or "ok") — this is the record of whether the team actually improved, not just closed a ticket. */
export const respond = mutation({
  args: { id: v.id("opsFlags"), rootCause: v.string(), correctiveAction: v.string(), preventiveAction: v.string() },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.accountability")
    const flag = await ctx.db.get(a.id)
    if (!flag) throw new ConvexError("Flag not found")
    if (flag.status !== "open") throw new ConvexError("Already resolved")
    const rootCause = a.rootCause.trim(), correctiveAction = a.correctiveAction.trim(), preventiveAction = a.preventiveAction.trim()
    if (rootCause.length < MIN_CAPA_CHARS) throw new ConvexError("Write what actually went wrong — a real reason, not a one-liner.")
    if (correctiveAction.length < MIN_CAPA_CHARS) throw new ConvexError("Write what was actually done about this specific case.")
    if (preventiveAction.length < MIN_CAPA_CHARS) throw new ConvexError("Write the concrete change that stops this happening again — not a promise, an action.")
    const response = `Root cause: ${rootCause}\nFix: ${correctiveAction}\nPrevention: ${preventiveAction}`
    await ctx.db.patch(a.id, { status: "resolved", response, rootCause, correctiveAction, preventiveAction, resolvedByName: me.staff.name, resolvedAt: Date.now() })
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
// Daily reminders: a daily cron (see crons.ts) emails every owner one digest of their own still-open items —
// from day 1, not just once overdue — and separately pings the operations head about anything past the 2-day
// SLA, every day it stays open, so nothing quietly sits unanswered.
// ---------------------------------------------------------------------------------------------------------------

export const openForDigest = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const owners = await ownersConf(ctx)
    const out: any[] = []
    for (const r of rows) {
      let orderInvoice: string | null = null
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (o) orderInvoice = invoiceLabel(o)
      }
      out.push({
        _id: r._id, reason: r.reason, team: r.team, raisedAt: r.raisedAt, orderInvoice,
        assignee: r.assignee, assigneeEmail: r.assigneeEmail,
      })
    }
    return { rows: out, opsHead: owners.opsHead }
  },
})

export const markEscalated = internalMutation({
  args: { id: v.id("opsFlags") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { escalatedAt: Date.now() })
  },
})

function itemLine(r: { reason: string; team: string; orderInvoice: string | null; raisedAt: number }) {
  const days = Math.floor((Date.now() - r.raisedAt) / DAY)
  return `- ${r.orderInvoice ? `${r.orderInvoice} — ` : ""}"${r.reason}" (${r.team}, open ${days} day${days === 1 ? "" : "s"})`
}

/** Runs daily (see crons.ts). Every owner with open items gets one email listing all of them, every day they
 *  stay open — not just once they cross the SLA. Anything 2+ days old also gets a separate digest to the
 *  operations head, so they can chase it personally. */
export const checkOverdue = internalAction({
  args: {},
  handler: async (ctx) => {
    const { rows, opsHead } = await ctx.runQuery(internal.accountability.openForDigest, {})
    if (!rows.length) return

    type Group = { name: string; items: any[] }
    const byAssignee = new Map<string, Group>()
    const overdue: any[] = []
    for (const r of rows) {
      if (r.assigneeEmail) {
        const g: Group = byAssignee.get(r.assigneeEmail) ?? { name: r.assignee ?? "", items: [] }
        g.items.push(r)
        byAssignee.set(r.assigneeEmail, g)
      }
      if (Date.now() - r.raisedAt >= SLA_DAYS * DAY) overdue.push(r)
    }

    for (const [email, g] of byAssignee) {
      const lines = g.items.map(itemLine).join("\n")
      await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
        to: email,
        subject: `Accountability: ${g.items.length} pending item${g.items.length === 1 ? "" : "s"} need${g.items.length === 1 ? "s" : ""} your answer`,
        text: `Hi ${g.name.split(" ")[0] || "there"},\n\nStill open and waiting on you:\n\n${lines}\n\nPlease close these out in Ops → Accountability.\n\n— BlackBole Ops`,
      })
    }

    if (opsHead?.email && overdue.length) {
      const lines = overdue.map(itemLine).join("\n")
      await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
        to: opsHead.email,
        subject: `Accountability: ${overdue.length} item${overdue.length === 1 ? "" : "s"} past the 2-day SLA`,
        text: `Hi ${opsHead.name.split(" ")[0]},\n\nThese have been open 2+ days with no answer:\n\n${lines}\n\nWorth a direct chase.\n\n— BlackBole Ops`,
      })
      for (const r of overdue) await ctx.runMutation(internal.accountability.markEscalated, { id: r._id })
    }
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Business-health flags: not every accountability item should wait for a customer-care call. A daily check
// (see crons.ts) looks at the whole business — sales trend, return ratio — the way an operations head would,
// and raises a flag against the department that actually owns that outcome even when no one logged a call.
// Thresholds are deliberately blunt for now (no historical baseline to calibrate against yet); the point is
// catching the two things that most directly cost BlackBole money — fewer sales, more returns — not every
// metric that could move.
// ---------------------------------------------------------------------------------------------------------------

const SALES_DROP_PCT = -15 // week-over-week % change that counts as "sales dropping"
const RETURN_RATIO_HIGH = 0.15 // 15%+ of resolved orders returned/damaged in a week counts as "high" on its own
const RETURN_RATIO_JUMP = 0.05 // or a 5-percentage-point jump over the previous week, even if not yet at 15%

export const openByTeam = internalQuery({
  args: { team: v.string() },
  handler: async (ctx, { team }) => {
    return await ctx.db.query("opsFlags").withIndex("by_team_status", (q) => q.eq("team", team).eq("status", "open")).collect()
  },
})

/** Same as raiseFreeform, but for the system itself to open a flag — no signed-in staff member to attribute it
 *  to, so it's logged as BlackBole Ops (automatic) and skips the team.manage permission check accordingly. */
export const raiseSystem = internalMutation({
  args: { team: v.string(), reason: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { team, reason, note }) => {
    const owners = await ownersConf(ctx)
    const owner = owners.byTeam[team]
    const id = await ctx.db.insert("opsFlags", { reason, team, note, status: "open", raisedByName: "BlackBole Ops (automatic)", raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
    await notify(ctx, `${owner?.name ?? team}: business metric needs an answer`, reason, undefined, "accountability")
    if (owner?.email) {
      await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
        to: owner.email,
        subject: `Accountability: a business metric needs your answer`,
        text: `Hi ${owner.name.split(" ")[0]},\n\nBlackBole Ops spotted this automatically and routed it to you as ${team}:\n\n"${reason}"${note ? `\n\n${note}` : ""}\n\nPlease open it in Ops → Accountability and answer, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
      })
    }
    return id
  },
})

/** Runs daily (see crons.ts), comparing a rolling 7-day window to the 7 days before it — daily so a real
 *  problem is caught within a day, but still a week wide so one unusual day doesn't trigger a false alarm.
 *  Uses the same scoreboard the dashboard reads from (cheap — no re-scanning every order). Raises at most one
 *  open flag per metric per team at a time: if yesterday's flag on the same thing is still open, it isn't
 *  piled on again — the daily digest already keeps reminding the owner. */
export const businessHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const WEEK = 7 * DAY
    const [thisRows, prevRows] = await Promise.all([
      ctx.runQuery(internal.stats.days, { fromDay: bdDay(now - WEEK), toDay: bdDay(now) }),
      ctx.runQuery(internal.stats.days, { fromDay: bdDay(now - 2 * WEEK), toDay: bdDay(now - WEEK) }),
    ])
    const t = statsFromDays(thisRows, now - WEEK, now)
    const p = statsFromDays(prevRows, now - 2 * WEEK, now - WEEK)

    const alreadyOpen = async (team: string, tag: string) => {
      const rows = await ctx.runQuery(internal.accountability.openByTeam, { team })
      return rows.some((r: any) => (r.reason as string).startsWith(tag))
    }

    // Sales dropping week over week
    if (p.totalSales > 0) {
      const pct = Math.round(((t.totalSales - p.totalSales) / p.totalSales) * 100)
      if (pct <= SALES_DROP_PCT) {
        const tag = "[Business health] Sales down"
        if (!(await alreadyOpen("Marketing", tag))) {
          await ctx.runMutation(internal.accountability.raiseSystem, {
            team: "Marketing",
            reason: `${tag} ${Math.abs(pct)}% this week`,
            note: `৳${Math.round(t.totalSales).toLocaleString()} this week vs ৳${Math.round(p.totalSales).toLocaleString()} last week (${t.totalOrders} vs ${p.totalOrders} orders). What's driving it, and what's the plan to turn it back up?`,
          })
        }
      }
    }

    // Return ratio climbing, or just high
    const tResolved = t.delivered + t.returned
    const pResolved = p.delivered + p.returned
    const tRatio = tResolved > 0 ? t.returned / tResolved : null
    const pRatio = pResolved > 0 ? p.returned / pResolved : null
    if (tRatio !== null && (tRatio >= RETURN_RATIO_HIGH || (pRatio !== null && tRatio - pRatio >= RETURN_RATIO_JUMP))) {
      const tag = "[Business health] Return ratio high"
      if (!(await alreadyOpen("Fulfillment", tag))) {
        await ctx.runMutation(internal.accountability.raiseSystem, {
          team: "Fulfillment",
          reason: `${tag} — ${Math.round(tRatio * 100)}% this week`,
          note: `${t.returned} returned/damaged out of ${tResolved} resolved orders this week${pRatio !== null ? ` (was ${Math.round(pRatio * 100)}% last week)` : ""}. Find the main driver — if it turns out to really be a listing/description mismatch rather than a fulfillment error, re-route it to Marketing instead of answering it here.`,
        })
      }
    }
  },
})
