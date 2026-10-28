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

// Several message variants instead of one fixed string — sending the exact same text to dozens of different
// customers in a row (over WhatsApp especially) reads as robotic and risks looking like spam. Rotating in blocks
// of 5 (same wording for 5 customers, then switch) keeps each individual message looking hand-typed while still
// being simple and fully automatic.
export type WinbackConf = {
  enabled: boolean; code: string; minDays: number; maxDays: number; templates: string[]
  smsSendIndex?: number; waSendIndex?: number // rotation position per channel — persisted so the pattern keeps
  // advancing correctly across runs instead of resetting to variant #1 every hour
}
export const DEFAULT_TEMPLATES = [
  "Hi {name}! You were one of our favourite customers at BlackBole and we'd love to have you back 💙 Here's {code} for ৳150 off your next order (on ৳1,500+). Shop: blackbole.com · Need help? Call us: 01805070650",
  "Hi {name}, it's been a while! Come back to BlackBole and grab ৳150 off with code {code} (orders ৳1,500+). Shop: blackbole.com",
  "{name}, we miss you at BlackBole! Use {code} for ৳150 off your next order (min ৳1,500). Shop now: blackbole.com",
]
export const DEFAULT_CONF: WinbackConf = { enabled: true, code: CODE, minDays: 10, maxDays: 20, templates: DEFAULT_TEMPLATES, smsSendIndex: 0, waSendIndex: 0 }
const ROTATE_EVERY = 5

const conf = async (ctx: any): Promise<WinbackConf> => {
  const saved = (await getSetting<any>(ctx, "winback")) ?? {}
  // Old saved settings (or ones never touched) may still have the old singular `template` field — fold it into
  // the new array so nobody's existing message gets silently dropped.
  const templates: string[] = Array.isArray(saved.templates) && saved.templates.length > 0
    ? saved.templates
    : typeof saved.template === "string" && saved.template.trim()
      ? [saved.template]
      : DEFAULT_TEMPLATES
  return { ...DEFAULT_CONF, ...saved, templates }
}
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
/** Which variant to use for the `n`th message sent on this channel (0-indexed, persisted across runs). */
export const pickTemplate = (templates: string[], n: number) => templates[Math.floor(n / ROTATE_EVERY) % templates.length]

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
    let idx = c.smsSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code: c.code })
      const error = await sendSms(sms, cust.phone, text)
      await ctx.runMutation(internal.winback.logSent, { customerId: cust._id, phone: cust.phone, text, error })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "sms", count: list.length })
  },
})

export const getConf = internalQuery({ args: {}, handler: async (ctx) => conf(ctx) })

/** Advances a channel's rotation position after a batch sends, so the next run picks up the pattern where this
 *  one left off instead of restarting at variant #1 every time. Merges onto the saved doc rather than replacing
 *  it, so it never clobbers templates/code/etc being edited at the same time. */
export const bumpRotation = internalMutation({
  args: { channel: v.union(v.literal("sms"), v.literal("wa")), count: v.number() },
  handler: async (ctx, { channel, count }) => {
    const saved = (await getSetting<any>(ctx, "winback")) ?? {}
    const key = channel === "sms" ? "smsSendIndex" : "waSendIndex"
    await setSetting(ctx, "winback", { ...saved, [key]: (saved[key] ?? 0) + count })
  },
})

/** Real individual sends, for the Action Center's "what AI actually did" feed — any signed-in staff with
 *  dashboard access, not just settings.manage. This is the proof, not a summary of it. */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "dashboard.view")
    const rows = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(300)
    const mine = rows.filter((r) => r.channel === "winback").slice(0, 15)
    return Promise.all(mine.map(async (r) => ({
      _id: r._id, phone: r.phone, status: r.status, at: r.at, error: r.error,
      name: r.customerId ? ((await ctx.db.get(r.customerId))?.name ?? r.phone) : r.phone,
    })))
  },
})

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
  args: { enabled: v.boolean(), code: v.string(), minDays: v.number(), maxDays: v.number(), templates: v.array(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const code = a.code.trim().toUpperCase()
    if (!code) throw new ConvexError("Enter a discount code")
    const templates = a.templates.map((t) => t.trim()).filter(Boolean)
    if (templates.length === 0) throw new ConvexError("Add at least one message")
    for (const t of templates) if (!t.includes("{code}")) throw new ConvexError("Every message variant must include {code} so the customer sees the discount code")
    if (a.minDays < 3 || a.minDays > 60) throw new ConvexError("Use a 'send after' window between 3 and 60 days")
    if (a.maxDays <= a.minDays || a.maxDays > 90) throw new ConvexError("The 'until' day must be after 'after' and at most 90")
    // Merge onto the saved doc so the rotation counters (smsSendIndex/waSendIndex) survive an edit here.
    const saved = (await getSetting<any>(ctx, "winback")) ?? {}
    await setSetting(ctx, "winback", { ...saved, enabled: a.enabled, code, minDays: Math.round(a.minDays), maxDays: Math.round(a.maxDays), templates })
    if (a.enabled) await ctx.runMutation(internal.winback.ensureDiscount, { code })
  },
})
