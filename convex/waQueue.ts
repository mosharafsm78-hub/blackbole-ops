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

const DAY = 86400000
const BATCH = 100

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
/** wa.me deep link: opens WhatsApp (app or web) with the chat open and this text already typed in — the staff
 *  member still has to press send themselves inside WhatsApp. */
const waLink = (local11: string, text: string) => `https://wa.me/88${local11}?text=${encodeURIComponent(text)}`

/** Same rule as the win-back SMS playbook (one order, delivered cleanly, never came back), but tracked against
 *  `waQueuedAt` so a customer can get both the automatic SMS *and* a queued WhatsApp message without double-booking either channel. */
export const winbackCandidates = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount === 1 && c.deliveredCount === 1 && c.returnedCount === 0 && c.cancelledCount === 0)
      .filter((c) => c.lastOrderAt && c.lastOrderAt >= from && c.lastOrderAt <= to)
      .filter((c) => !c.waQueuedAt && c.phone)
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

export const enqueueOne = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), name: v.string(), text: v.string(), source: v.string() },
  handler: async (ctx, { customerId, phone, name, text, source }) => {
    await ctx.db.insert("waQueue", { customerId, phone, name, text, source, status: "pending", createdAt: Date.now() })
    await ctx.db.patch(customerId, { waQueuedAt: Date.now() })
  },
})

/** Runs hourly: pulls fresh win-back candidates and queues a personalized WhatsApp message for each, using the
 *  same code/window/message set in Settings → Win-back. Does nothing while win-back is switched off. */
export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const now = Date.now()
    const list = await ctx.runQuery(internal.waQueue.winbackCandidates, { from: now - c.maxDays * DAY, to: now - c.minDays * DAY })
    for (const cust of list) {
      const text = fill(c.template, { name: cust.name.split(" ")[0] || "there", code: c.code })
      await ctx.runMutation(internal.waQueue.enqueueOne, { customerId: cust._id, phone: cust.phone, name: cust.name, text, source: "winback" })
    }
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

export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const pendingRows = await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "pending")).collect()
    const sentRows = await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "sent")).collect()
    return { pendingTotal: pendingRows.length, sentTotal: sentRows.length }
  },
})

export const markSent = mutation({
  args: { id: v.id("waQueue") },
  handler: async (ctx, { id }) => {
    const s = await requirePerm(ctx, "orders.view")
    await ctx.db.patch(id, { status: "sent", sentAt: Date.now(), sentBy: s.staff.name })
  },
})

export const skip = mutation({
  args: { id: v.id("waQueue") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "orders.view")
    await ctx.db.patch(id, { status: "skipped" })
  },
})
