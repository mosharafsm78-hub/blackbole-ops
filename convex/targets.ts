// Company revenue target and its daily allocation.
//
// One monthly target for the whole company, set by an admin in Settings → KPI. Revenue counts delivered orders
// only (the `total` of an order that reached Delivered, on the Dhaka day it was delivered — the same definition
// the Accounting dashboard uses). The month is split into daily targets that re-balance every day; the maths
// lives in targetMath.ts so it can be tested without a database.
//
// Like the analytics report, this pages through orders in small batches inside an action instead of reading a
// whole month of order documents in one query, and the per-day totals are cached for a few minutes (shared by
// everyone who opens the dashboard). Only the totals are cached — the target itself is read fresh on every
// call, so changing it in Settings shows up immediately.
import { v, ConvexError } from "convex/values"
import { internal } from "./_generated/api"
import { action, internalQuery, query } from "./_generated/server"
import { mutation } from "./functions"
import { currentStaff, requirePerm } from "./lib"
import { dhakaDay, dhakaMonth, isMonthKey, monthEndMs, monthStartMs, planMonth, sumDeliveredByDay, type MonthPlan } from "./targetMath"

const CACHE_MS = 5 * 60000
const DELIVERED = new Set(["delivered_due", "delivered_paid"])

/** A month's target, or null when none is set. */
export const getTarget = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    if (!(await currentStaff(ctx))) return null
    const row = await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique()
    return row ? { month: row.month, amount: row.amount, setByName: row.setByName, updatedAt: row.updatedAt } : null
  },
})

/** Sets (or, with 0, clears) a month's company-wide revenue target. Only the current or a future month — a
 *  finished month's target is history, and quietly rewriting it would change what "we hit it" meant. */
export const setMonthlyTarget = mutation({
  args: { month: v.string(), amount: v.number() },
  handler: async (ctx, { month, amount }) => {
    const me = await requirePerm(ctx, "team.manage")
    if (!isMonthKey(month)) throw new ConvexError("Pick a valid month.")
    if (month < dhakaMonth(Date.now())) throw new ConvexError("A target can only be set for the current or a future month.")
    if (!Number.isFinite(amount) || amount < 0) throw new ConvexError("The target must be zero or more.")
    const whole = Math.round(amount)
    const existing = await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique()
    if (whole === 0) {
      if (existing) await ctx.db.delete(existing._id)
      return
    }
    const row = { month, amount: whole, setByName: me.staff.name, updatedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, row)
    else await ctx.db.insert("revenueTargets", row)
  },
})

export const access = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) throw new ConvexError("You are not signed in or your access was removed.")
    return true
  },
})

export const targetRow = internalQuery({
  args: { month: v.string() },
  handler: async (ctx, { month }) => await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique(),
})

/** One page of the month's delivered orders, reduced to what the sum needs. */
export const deliveredPage = internalQuery({
  args: { from: v.number(), to: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }) => {
    const res = await ctx.db
      .query("orders")
      .withIndex("by_delivered", (q) => q.gte("deliveredAt", from).lt("deliveredAt", to))
      .paginate({ cursor, numItems: 300 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page
        .filter((o) => !o.deletedAt && DELIVERED.has(o.status))
        .map((o) => ({ at: o.deliveredAt!, total: o.total })),
    }
  },
})

export type TargetProgress = {
  month: string
  asOf: number
  /** null when no target is set for the month. */
  target: { amount: number; setByName: string } | null
  plan: MonthPlan | null
}

/** Where the month stands against its target: totals, today's target, and every day so far. */
export const progress = action({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, { month }): Promise<TargetProgress> => {
    await ctx.runQuery(internal.targets.access, {})
    const now = Date.now()
    const m = month ?? dhakaMonth(now)
    if (!isMonthKey(m)) throw new ConvexError("Pick a valid month.")

    const row = await ctx.runQuery(internal.targets.targetRow, { month: m })
    if (!row) return { month: m, asOf: now, target: null, plan: null }

    const key = `target-days:${m}`
    const hit = await ctx.runQuery(internal.dashboard.readCache, { key })
    let byDay: Record<string, number>
    if (hit && now - hit.at < CACHE_MS) {
      byDay = hit.value as Record<string, number>
    } else {
      const from = monthStartMs(m), to = monthEndMs(m)
      const rows: { at: number; total: number }[] = []
      let cursor: string | null = null
      for (let i = 0; i < 200; i++) {
        const res: { isDone: boolean; cursor: string; rows: { at: number; total: number }[] } = await ctx.runQuery(internal.targets.deliveredPage, { from, to, cursor })
        rows.push(...res.rows)
        if (res.isDone) break
        cursor = res.cursor
      }
      byDay = sumDeliveredByDay(rows)
      await ctx.runMutation(internal.dashboard.writeCache, { key, value: byDay })
    }

    return {
      month: m,
      asOf: now,
      target: { amount: row.amount, setByName: row.setByName },
      plan: planMonth({ month: m, target: row.amount, deliveredByDay: byDay, today: dhakaDay(now) }),
    }
  },
})
