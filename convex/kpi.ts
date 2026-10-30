// Team performance leaderboard. A weekly sprint (resets every Monday) that banks into a cumulative monthly
// total, with a real cash prize pool at month end. The whole thing is an append-only point ledger (kpiEvents)
// — nothing is ever "added up and stored"; a leaderboard is always the live sum of events in that window, so
// changing a rule's point value later never requires a migration or leaves old totals wrong.
//
// EVERY rule below fires automatically, off a real event this system already records — a status move, a
// feedback call, a GRN, an Accountability flag, a Meta ad report. There is no "award points by hand" step
// anywhere a person can act: an agent can't mark their own outcome to earn points, and a lead can't pick a
// number and a reason for someone. That's deliberate, not a missing feature — a system a person can self-score
// stops measuring the thing it was built to measure.
//
// Design doctrine (why the rule book looks like this, not like a longer wish-list):
//   1. Every rule is grounded in a real field this app already writes, never a signal that would need someone
//      to self-report ("great call", "packed fast") — self-reported inputs are exactly what gets gamed first.
//   2. Positive rules reward either a leading behavior (the work actually happened — a feedback call was made,
//      a parcel went out same-day) or a verified outcome that required the customer to follow through (an
//      advance cleared, a recovery order was placed) — never a claim with nothing real behind it.
//   3. Every department has a genuine negative counterweight, not just ways to earn points: ops.flag_raised and
//      ops.overdue_flag dock whichever department actually owns a confirmed mistake or a stalled business-
//      health signal (sales down, return ratio up, orders stuck) the moment it's raised — so chasing volume on
//      the positive rules without keeping quality up shows up on the same board immediately, not in a separate
//      report nobody reads.
//   4. One rule, one job, one payout. No rule pays out twice for the same underlying event — awardPoints'
//      orderId dedupe, plus the "only on a genuinely new flag" and "only once per flag" guards at each call
//      site, enforce this.
import { v, ConvexError } from "convex/values"
import { query, internalQuery, type MutationCtx } from "./_generated/server"
import { mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { currentStaff, requirePerm } from "./lib"

const DAY = 86400000

export type KpiRuleKey =
  | "cx.recovered_checkout" | "cx.advance_secured" | "cx.order_confirmed" | "cx.recovery_win" | "cx.feedback_logged"
  | "fulfillment.same_day_dispatch" | "fulfillment.clean_grn"
  | "marketing.delivered_order" | "marketing.roas_hit"
  | "ops.fast_capa" | "ops.wrong_route" | "ops.clean_week" | "ops.flag_raised" | "ops.overdue_flag"

// Every rule below lives in one shared ledger, so a department lead's own score and a frontline agent's score
// read the same way on the Leaderboard. "Operations" here is the shared quality layer sitting on top of every
// department: whoever Settings → Accountability names as the lead for Customer Care, Fulfillment or Marketing
// is who ops.flag_raised and ops.overdue_flag dock, and whoever's named the operations head is who ops.fast_capa
// and ops.clean_week credit.
export const DEFAULT_RULES: { key: KpiRuleKey; label: string; points: number; team: string; auto: boolean }[] = [
  // ---------------------------------------------------------------------------------------------------------- CX
  { key: "cx.recovered_checkout", label: "Recovered an abandoned checkout into an approved order", points: 20, team: "Customer Care", auto: true },
  { key: "cx.advance_secured", label: "Advance payment actually cleared on a held order", points: 15, team: "Customer Care", auto: true },
  { key: "cx.order_confirmed", label: "Confirmed a new order over the phone (Pending → Approved)", points: 5, team: "Customer Care", auto: true },
  { key: "cx.recovery_win", label: "Won a customer back with a fresh order after our own mistake caused a return", points: 25, team: "Customer Care", auto: true },
  { key: "cx.feedback_logged", label: "Completed a post-delivery feedback call through to a real outcome", points: 3, team: "Customer Care", auto: true },

  // --------------------------------------------------------------------------------------------------- Fulfillment
  { key: "fulfillment.same_day_dispatch", label: "Order dispatched the same day it was approved", points: 5, team: "Fulfillment", auto: true },
  { key: "fulfillment.clean_grn", label: "Supplier shipment received with zero damaged units", points: 4, team: "Fulfillment", auto: true },

  // --------------------------------------------------------------------------------------------------- Marketing & Content
  { key: "marketing.delivered_order", label: "An order from a paid channel (Facebook/Instagram) actually completed delivery", points: 3, team: "Marketing", auto: true },
  { key: "marketing.roas_hit", label: "Ad spend hit or beat the weekly ROAS target (Settings → KPI)", points: 20, team: "Marketing", auto: true },

  // -------------------------------------------------------------------------------------------- Operations / leads
  { key: "ops.fast_capa", label: "Accountability flag resolved within 6 hours with a full CAPA answer", points: 15, team: "Operations", auto: true },
  { key: "ops.wrong_route", label: "Flag had to be re-routed — sent to the wrong department first", points: -20, team: "Operations", auto: true },
  { key: "ops.clean_week", label: "A full week with no Accountability flag breaching the 2-day SLA", points: 25, team: "Operations", auto: true },
  { key: "ops.flag_raised", label: "An Accountability flag — a confirmed mistake, or a business-health signal — was raised against your department", points: -15, team: "Operations", auto: true },
  { key: "ops.overdue_flag", label: "A flag assigned to you sat unanswered past the 2-day SLA", points: -10, team: "Operations", auto: true },
]

const DEFAULTS_BY_KEY = new Map(DEFAULT_RULES.map((r) => [r.key, r]))

/** Merges stored overrides (point value / active toggle, edited from Settings) onto the default rule book, so
 *  a rule nobody has touched yet still shows up with a sane default. */
async function effectiveRules(ctx: MutationCtx | any) {
  const stored: Doc<"kpiRules">[] = await ctx.db.query("kpiRules").collect()
  const overrides = new Map<string, Doc<"kpiRules">>(stored.map((r) => [r.key, r]))
  return DEFAULT_RULES.map((d) => {
    const o = overrides.get(d.key)
    return { ...d, points: o?.points ?? d.points, active: o?.active ?? true }
  })
}

/** The one place a staff member's points are ever written. Resolves the name to a real, active staff record
 *  first — a system actor's name (Pathao sync, Auto-approve, Nuport sync, Shopify…) simply won't match one,
 *  so an automated status change never accidentally credits "the system" instead of a person. When `orderId`
 *  is given, also refuses to award the same rule on the same order twice — some order transitions (an advance
 *  clearing, in particular) can re-fire on a later, unrelated move of the same order. */
export async function awardPoints(
  ctx: MutationCtx,
  args: { staffName: string; ruleKey: KpiRuleKey | "manual"; label: string; points?: number; orderId?: Id<"orders">; flagId?: Id<"opsFlags">; byName?: string },
) {
  const person = (await ctx.db.query("staff").collect()).find((s) => s.active && s.name.trim().toLowerCase() === args.staffName.trim().toLowerCase())
  if (!person) return // not a real, active staff member — nothing to credit

  let points = args.points
  if (points === undefined) {
    const def = DEFAULTS_BY_KEY.get(args.ruleKey as KpiRuleKey)
    if (!def) return
    const rows = await ctx.db.query("kpiRules").withIndex("by_key", (q) => q.eq("key", args.ruleKey)).unique()
    if (rows && rows.active === false) return // rule turned off in Settings
    points = rows?.points ?? def.points
  }
  if (points === 0) return

  if (args.orderId) {
    const dupe = await ctx.db.query("kpiEvents").withIndex("by_rule_order", (q) => q.eq("ruleKey", args.ruleKey).eq("orderId", args.orderId)).first()
    if (dupe) return
  }

  await ctx.db.insert("kpiEvents", {
    staffName: person.name, points, ruleKey: args.ruleKey, label: args.label,
    orderId: args.orderId, flagId: args.flagId, byName: args.byName, at: Date.now(),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------------------------------------------

/** Monday 00:00 of the week containing `at`, in UTC — a plain, server-side week boundary. Good enough for a
 *  weekly sprint reset; it doesn't need to match the office's local midnight to the minute. */
function weekStart(at: number) {
  const d = new Date(at)
  const day = d.getUTCDay() // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day // back up to Monday
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

function monthKey(at: number) {
  const d = new Date(at)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

function monthStart(month: string) {
  const [y, m] = month.split("-").map(Number)
  return Date.UTC(y, m - 1, 1)
}

/** Weekly sprint board + monthly bank in one call — the two boards share the same event data, just summed
 *  over different windows, so there's one query instead of two nearly-identical ones. */
export const leaderboard = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const now = Date.now()
    const wStart = weekStart(now)
    const month = monthKey(now)
    const mStart = monthStart(month)
    const rows = await ctx.db.query("kpiEvents").withIndex("by_at", (q) => q.gte("at", mStart)).collect()

    const sum = (events: Doc<"kpiEvents">[]) => {
      const byStaff = new Map<string, number>()
      for (const e of events) byStaff.set(e.staffName, (byStaff.get(e.staffName) ?? 0) + e.points)
      return [...byStaff.entries()].map(([staffName, points]) => ({ staffName, points })).sort((a, b) => b.points - a.points)
    }

    return {
      weekStart: wStart,
      weekEnd: wStart + 7 * DAY,
      month,
      weekly: sum(rows.filter((e) => e.at >= wStart)),
      monthly: sum(rows),
    }
  },
})

/** The last N point events across everyone, newest first — the "live feed". */
export const recentFeed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await ctx.db.query("kpiEvents").withIndex("by_at").order("desc").take(Math.min(limit ?? 30, 100))
  },
})

/** One person's own recent history and running week/month totals — for a personal widget. */
export const myPoints = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const now = Date.now()
    const wStart = weekStart(now)
    const mStart = monthStart(monthKey(now))
    const rows = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", s.staff.name).gte("at", mStart)).order("desc").collect()
    return {
      week: rows.filter((e) => e.at >= wStart).reduce((t, e) => t + e.points, 0),
      month: rows.reduce((t, e) => t + e.points, 0),
      recent: rows.slice(0, 10),
    }
  },
})

export const listRules = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await effectiveRules(ctx)
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Administration — editing rules, awarding by hand, and the monthly payout record
// ---------------------------------------------------------------------------------------------------------------

export const saveRule = mutation({
  args: { key: v.string(), points: v.number(), active: v.boolean() },
  handler: async (ctx, { key, points, active }) => {
    await requirePerm(ctx, "team.manage")
    if (!DEFAULTS_BY_KEY.has(key as KpiRuleKey)) throw new ConvexError("Unknown rule")
    const existing = await ctx.db.query("kpiRules").withIndex("by_key", (q) => q.eq("key", key)).unique()
    const def = DEFAULTS_BY_KEY.get(key as KpiRuleKey)!
    if (existing) await ctx.db.patch(existing._id, { points, active })
    else await ctx.db.insert("kpiRules", { key, label: def.label, points, active })
  },
})

/** A Super Admin crediting or docking someone for anything the automatic rules can't see yet — kept as a
 *  backend-only emergency correction path (no UI entry point anymore: see leaderboard.tsx). Everything the
 *  KPI system normally pays out is automatic now; this exists only for a genuine one-off correction. */
export const manualAward = mutation({
  args: { staffName: v.string(), points: v.number(), reason: v.string(), ruleKey: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "team.manage")
    const reason = a.reason.trim()
    if (!reason) throw new ConvexError("Write a reason for this award.")
    if (a.points === 0) throw new ConvexError("Points can't be zero.")
    const person = (await ctx.db.query("staff").collect()).find((s) => s.active && s.name.trim().toLowerCase() === a.staffName.trim().toLowerCase())
    if (!person) throw new ConvexError("That staff member wasn't found, or isn't active.")
    await ctx.db.insert("kpiEvents", {
      staffName: person.name, points: a.points, ruleKey: a.ruleKey ?? "manual", label: reason, byName: me.staff.name, at: Date.now(),
    })
  },
})

export const listPayouts = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await ctx.db.query("kpiPayouts").withIndex("by_month", (q) => q.eq("month", month)).collect()
  },
})

/** Locks in the top 3 of a month's monthly bank as the prize-pool winners. Safe to call more than once for the
 *  same month (e.g. re-run after a late manual award is added before payday) — it replaces any payout rows for
 *  that month that haven't been marked paid yet, and leaves any that HAVE been paid untouched so a correction
 *  can never un-pay someone. */
export const finalizeMonth = mutation({
  args: { month: v.string(), prizes: v.array(v.number()) }, // prizes[0] = 1st place taka, [1] = 2nd, [2] = 3rd
  handler: async (ctx, { month, prizes }) => {
    const me = await requirePerm(ctx, "team.manage")
    const mStart = monthStart(month)
    const mEnd = monthStart(monthKeyAfter(month))
    const rows = await ctx.db.query("kpiEvents").withIndex("by_at", (q) => q.gte("at", mStart).lt("at", mEnd)).collect()
    const byStaff = new Map<string, number>()
    for (const e of rows) byStaff.set(e.staffName, (byStaff.get(e.staffName) ?? 0) + e.points)
    const ranked = [...byStaff.entries()].map(([staffName, points]) => ({ staffName, points })).sort((a, b) => b.points - a.points).slice(0, prizes.length)

    const existing = await ctx.db.query("kpiPayouts").withIndex("by_month", (q) => q.eq("month", month)).collect()
    for (const row of existing) if (row.status !== "paid") await ctx.db.delete(row._id)

    const created: Id<"kpiPayouts">[] = []
    for (let i = 0; i < ranked.length; i++) {
      const already = existing.find((r) => r.rank === i + 1 && r.status === "paid")
      if (already) continue // a paid rank stands exactly as paid — never overwritten by a re-finalize
      created.push(await ctx.db.insert("kpiPayouts", {
        month, rank: i + 1, staffName: ranked[i].staffName, points: ranked[i].points, amount: prizes[i] ?? 0,
        status: "pending", createdAt: Date.now(),
      }))
    }
    void me
    return { created: created.length, ranked }
  },
})

function monthKeyAfter(month: string) {
  const [y, m] = month.split("-").map(Number)
  const d = new Date(Date.UTC(y, m, 1)) // first of the NEXT month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export const markPayoutPaid = mutation({
  args: { id: v.id("kpiPayouts"), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    const me = await requirePerm(ctx, "team.manage")
    const row = await ctx.db.get(id)
    if (!row) throw new ConvexError("Payout not found")
    if (row.status === "paid") return
    await ctx.db.patch(id, { status: "paid", paidAt: Date.now(), paidByName: me.staff.name, note: note?.trim() || row.note })
  },
})
