// Win-back: a customer who bought exactly once, had it delivered cleanly, and never came back gets an automatic
// discount-code push, 10–20 days after delivery — by SMS, email (both fully automatic, both here), and WhatsApp
// (queued here but drafted for a human to tap-send, in waQueue.ts, to stay clear of WhatsApp's automation bans).
// Lives in: Settings → Win-back (status/log) and the dashboard's "Action Center" card.
import { v, ConvexError } from "convex/values"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, requirePerm, setSetting } from "./lib"
import { sendSms } from "./outbound"
import { shopifyGql } from "./shopifyStock"

const DAY = 86400000
const BD_OFFSET = 6 * 3600000
// Nothing sends before this moment (2026-10-28 13:00 Asia/Dhaka = 07:00 UTC) — moved up to start today, at
// the user's request, instead of waiting for the next afternoon.
const START_AT = Date.UTC(2026, 9, 28, 7, 0, 0)
const CODE = "COMEBACK150"
const BATCH = 60
// Tier 1 (one-time buyer): first message at conf.minDays after delivery (settings UI), then this system no
// longer marks them "done forever" — it re-nudges every REPEAT1_DAYS, with a freshly-dated monthly code, until
// they place a 2nd order (at which point orderCount flips to 2 and they fall out of this tier automatically).
// At the user's explicit request: "the message will send until they purchase."
export const REPEAT1_DAYS = 30
// Tier 2 (repeat buyer gone quiet): once someone has 2+ orders and stops ordering, wait TIER2_FIRST_DAYS since
// their last order for the first nudge, then re-nudge every TIER2_REPEAT_DAYS after that — same discount
// mechanism, same monthly-rotating code, just a slower cadence befitting an already-proven customer.
export const TIER2_FIRST_DAYS = 45
export const TIER2_REPEAT_DAYS = 60

// Several message variants instead of one fixed string — sending the exact same text to dozens of different
// customers in a row (over WhatsApp especially) reads as robotic and risks looking like spam. Rotating in blocks
// of 5 (same wording for 5 customers, then switch) keeps each individual message looking hand-typed while still
// being simple and fully automatic.
export type WinbackConf = {
  enabled: boolean; code: string; minDays: number; maxDays: number; templates: string[]
  smsSendIndex?: number; waSendIndex?: number; emailSendIndex?: number // rotation position per channel — persisted
  // so the pattern keeps advancing correctly across runs instead of resetting to variant #1 every hour
}
// Fixed subject line for the win-back email — the templates themselves are channel-neutral body text shared
// with SMS/WhatsApp, so the subject lives here rather than being yet another thing to configure.
const EMAIL_SUBJECT = "We miss you at BlackBole 💙"
export const DEFAULT_TEMPLATES = [
  "Hi {name}! You were one of our favourite customers at BlackBole and we'd love to have you back 💙 Here's {code} for ৳150 off your next order (on ৳1,500+). Shop: blackbole.com · Need help? Call us: 01805070650",
  "Hi {name}, it's been a while! Come back to BlackBole and grab ৳150 off with code {code} (orders ৳1,500+). Shop: blackbole.com",
  "{name}, we miss you at BlackBole! Use {code} for ৳150 off your next order (min ৳1,500). Shop now: blackbole.com",
]
export const DEFAULT_CONF: WinbackConf = { enabled: true, code: CODE, minDays: 10, maxDays: 20, templates: DEFAULT_TEMPLATES, smsSendIndex: 0, waSendIndex: 0, emailSendIndex: 0 }
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

/** The configured code is now a PREFIX, not the literal code — "every month you will refresh the code" (user's
 *  words): each calendar month (Asia/Dhaka) gets its own code, e.g. "COMEBACK150" → "COMEBACK150-2611" for Nov
 *  2026. Same ৳150/৳1500-minimum/one-per-customer terms every month, just a code that reads as fresh to anyone
 *  who got last month's text and didn't use it. */
export const codeForMonth = (prefix: string, at: number) => {
  const d = new Date(at + BD_OFFSET)
  const ym = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}`
  return `${prefix}-${ym}`
}

/** Creates this month's win-back discount code (৳150 off, ৳1500 minimum order, once per customer) if it doesn't
 *  exist yet. Called every run — cheap no-op once the month's code has been created. */
export const ensureDiscount = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const exists = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", code)).first()
    if (exists) return
    const now = Date.now()
    await ctx.db.insert("discounts", {
      code, title: "Win-back — auto (monthly)", type: "amount", value: 150, scope: "all", items: [],
      minSubtotal: 1500, oncePerCustomer: true, active: true, usedCount: 0, createdAt: now, updatedAt: now,
    })
  },
})

/** The live site's checkout still runs on Shopify (BlackBole Ops's own discount codes only power the
 *  not-yet-launched blackbole-storefront rebuild) — so a code that only exists in the `discounts` table above is
 *  invisible at actual checkout. Mirrors it into Shopify too (same ৳150/৳1500-minimum/one-per-customer terms as
 *  ensureDiscount) using the same Admin API credentials as the stock sync (Settings → Shopify). Best-effort: if
 *  Shopify sync isn't set up, or the code already exists there, this quietly does nothing. */
export const ensureShopifyDiscount = internalAction({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    try {
      const d: any = await shopifyGql(ctx, `mutation($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
        }`, {
        input: {
          title: "Win-back — auto (monthly)", code, startsAt: new Date().toISOString(), appliesOncePerCustomer: true,
          context: { all: "ALL" },
          customerGets: { items: { all: true }, value: { discountAmount: { amount: 150, appliesOnEachItem: false } } },
          minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: 1500 } },
        },
      })
      const errs = d.discountCodeBasicCreate.userErrors
      if (errs?.length && !errs.some((e: any) => /taken|already exist/i.test(e.message))) {
        console.error(`Shopify win-back discount sync (${code}) failed: ${errs.map((e: any) => e.message).join("; ")}`)
      }
    } catch (e) {
      console.error(`Shopify win-back discount sync (${code}) failed: ${String((e as Error).message ?? e)}`)
    }
  },
})

/** Tier 1 — bought exactly once, it was delivered cleanly (never returned/cancelled), and at least `minDays`
 *  have passed since that delivery. No longer a one-shot: once contacted, `repeatDays` must also have passed
 *  since the last contact on this channel, so the same customer keeps resurfacing here every cycle until they
 *  place a 2nd order (which flips orderCount to 2 and drops them out of this filter on its own). */
export const candidates = internalQuery({
  args: { minDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { minDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount === 1 && c.deliveredCount === 1 && c.returnedCount === 0 && c.cancelledCount === 0)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - minDays * DAY)
      .filter((c) => c.phone && (!c.winBackAt || c.winBackAt <= now - repeatDays * DAY))
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

/** Same tier, same repeating logic — deduped on the email clock instead, so email runs independently of SMS (a
 *  customer with no phone but an email still gets reached, and one already SMS'd still gets the email too). */
export const emailCandidates = internalQuery({
  args: { minDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { minDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount === 1 && c.deliveredCount === 1 && c.returnedCount === 0 && c.cancelledCount === 0)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - minDays * DAY)
      .filter((c) => c.email && (!c.winbackEmailAt || c.winbackEmailAt <= now - repeatDays * DAY))
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

/** Tier 2 — proven repeat buyer (2+ orders, at least one actually delivered) who has since gone quiet: first
 *  nudge `firstDays` after their last order, then re-nudged every `repeatDays` after the last tier-2 contact,
 *  for as long as they keep not ordering. A new order (lastOrderAt moves forward) naturally resets the clock. */
export const candidates2 = internalQuery({
  args: { firstDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { firstDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount >= 2 && c.deliveredCount >= 1)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - firstDays * DAY)
      .filter((c) => c.phone && (!c.winBack2At || c.winBack2At <= now - repeatDays * DAY))
      .sort((a, b) => (a.lastOrderAt ?? 0) - (b.lastOrderAt ?? 0))
      .slice(0, BATCH)
  },
})

export const email2Candidates = internalQuery({
  args: { firstDays: v.number(), repeatDays: v.number() },
  handler: async (ctx, { firstDays, repeatDays }) => {
    const now = Date.now()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.orderCount >= 2 && c.deliveredCount >= 1)
      .filter((c) => c.lastOrderAt !== undefined && c.lastOrderAt <= now - firstDays * DAY)
      .filter((c) => c.email && (!c.winbackEmail2At || c.winbackEmail2At <= now - repeatDays * DAY))
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

/** Email counterpart to logSent — same "recent" feed (channel: "winback"), the address sits in `phone` per the
 *  existing convention. */
export const logSentEmail = internalMutation({
  args: { customerId: v.id("customers"), email: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, email, text, error }) => {
    await ctx.db.insert("smsLogs", { phone: email, text, status: error ? "failed" : "sent", error: error ?? undefined, channel: "winback", customerId, at: Date.now() })
    await ctx.db.patch(customerId, { winbackEmailAt: Date.now() })
  },
})

export const logSent2 = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, phone, text, error }) => {
    await ctx.db.insert("smsLogs", { phone, text, status: error ? "failed" : "sent", error: error ?? undefined, channel: "winback2", customerId, at: Date.now() })
    await ctx.db.patch(customerId, { winBack2At: Date.now() })
  },
})

export const logSentEmail2 = internalMutation({
  args: { customerId: v.id("customers"), email: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, email, text, error }) => {
    await ctx.db.insert("smsLogs", { phone: email, text, status: error ? "failed" : "sent", error: error ?? undefined, channel: "winback2", customerId, at: Date.now() })
    await ctx.db.patch(customerId, { winbackEmail2At: Date.now() })
  },
})

export const smsSettingsRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "sms")) ?? null })

/** Runs every hour; does nothing before START_AT, outside 1pm–8pm Dhaka, or while switched off. Tier 1: one-time
 *  buyers, first message at conf.minDays and re-sent every REPEAT1_DAYS until they order again. */
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
    const code = codeForMonth(c.code, now)
    await ctx.runMutation(internal.winback.ensureDiscount, { code })
    await ctx.runAction(internal.winback.ensureShopifyDiscount, { code })
    const list = await ctx.runQuery(internal.winback.candidates, { minDays: c.minDays, repeatDays: REPEAT1_DAYS })
    let idx = c.smsSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      const error = await sendSms(sms, cust.phone, text)
      await ctx.runMutation(internal.winback.logSent, { customerId: cust._id, phone: cust.phone, text, error })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "sms", count: list.length })
  },
})

/** Email counterpart to `run` — same hours/window/rotation logic, fully automatic like SMS (email carries none
 *  of WhatsApp's automation-ban risk, so it skips the human-queue step waQueue.ts uses). Gated on Settings →
 *  Email being enabled, same mailbox used for transactional order emails. */
export const runEmail = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    if (now < START_AT) return
    const bdHour = new Date(now + BD_OFFSET).getUTCHours()
    if (bdHour < 13 || bdHour >= 20) return
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    if (!email?.enabled) return
    const code = codeForMonth(c.code, now)
    await ctx.runMutation(internal.winback.ensureDiscount, { code })
    await ctx.runAction(internal.winback.ensureShopifyDiscount, { code })
    const list = await ctx.runQuery(internal.winback.emailCandidates, { minDays: c.minDays, repeatDays: REPEAT1_DAYS })
    let idx = c.emailSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      await ctx.runAction(internal.emailNode.sendWinbackEmail, { customerId: cust._id, to: cust.email!, subject: EMAIL_SUBJECT, text })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "email", count: list.length })
  },
})

/** Tier 2 — repeat buyer (2+ orders) who's gone quiet: first nudge TIER2_FIRST_DAYS after their last order, then
 *  re-nudged every TIER2_REPEAT_DAYS. Same hours/switch/discount-mechanism as tier 1, just a separate clock. */
export const run2 = internalAction({
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
    const code = codeForMonth(c.code, now)
    await ctx.runMutation(internal.winback.ensureDiscount, { code })
    await ctx.runAction(internal.winback.ensureShopifyDiscount, { code })
    const list = await ctx.runQuery(internal.winback.candidates2, { firstDays: TIER2_FIRST_DAYS, repeatDays: TIER2_REPEAT_DAYS })
    let idx = c.smsSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      const error = await sendSms(sms, cust.phone, text)
      await ctx.runMutation(internal.winback.logSent2, { customerId: cust._id, phone: cust.phone, text, error })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "sms", count: list.length })
  },
})

export const runEmail2 = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    if (now < START_AT) return
    const bdHour = new Date(now + BD_OFFSET).getUTCHours()
    if (bdHour < 13 || bdHour >= 20) return
    const c = await ctx.runQuery(internal.winback.getConf, {})
    if (!c.enabled) return
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    if (!email?.enabled) return
    const code = codeForMonth(c.code, now)
    await ctx.runMutation(internal.winback.ensureDiscount, { code })
    await ctx.runAction(internal.winback.ensureShopifyDiscount, { code })
    const list = await ctx.runQuery(internal.winback.email2Candidates, { firstDays: TIER2_FIRST_DAYS, repeatDays: TIER2_REPEAT_DAYS })
    let idx = c.emailSendIndex ?? 0
    for (const cust of list) {
      const text = fill(pickTemplate(c.templates, idx), { name: cust.name.split(" ")[0] || "there", code })
      await ctx.runAction(internal.emailNode.sendWinbackEmail, { customerId: cust._id, to: cust.email!, subject: EMAIL_SUBJECT, text })
      idx++
    }
    if (list.length) await ctx.runMutation(internal.winback.bumpRotation, { channel: "email", count: list.length })
  },
})

export const getConf = internalQuery({ args: {}, handler: async (ctx) => conf(ctx) })

/** Advances a channel's rotation position after a batch sends, so the next run picks up the pattern where this
 *  one left off instead of restarting at variant #1 every time. Merges onto the saved doc rather than replacing
 *  it, so it never clobbers templates/code/etc being edited at the same time. */
export const bumpRotation = internalMutation({
  args: { channel: v.union(v.literal("sms"), v.literal("wa"), v.literal("email")), count: v.number() },
  handler: async (ctx, { channel, count }) => {
    const saved = (await getSetting<any>(ctx, "winback")) ?? {}
    const key = channel === "sms" ? "smsSendIndex" : channel === "wa" ? "waSendIndex" : "emailSendIndex"
    await setSetting(ctx, "winback", { ...saved, [key]: (saved[key] ?? 0) + count })
  },
})

/** Every discount doc ever generated for this prefix (one per calendar month) — summed, since a customer nudged
 *  in an earlier month who redeems late should still count, and the UI shows one running total, not per-month. */
async function redeemedTotal(ctx: any, prefix: string) {
  const all = await ctx.db.query("discounts").collect()
  return all.filter((d: any) => d.code === prefix || d.code.startsWith(`${prefix}-`)).reduce((sum: number, d: any) => sum + (d.usedCount ?? 0), 0)
}

/** Real individual sends, for the Action Center's "what AI actually did" feed — any signed-in staff with
 *  dashboard access, not just settings.manage. This is the proof, not a summary of it. Covers both tiers. */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "dashboard.view")
    const rows = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(300)
    const mine = rows.filter((r) => r.channel === "winback" || r.channel === "winback2").slice(0, 15)
    return Promise.all(mine.map(async (r) => ({
      _id: r._id, phone: r.phone, status: r.status, at: r.at, error: r.error, tier: r.channel === "winback2" ? 2 : 1,
      name: r.customerId ? ((await ctx.db.get(r.customerId))?.name ?? r.phone) : r.phone,
    })))
  },
})

/** Light stats for other pages (e.g. the Action Center) — no settings-manage permission needed, just signed in. */
export const liveStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await conf(ctx)
    const redeemed = await redeemedTotal(ctx, c.code)
    const scan = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(600)
    const sentTotal = scan.filter((r) => (r.channel === "winback" || r.channel === "winback2") && r.status === "sent").length
    return { enabled: c.enabled, startAt: START_AT, sentTotal, redeemed }
  },
})

/** Settings → Win-back: current setup, the discount's redemptions (across every month's code), and the last 30
 *  messages sent across both tiers. */
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx, "settings.manage").catch(() => null)
    if (!s) return null
    const c = await conf(ctx)
    const redeemed = await redeemedTotal(ctx, c.code)
    const scan = await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(600)
    const recent = scan.filter((r) => r.channel === "winback" || r.channel === "winback2").slice(0, 30)
    const withNames = await Promise.all(recent.map(async (r) => ({
      _id: r._id, at: r.at, phone: r.phone, status: r.status, error: r.error, tier: r.channel === "winback2" ? 2 : 1,
      name: r.customerId ? (await ctx.db.get(r.customerId))?.name ?? "—" : "—",
    })))
    const sentTotal = scan.filter((r) => (r.channel === "winback" || r.channel === "winback2") && r.status === "sent").length
    return {
      conf: c, startAt: START_AT, redeemed, sentTotal, recent: withNames,
      currentCode: codeForMonth(c.code, Date.now()), repeat1Days: REPEAT1_DAYS, tier2FirstDays: TIER2_FIRST_DAYS, tier2RepeatDays: TIER2_REPEAT_DAYS,
    }
  },
})

export const saveSettings = mutation({
  args: { enabled: v.boolean(), code: v.string(), minDays: v.number(), templates: v.array(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const code = a.code.trim().toUpperCase()
    if (!code) throw new ConvexError("Enter a discount code")
    const templates = a.templates.map((t) => t.trim()).filter(Boolean)
    if (templates.length === 0) throw new ConvexError("Add at least one message")
    for (const t of templates) if (!t.includes("{code}")) throw new ConvexError("Every message variant must include {code} so the customer sees the discount code")
    if (a.minDays < 3 || a.minDays > 60) throw new ConvexError("Use a 'send after' window between 3 and 60 days")
    // Merge onto the saved doc so the rotation counters (smsSendIndex/waSendIndex) and the legacy maxDays field
    // (no longer used for filtering — tier 1 now repeats indefinitely until the customer orders again) survive an edit here.
    const saved = (await getSetting<any>(ctx, "winback")) ?? {}
    await setSetting(ctx, "winback", { ...saved, enabled: a.enabled, code, minDays: Math.round(a.minDays), templates })
    const monthCode = codeForMonth(code, Date.now())
    if (a.enabled) {
      await ctx.runMutation(internal.winback.ensureDiscount, { code: monthCode })
      await ctx.scheduler.runAfter(0, internal.winback.ensureShopifyDiscount, { code: monthCode })
    }
    // Rewrite any WhatsApp messages already sitting in the queue (either tier) so they pick up the new
    // wording/rotation/code right away. Without this, a backlog queued before this edit — or before variants
    // existed at all — stays frozen with whatever single text it got at enqueue time.
    const pendingWinback = (await ctx.db.query("waQueue").withIndex("by_status", (q) => q.eq("status", "pending")).collect())
      .filter((r) => r.source === "winback" || r.source === "winback2")
      .sort((x, y) => x.createdAt - y.createdAt)
    for (let i = 0; i < pendingWinback.length; i++) {
      const text = fill(pickTemplate(templates, i), { name: pendingWinback[i].name.split(" ")[0] || "there", code: monthCode })
      await ctx.db.patch(pendingWinback[i]._id, { text })
    }
  },
})
