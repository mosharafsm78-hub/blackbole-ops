// Birthday panel: a customer can optionally give their date of birth on the website order form ("we'd love to
// wish you — and send a little something — on your birthday"). This surfaces who's celebrating today so the
// team can call, wish them, and arrange the small coupon/gift on the actual day.
import { query } from "./_generated/server"
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
        return { _id: c._id, name: c.name, phone: c.phone, email: c.email, dob: c.dob!, orderCount: c.orderCount, turning: bornYear > 1920 ? year - bornYear : undefined }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  },
})
