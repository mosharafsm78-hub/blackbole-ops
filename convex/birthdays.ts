// Birthday panel: a customer can optionally give their date of birth on the website order form ("we'd love to
// wish you — and send a little something — on your birthday"). A daily cron (see sendAutomatic below) wishes
// everyone whose birthday is today on email and SMS automatically, and drafts a WhatsApp message into the same
// human-tap queue win-back uses (see waQueue.ts — that's deliberate, not a corner we cut: WhatsApp has no safe
// unattended-send option here). Customer Care can also open a row on the Dashboard and send/resend by hand.
import { v } from "convex/values"
import { query, internalQuery, internalAction } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { requirePerm } from "./lib"
import { sendSms } from "./outbound"
import { shopifyGql } from "./shopifyStock"

const BD_OFFSET = 6 * 3600000

function monthDay(at: number) {
  const d = new Date(at + BD_OFFSET)
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
}
/** Full date key (year included) in Asia/Dhaka, used only to stop the cron double-sending the same day if it's
 *  ever re-triggered — birthdays themselves only need the month+day. */
function dateKey(at: number) {
  const d = new Date(at + BD_OFFSET)
  return `${d.getUTCFullYear()}-${monthDay(at)}`
}
const sentToday = (at: number | undefined, today: string) => !!at && dateKey(at) === today

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

// One evergreen birthday gift code (unlike win-back, this doesn't need a monthly rotation — it isn't a marketing
// funnel metric, just a thank-you). Self-heals into Shopify below the same way win-back's code does.
const BIRTHDAY_CODE = "BDAYGIFT500"
const BIRTHDAY_OFF = 500
const BIRTHDAY_MIN = 2500

/** Warm, plain-English birthday notes — first name up front, nothing that reads like a template. No request to
 *  call in: the team calls birthday customers themselves, so the message just states the gift. Per-channel
 *  length/tone: SMS short, email a little fuller, WhatsApp closest to how the team actually talks. */
function emailBody(name: string, code: string) {
  return `Hi ${name},\n\nIt's your birthday today, and we didn't want to let it pass without saying — thank you for being part of the BlackBole family. Every order of yours means more to us than you'd probably guess.\n\nAs a small birthday gift, here's ৳${BIRTHDAY_OFF} off your next order — just use the code ${code} at checkout (on orders ৳${BIRTHDAY_MIN}+).\n\nHope today brings you good food, good people, and a few extra reasons to smile.\n\nWarmly,\nTeam BlackBole`
}
function smsBody(name: string, code: string) {
  return `Hi ${name}, happy birthday from all of us at BlackBole! Here's a Tk ${BIRTHDAY_OFF} gift for you — use code ${code} on your next order (min Tk ${BIRTHDAY_MIN}). Hope today's a great one!`
}
function waBody(name: string, code: string) {
  return `Hi ${name} 🎉\n\nHappy Birthday from everyone at BlackBole! Just wanted to drop a quick note to say we're really glad to have you with us.\n\nAs a little gift, here's ৳${BIRTHDAY_OFF} off your next order — code *${code}* at checkout (on orders ৳${BIRTHDAY_MIN}+).\n\nHope today's full of good food, good people and zero stress 🎂`
}

/** Mirrors ensureDiscount/ensureShopifyDiscount in winback.ts — same two-step pattern (Ops's own `discounts`
 *  table, then the live Shopify store where checkout actually validates codes), just for the one fixed code
 *  above instead of a monthly-rotating one. Both are no-ops once the code already exists. */
export const ensureBirthdayDiscount = internalMutation({
  args: {},
  handler: async (ctx) => {
    const exists = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", BIRTHDAY_CODE)).first()
    if (exists) return
    const now = Date.now()
    await ctx.db.insert("discounts", {
      code: BIRTHDAY_CODE, title: "Birthday gift", type: "amount", value: BIRTHDAY_OFF, scope: "all", items: [],
      minSubtotal: BIRTHDAY_MIN, oncePerCustomer: true, active: true, usedCount: 0, createdAt: now, updatedAt: now,
    })
  },
})

export const ensureBirthdayShopifyDiscount = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const d: any = await shopifyGql(ctx, `mutation($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } }
        }`, {
        input: {
          title: "Birthday gift", code: BIRTHDAY_CODE, startsAt: new Date().toISOString(), appliesOncePerCustomer: true,
          context: { all: "ALL" },
          customerGets: { items: { all: true }, value: { discountAmount: { amount: BIRTHDAY_OFF, appliesOnEachItem: false } } },
          minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: BIRTHDAY_MIN } },
        },
      })
      const errs = d.discountCodeBasicCreate.userErrors
      if (errs?.length && !errs.some((e: any) => /taken|already exist/i.test(e.message))) {
        console.error(`Shopify birthday discount sync failed: ${errs.map((e: any) => e.message).join("; ")}`)
      }
    } catch (e) {
      console.error(`Shopify birthday discount sync failed: ${String((e as Error).message ?? e)}`)
    }
  },
})

/** Customers whose stored dob (YYYY-MM-DD) matches today's month+day, Asia/Dhaka — the year doesn't need to
 *  match anything, it's just there to compute an age to show if it looks real. */
export const today = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "dashboard.view")
    const md = monthDay(Date.now())
    const year = new Date(Date.now() + BD_OFFSET).getUTCFullYear()
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.dob && c.dob.slice(5, 10) === md)
      .map((c) => {
        const bornYear = Number(c.dob!.slice(0, 4))
        return {
          _id: c._id, name: c.name, phone: c.phone, email: c.email, dob: c.dob!, orderCount: c.orderCount,
          turning: bornYear > 1920 ? year - bornYear : undefined,
          birthdayEmailAt: c.birthdayEmailAt, birthdaySmsAt: c.birthdaySmsAt, birthdayWaQueuedAt: c.birthdayWaQueuedAt,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  },
})

/** For emailNode.sendBirthdayEmail — fetches just what's needed to send and show the name. */
export const customerRaw = internalQuery({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const c = await ctx.db.get(customerId)
    if (!c || c.deletedAt) return null
    return { name: c.name, email: c.email, phone: c.phone }
  },
})

/** Logs a Customer Care-sent birthday email (channel "birthday", shows in the same Recent activity feed as the
 *  other channels) and marks the panel's "Sent" state. */
export const logSent = internalMutation({
  args: { customerId: v.id("customers"), email: v.string(), text: v.string(), error: v.union(v.string(), v.null()), by: v.string() },
  handler: async (ctx, { customerId, email, text, error, by }) => {
    await ctx.db.insert("smsLogs", { phone: email, text: `${text} (sent by ${by})`, status: error ? "failed" : "sent", error: error ?? undefined, channel: "birthday", customerId, at: Date.now() })
    if (!error) await ctx.db.patch(customerId, { birthdayEmailAt: Date.now() })
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Automatic daily send (cron) — email + SMS go out on their own; WhatsApp is drafted and queued for a human tap.
// ---------------------------------------------------------------------------------------------------------------

/** Today's birthday customers plus their last-sent timestamp per channel — for the cron, no staff sign-in needed. */
export const dueToday = internalQuery({
  args: {},
  handler: async (ctx) => {
    const md = monthDay(Date.now())
    const rows = await ctx.db.query("customers").withIndex("by_created").collect()
    return rows
      .filter((c) => !c.deletedAt && c.dob && c.dob.slice(5, 10) === md)
      .map((c) => ({
        _id: c._id, name: c.name, phone: c.phone, email: c.email,
        birthdayEmailAt: c.birthdayEmailAt, birthdaySmsAt: c.birthdaySmsAt, birthdayWaQueuedAt: c.birthdayWaQueuedAt,
      }))
  },
})

export const logAutoEmail = internalMutation({
  args: { customerId: v.id("customers"), email: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, email, text, error }) => {
    await ctx.db.insert("smsLogs", { phone: email, text: `${text} (Automatic)`, status: error ? "failed" : "sent", error: error ?? undefined, channel: "birthday", customerId, at: Date.now() })
    if (!error) await ctx.db.patch(customerId, { birthdayEmailAt: Date.now() })
  },
})

export const logAutoSms = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), text: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId, phone, text, error }) => {
    await ctx.db.insert("smsLogs", { phone, text: `${text} (Automatic)`, status: error ? "failed" : "sent", error: error ?? undefined, channel: "birthday", customerId, at: Date.now() })
    if (!error) await ctx.db.patch(customerId, { birthdaySmsAt: Date.now() })
  },
})

/** Drafts the WhatsApp message into the shared send queue (waQueue.ts) — same table win-back uses, source
 *  "birthday" so it's labeled apart. A human still taps "Open WhatsApp" and presses send themselves; this only
 *  saves them writing the message. Tracked on its own field (birthdayWaQueuedAt) so it never collides with
 *  win-back's own queue-dedup clock on the same customer. */
export const queueWa = internalMutation({
  args: { customerId: v.id("customers"), phone: v.string(), name: v.string(), text: v.string() },
  handler: async (ctx, { customerId, phone, name, text }) => {
    await ctx.db.insert("waQueue", { customerId, phone, name, text, source: "birthday", status: "pending", createdAt: Date.now() })
    await ctx.db.patch(customerId, { birthdayWaQueuedAt: Date.now() })
  },
})

/** Runs daily (see crons.ts). For every customer whose birthday is today: sends an email and an SMS straight
 *  away (both fully automatic — no WhatsApp-style ban risk), and drafts a WhatsApp message into the queue for a
 *  human tap. Skips a channel it already reached today, so a re-trigger the same day never double-sends. */
export const sendAutomatic = internalAction({
  args: {},
  handler: async (ctx) => {
    const today = dateKey(Date.now())
    const list = await ctx.runQuery(internal.birthdays.dueToday, {})
    if (!list.length) return
    await ctx.runMutation(internal.birthdays.ensureBirthdayDiscount, {})
    await ctx.runAction(internal.birthdays.ensureBirthdayShopifyDiscount, {})
    for (const c of list) {
      const name = firstName(c.name)
      if (c.email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(c.email) && !sentToday(c.birthdayEmailAt, today)) {
        await ctx.runAction(internal.emailNode.sendBirthdayEmailAuto, { customerId: c._id, to: c.email, subject: `Happy Birthday, ${name}! 🎂`, text: emailBody(name, BIRTHDAY_CODE) })
      }
      if (c.phone && !sentToday(c.birthdaySmsAt, today)) {
        const sms = await ctx.runQuery(internal.outbound.smsSettingsRaw, {})
        if (sms?.enabled) {
          const text = smsBody(name, BIRTHDAY_CODE)
          const error = await sendSms(sms, c.phone, text)
          await ctx.runMutation(internal.birthdays.logAutoSms, { customerId: c._id, phone: c.phone, text, error })
        }
      }
      if (c.phone && !sentToday(c.birthdayWaQueuedAt, today)) {
        await ctx.runMutation(internal.birthdays.queueWa, { customerId: c._id, phone: c.phone, name: c.name, text: waBody(name, BIRTHDAY_CODE) })
      }
    }
  },
})
