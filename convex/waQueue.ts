// WhatsApp send queue — a safe, human-send alternative to automated WhatsApp messaging.
// AI drafts a personalized message for a customer; it sits here as "pending" until a staff member opens it in
// Ops, taps "Open WhatsApp" (which opens the real WhatsApp app/web with the text already typed in), and presses
// send themselves. Nothing here ever calls WhatsApp directly — every message leaves through the real app, from a
// human's own tap — which is what keeps BlackBole's everyday WhatsApp Business number (100-200 msgs/day with
// customers) completely safe from automation bans.
// Fed today by the win-back playbook (reuses its settings — see convex/winback.ts). Any future Action Center
// finding can enqueue into this same table with its own `source` so the team works from one shared queue.
import { v } from "convex/values"
import { internalAction, internalQuery, query } from "./_generated/server"

import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import { requirePerm } from "./lib"
import { pickTemplate, codeForMonth, REPEAT1_DAYS, TIER2_FIRST_DAYS, TIER2_REPEAT_DAYS } from "./winback"

const DAY = 86400000
const BATCH = 100

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
/** wa.me deep link: opens WhatsApp (app or web) with the chat open and this text already typed in — the staff
 *  member still has to press send themselves inside WhatsApp. */
const waLink = (local11: string, text: string) => `https://wa.me/88${local11}?text=${encodeURIComponent(text)}`

/** Tier 1 — same rule as the win-back SMS playbook (one order, delivered cleanly, never came back), same repeat
 *  cadence (re-queued every REPEAT1_DAYS, tracked via `waQueuedAt`, until they order again) — kept independent of
 *  SMS/email so a customer can get all three without double-booking any one channel. WhatsApp itself still goes
 *  out by a human tap (see file header); this only decides who gets drafted into the queue. */
export const winbackCandidates = internalQuery({
  args: { minDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { minDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount === 1 && c.deliveredCount === 1 && c.returnedCount === 0 && c.cancelledCount === 0)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - minDays * DAY)
      .filter((c) => c.phone && (!c.waQueuedAt || c.waQueuedAt <= now - repeatDays * DAY))
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

/** Tier 2 — repeat buyer (2+ orders) gone quiet: same firstDays/repeatDays clock as the SMS/email tier-2 run,
 *  tracked via `waQueued2At` so it never collides with the tier-1 clock above. */
export const winback2Candidates = internalQuery({
  args: { firstDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { firstDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount >= 2 && c.deliveredCount >= 1)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - firstDays * DAY)
      .filter((c) => c.phone && (!c.waQueued2At || c.waQueued2At <= now - repeatDays * DAY))
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

export const enqueueOne = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), name: v.string(), text: v.string(), source: v.string(), tier: v.optional(v.union(v.literal(1), v.literal(2))) },
  handler: async (ctx, { customerId, phone, name, text, source, tier }) => {
    await ctx.db.insert("waQueue", { customerId, phone, name, text, source, status: "pending", createdAt: Date.now() })
    await ctx.db.patch(customerId, tier === 2 ? { waQueued2At: Date.now() } : { waQueuedAt: Date.now() })
  },
})

/** Runs hourly: pulls fresh tier-1 win-back candidates and queues a personalized WhatsApp message for each, using
 *  the same monthly code/message set in Settings → Win-back. Does nothing while win-back is switched off. */
export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const now = Date.now()
    const code = codeForMonth(c.code, now)
    const list = await ctx.runQuery(internal.waQueue.winbackCandidates, { minDays: c.minDays, repeatDays: REPEAT1_DAYS })
    let idx = c.waSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      await ctx.runMutation(internal.waQueue.enqueueOne, { customerId: cust._id, phone: cust.phone, name: cust.name, text, source: "winback" })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "wa", count: list.length })
  },
})

/** Tier 2 counterpart — repeat buyers who've gone quiet, same monthly code, slower cadence. */
export const run2 = internalAction({
  args: {},
  handler: async (ctx) => {
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const now = Date.now()
    const code = codeForMonth(c.code, now)
    const list = await ctx.runQuery(internal.waQueue.winback2Candidates, { firstDays: TIER2_FIRST_DAYS, repeatDays: TIER2_REPEAT_DAYS })
    let idx = c.waSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      await ctx.runMutation(internal.waQueue.enqueueOne, { customerId: cust._id, phone: cust.phone, name: cust.name, text, source: "winback2", tier: 2 })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "wa", count: list.length })
  },
})

/** Pending queue for the inbox UI — whole team shares this one list. */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "pending")).order("asc").take(300)
    return rows.map((r) => ({ _id: r._id, name: r.name, phone: r.phone, text: r.text, source: r.source, createdAt: r.createdAt, link: waLink(r.phone, r.text) }))
  },
})

/** Sent log for the inbox UI — same shared view, so the team can see who already got reached and by whom. */
export const sent = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "sent")).order("desc").take(200)
    return rows
      .map((r) => ({ _id: r._id, name: r.name, phone: r.phone, text: r.text, source: r.source, sentAt: r.sentAt ?? r.createdAt, sentBy: r.sentBy }))
      .sort((a, b) => b.sentAt - a.sentAt)
  },
})

async function computeStats(ctx: any) {
  const pendingRows = await ctx.db.query("waQueue").withIndex("by_status", (q: any) => q.eq("status", "pending")).collect()
  const sentRows = await ctx.db.query("waQueue").withIndex("by_status", (q: any) => q.eq("status", "sent")).collect()
  return { pendingTotal: pendingRows.length, sentTotal: sentRows.length }
}

export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    return computeStats(ctx)
  },
})

/** Real individual sends, for the Action Center's "what AI actually did" feed. */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "dashboard.view")
    const rows = await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "sent")).order("desc").take(15)
    return rows.map((r) => ({ _id: r._id, name: r.name, phone: r.phone, sentAt: r.sentAt ?? r.createdAt, sentBy: r.sentBy }))
  },
})

/** Same numbers, for other server-side code (e.g. the Action Center) — no settings-manage/staff gate, just internal. */
export const liveStats = internalQuery({ args: {}, handler: async (ctx) => computeStats(ctx) })

export const markSent = mutation({
  args: { id: v.id("waQueue") },
  handler: async (ctx, { id }) => {
    const s = await requirePerm(ctx, "orders.view")
    await ctx.db.patch(id, { status: "sent", sentAt: Date.now(), sentBy: s.staff.name })
  },
})

/** Undo a wrong "sent" mark (e.g. the WhatsApp window never actually opened) — puts it straight back at the top
 *  of the waiting queue so it can be sent for real. */
export const markNotSent = mutation({
  args: { id: v.id("waQueue") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "orders.view")
    const row = await ctx.db.get(id)
    if (!row) return
    await ctx.db.patch(id, { status: "pending", sentAt: undefined, sentBy: undefined })
  },
})

export const skip = mutation({
  args: { id: v.id("waQueue") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "orders.view")
    await ctx.db.patch(id, { status: "skipped" })
  },
})
