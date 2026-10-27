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
// win-back SMS: one-time buyers who never came back get an automatic discount SMS (does nothing before its start date or while switched off)
crons.interval("win-back sweep", { hours: 1 }, internal.winback.run, {})
// WhatsApp send queue: drafts a win-back message for a human to tap-send (never sends anything itself)
crons.interval("whatsapp queue fill", { hours: 1 }, internal.waQueue.run, {})

// Website: pairs sold per product (last 90 days) for "Best selling" collection order
crons.interval("website best sellers", { hours: 6 }, internal.website.salesTick, {})

export default crons
