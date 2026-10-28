import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Pathao: statuses and payments every 10 minutes; every Payment Due order re-checked every 30 minutes (paused 11 pm–8 am; Shopify orders arrive 24/7 by webhook)
crons.interval("pathao status sync", { minutes: 10 }, internal.pathao.cronTick, { job: "status" })
crons.interval("pathao money sync", { minutes: 10 }, internal.pathao.cronTick, { job: "money" })
crons.interval("pathao payment due check", { minutes: 30 }, internal.pathao.cronTick, { job: "due" })
// exchange orders without a Pathao parcel (Pathao booked the exchange under the earlier order number): find and link them
crons.interval("pathao exchange parcels", { minutes: 60 }, internal.pathao.cronTick, { job: "exchange" })
// automatic order confirmation calls: start due calls every minute (does nothing while switched off)
crons.interval("auto confirmation calls", { minutes: 1 }, internal.autoCalls.tick, {})
crons.interval("auto approve scheduled orders", { minutes: 5 }, internal.orders.runAutoApprove, {})
// win-back SMS, tier 1: one-time buyers who never came back get an automatic discount SMS, repeated every
// winback.REPEAT1_DAYS until they order again (does nothing before its start date or while switched off)
crons.interval("win-back sweep", { hours: 1 }, internal.winback.run, {})
// win-back email, tier 1: same idea, same cadence, by email instead — fully automatic like SMS (no WhatsApp-style ban risk)
crons.interval("win-back email sweep", { hours: 1 }, internal.winback.runEmail, {})
// WhatsApp send queue, tier 1: drafts a win-back message for a human to tap-send (never sends anything itself)
crons.interval("whatsapp queue fill", { hours: 1 }, internal.waQueue.run, {})
// Tier 2 — repeat buyers (2+ orders) who've gone quiet: same three channels, slower cadence
// (winback.TIER2_FIRST_DAYS then winback.TIER2_REPEAT_DAYS), same monthly discount code.
crons.interval("win-back sweep (repeat buyers)", { hours: 1 }, internal.winback.run2, {})
crons.interval("win-back email sweep (repeat buyers)", { hours: 1 }, internal.winback.runEmail2, {})
crons.interval("whatsapp queue fill (repeat buyers)", { hours: 1 }, internal.waQueue.run2, {})

// Birthday wishes: anyone whose dob matches today gets an automatic email + SMS, and a WhatsApp message
// drafted into the same human-tap queue win-back uses (see waQueue.ts for why WhatsApp isn't fully automatic).
// 10:00 Asia/Dhaka (UTC+6) = 04:00 UTC.
crons.daily("birthday wishes", { hourUTC: 4, minuteUTC: 0 }, internal.birthdays.sendAutomatic, {})

// Accountability: every owner with open items gets a daily digest email of everything still waiting on them
// (from day 1, on top of the immediate email when it's first raised), and the operations head separately gets
// pinged about anything past the 2-day SLA. Repeats every day it stays open. 9:00 Asia/Dhaka (UTC+6) = 03:00 UTC.
crons.daily("accountability daily digest", { hourUTC: 3, minuteUTC: 0 }, internal.accountability.checkOverdue, {})
// Business health: not just customer-care call logs — a weekly look at sales trend and return ratio, the way
// an operations head would read the whole business, raising a flag against the owning department (Marketing
// for sales, Fulfillment for returns) even when no one logged a call. Monday 9:00 Asia/Dhaka (UTC+6) = 03:05 UTC.
crons.weekly("accountability business health", { dayOfWeek: "monday", hourUTC: 3, minuteUTC: 5 }, internal.accountability.businessHealthCheck, {})

// Website: pairs sold per product (last 90 days) for "Best selling" collection order
crons.interval("website best sellers", { hours: 6 }, internal.website.salesTick, {})

export default crons
