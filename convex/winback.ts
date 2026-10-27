// Win-back: a customer who bought exactly once, had it delivered cleanly, and never came back gets one
// automatic SMS with a discount code, 10–20 days after delivery. Fully automatic — no human touch.
// Lives in: Settings → Win-back (status/log) and the dashboard's "Action Center" card.
import { v, ConvexError } from "convex/values"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, requirePerm, setSetting } from "./lib"
import { sendSms } from "./outbound"

const DAY = 86400000
const BD_OFFSET = 6 * 3600000
// Nothing sends before this moment (2026-10-29 13:00 Asia/Dhaka = 07:00 UTC) — set once, on purpose, so the
// first messages go out "tomorrow afternoon" as asked, not the moment this deploys.
const START_AT = Date.UTC(2026, 9, 29, 7, 0, 0)
const CODE = "COMEBACK150"
const BATCH = 60

export type WinbackConf = { enabled: boolean; code: string; minDays: number; maxDays: number; template: string }
export const DEFAULT_TEMPLATE = "Hi {name}! It's been a while since your BlackBole order — come back and get ৳150 off with code {code}. Shop: blackbole.com"
export const DEFAULT_CONF: WinbackConf = { enabled: true, code: CODE, minDays: 10, maxDays: 20, template: DEFAULT_TEMPLATE }

const conf = async (ctx: any): Promise<WinbackConf> => ({ ...DEFAULT_CONF, ...((await getSetting<WinbackConf>(ctx, "winback")) ?? {}) })
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")

/** Creates the win-back discount code once (৳150 off, ৳1500 minimum order, once per customer) if it doesn't exist yet. */
export const ensureDiscount = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const exists = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", code)).first()
    if (exists) return
    const now = Date.now()
    await ctx.db.insert("discounts", {
      code, title: "Win-back — one-time buyers", type: "amount", value: 150, scope: "all", items: [],
      minSubtotal: 1500, oncePerCustomer: true, active: true, usedCount: 0, createdAt: now, updatedAt: now,
    })
  },
})

/** Customers who ordered exactly once, it was delivered cleanly (never returned/cancelled), the window has
 *  passed, and we haven't already messaged them. */
export const candidates = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount === 1 && c.deliveredCount === 1 && c.returnedCount === 0 && c.cancelledCount === 0)
      .filter((c) => c.lastOrderAt && c.lastOrderAt >= from && c.lastOrderAt <= to)
      .filter((c) => !c.winBackAt && c.phone)
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

export const logSent = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, phone, text, error }) => {
    await ctx.db.insert("smsLogs", { phone, text, status: error ? "failed" : "sent", error: error ?? undefined, channel: "winback", customerId, at: Date.now() })
    await ctx.db.patch(customerId, { winBackAt: Date.now() })
  },
})

export const smsSettingsRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "sms")) ?? null })

/** Runs every hour; does nothing before START_AT, outside 1pm–8pm Dhaka, or while switched off. */
export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    if (now < START_AT) return
    const bdHour = new Date(now + BD_OFFSET).getUTCHours()
    if (bdHour < 13 || bdHour >= 20) return
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const sms = await ctx.runQuery(internal.winback.smsSettingsRaw, {})
    if (!sms?.enabled) return
    await ctx.runMutation(internal.winback.ensureDiscount, { code: c.code })
    const list = await ctx.runQuery(internal.winback.candidates, { from: now - c.maxDays * DAY, to: now - c.minDays * DAY })
    for (const cust of list) {
      const text = fill(c.template, { name: cust.name.split(" ")[0] || "there", code: c.code })
      const error = await sendSms(sms, cust.phone, text)
      await ctx.runMutation(internal.winback.logSent, { customerId: cust._id, phone: cust.phone, text, error })
    }
  },
})

export const getConf = internalQuery({ args: {}, handler: async (ctx) => conf(ctx) })

/** Light stats for other pages (e.g. the Action Center) — no settings-manage permission needed, just signed in. */
export const liveStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await conf(ctx)
    const discount = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", c.code)).first()
    const scan = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(600)
    const sentTotal = scan.filter((r) => r.channel === "winback" && r.status === "sent").length
    return { enabled: c.enabled, startAt: START_AT, sentTotal, redeemed: discount?.usedCount ?? 0 }
  },
})

/** Settings → Win-back: current setup, the discount's redemptions, and the last 30 messages sent. */
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx, "settings.manage").catch(() => null)
    if (!s) return null
    const c = await conf(ctx)
    const discount = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", c.code)).first()
    const scan = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(600)
    const recent = scan.filter((r) => r.channel === "winback").slice(0, 30)
    const withNames = await Promise.all(recent.map(async (r) => ({
      _id: r._id, at: r.at, phone: r.phone, status: r.status, error: r.error,
      name: r.customerId ? (await ctx.db.get(r.customerId))?.name ?? "—" : "—",
    })))
    const sentTotal = scan.filter((r) => r.channel === "winback" && r.status === "sent").length
    return { conf: c, startAt: START_AT, redeemed: discount?.usedCount ?? 0, sentTotal, recent: withNames }
  },
})

export const saveSettings = mutation({
  args: { enabled: v.boolean(), code: v.string(), minDays: v.number(), maxDays: v.number(), template: v.string() },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const code = a.code.trim().toUpperCase()
    if (!code) throw new ConvexError("Enter a discount code")
    if (!a.template.includes("{code}")) throw new ConvexError("The message must include {code} so the customer sees the discount code")
    if (a.minDays < 3 || a.minDays > 60) throw new ConvexError("Use a 'send after' window between 3 and 60 days")
    if (a.maxDays <= a.minDays || a.maxDays > 90) throw new ConvexError("The 'until' day must be after 'after' and at most 90")
    await setSetting(ctx, "winback", { enabled: a.enabled, code, minDays: Math.round(a.minDays), maxDays: Math.round(a.maxDays), template: a.template.trim() })
    if (a.enabled) await ctx.runMutation(internal.winback.ensureDiscount, { code })
  },
})
