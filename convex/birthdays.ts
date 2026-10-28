// Birthday panel: a customer can optionally give their date of birth on the website order form ("we'd love to
// wish you — and send a little something — on your birthday"). This surfaces who's celebrating today so the
// team can call, wish them, and arrange the small coupon/gift on the actual day.
import { v } from "convex/values"
import { query, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { requirePerm } from "./lib"

const BD_OFFSET = 6 * 3600000

function monthDay(at: number) {
  const d = new Date(at + BD_OFFSET)
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
}

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
          turning: bornYear > 1920 ? year - bornYear : undefined, birthdayEmailAt: c.birthdayEmailAt,
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
    return { name: c.name, email: c.email }
  },
})

/** Logs a Customer Care-sent birthday email (channel "birthday", shows in the same Recent activity feed as the
 *  other channels) and marks the panel's "Sent" state. Manual only — never called from a cron. */
export const logSent = internalMutation({
  args: { customerId: v.id("customers"), email: v.string(), text: v.string(), error: v.union(v.string(), v.null()), by: v.string() },
  handler: async (ctx, { customerId, email, text, error, by }) => {
    await ctx.db.insert("smsLogs", { phone: email, text: `${text} (sent by ${by})`, status: error ? "failed" : "sent", error: error ?? undefined, channel: "birthday", customerId, at: Date.now() })
    if (!error) await ctx.db.patch(customerId, { birthdayEmailAt: Date.now() })
  },
})
