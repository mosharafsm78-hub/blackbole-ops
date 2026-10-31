// The route to Tk 1 crore a month — a step-by-step checklist, each step with an owner department, a deadline, what to
// do and what NOT to do. Anyone signed in can tick a step (who and when are kept); an unticked step past its deadline
// raises one accountability flag to its department, so a missed step is chased the same way every other miss is.
import { v, ConvexError } from "convex/values"
import { internal } from "./_generated/api"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { requirePerm } from "./lib"

/** End of a Dhaka calendar day (UTC+6) as a timestamp. */
const eod = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d, 17, 59, 59) }

type Seed = [phase: string, team: string, title: string, due: string, doText: string, dontText: string]
const P1 = "1 · Clean base (1–7 Nov)", P2 = "2 · Fill the funnel (8–21 Nov)", P3 = "3 · Deliver and keep (22–30 Nov)", P4 = "4 · The monthly ladder to Tk 1 crore"
export const SEED: Seed[] = [
  [P1, "Fulfillment", "Count every stock line in Stock check", "2026-11-05", "Count all remaining lines; type the pairs you can see, the rest becomes fake stock. Target and plans only trust counted stock.", "Don't leave lines uncounted, and don't count by guessing."],
  [P1, "Development", "blackbole.com works again, or redirects to blackbole.top", "2026-11-03", "Restore the domain, or point it to https://blackbole.top. Check old ad, email, SMS and WhatsApp links.", "Don't run ads or send messages to a link that does not open."],
  [P1, "Development", "Test checkout end to end on blackbole.top", "2026-11-02", "Place one COD and one online-payment test order. Confirm it reaches Ops and the purchase event fires.", "Don't raise ad spend before this passes."],
  [P1, "Marketing", "Meta Pixel and Conversions API verified", "2026-11-03", "Check Events Manager: Purchase, Add to cart, Initiate checkout all arrive from blackbole.top, with matching quality.", "Don't optimise ads on a pixel that is not firing."],
  [P1, "Marketing", "Write down the baseline numbers", "2026-11-04", "Last 30 days: delivered revenue, orders a day, average order value, delivery rate, return rate, ad cost per order. Put them in the weekly review notes.", "Don't set budgets or promises without these numbers."],
  [P1, "Fulfillment", "Full size run on the top 10 products", "2026-11-07", "For each of the 10 best sellers on the Target page, make sure every common size is in stock. Reorder what is short.", "Don't push ads to a product with a broken size run."],
  [P1, "Marketing", "Fake-stock products: decide buy or drop", "2026-11-07", "Any fake-stock product with 5+ orders in a week: raise a purchase. The rest keep testing or stop.", "Don't promise delivery dates on fake stock, and don't count it in the target."],
  [P2, "Marketing", "Simple ad structure live", "2026-11-08", "One prospecting campaign (Advantage+ Shopping), one retargeting, one catalog. About 70% / 20% / 10% of budget.", "Don't run 20 small campaigns that never leave the learning phase."],
  [P2, "Marketing", "Three new video creatives a week, first batch out", "2026-11-14", "Hero products only. New hook in the first 3 seconds, real pair in hand, price and delivery clear.", "Don't keep a creative running once its CTR has fallen for 3 days."],
  [P2, "Marketing", "Abandoned-cart recovery checked every day", "2026-11-10", "Look at Abandoned carts daily: emails sending, WhatsApp queue tapped, the Tk 50 popup collecting leads.", "Don't leave recovery messages sitting unsent."],
  [P2, "Marketing", "Win-back run to past customers", "2026-11-12", "Email is automatic; tap through the WhatsApp queue daily. All links on blackbole.top.", "Don't send to customers who asked to stop."],
  [P2, "Marketing", "Reviews and proof on the hero products", "2026-11-15", "At least 10 real reviews or customer photos on each top product page.", "Don't write fake reviews."],
  [P2, "Marketing", "Pre-order push: gift-box offer on home page and ads", "2026-11-14", "Make the pre-order offer and PREORDER500 / PREORDER700 clear on home, product pages and one ad set.", "Don't mix pre-order items into the regular in-stock campaigns."],
  [P2, "Marketing", "Lift order value: combos and a free-delivery threshold", "2026-11-20", "Launch two combo offers and a free-delivery threshold slightly above today's average order value.", "Don't discount so deep that margin disappears; check the profit line on the Target page."],
  [P2, "Marketing", "10 creators on commission or barter", "2026-11-18", "Sign 10 creators, each with a tracked code or link, so results are measured.", "Don't pay up front without a tracked result."],
  [P2, "Marketing", "Scale ad budget by steps", "2026-11-21", "Raise budget about 20% every 2–3 days, only while ad cost per order stays below your break-even.", "Don't double the budget overnight."],
  [P3, "Customer Care", "Every order confirmed within 2 hours", "2026-11-08", "Confirmation calls run in order of arrival, with the overdue list checked every morning.", "Don't let new orders sit unconfirmed overnight."],
  [P3, "Fulfillment", "Same-day dispatch for confirmed orders", "2026-11-10", "Pack and hand over to the courier on the day of confirmation, before cut-off.", "Don't batch orders to the next day."],
  [P3, "Customer Care", "Feedback calls on delivered orders", "2026-11-22", "Call delivered customers, log the reason on any bad feedback, and ask for a review from happy ones.", "Don't skip the log; repeat reasons are what we fix."],
  [P3, "Fulfillment", "Fix the top 3 return reasons at the source", "2026-11-22", "Take the top three reasons from Accountability and get a named fix with a date for each.", "Don't close a return reason with 'will be careful'."],
  [P3, "Fulfillment", "Compare couriers and move volume to the best", "2026-11-25", "Delivery rate, return rate and time per courier for the month; shift orders to the best performers.", "Don't keep sending to a courier with a poor delivery rate out of habit."],
  [P3, "Customer Care", "Team capacity for double the orders", "2026-11-28", "Plan calling, packing and courier handover for 2× today's daily orders in December.", "Don't scale ads faster than the team can confirm and dispatch."],
  [P4, "Marketing", "November: Tk 12 lakh delivered", "2026-11-30", "Review the month on the Target page. Write down what worked and what did not.", "Don't move the goalposts; if it was missed, name the cause."],
  [P4, "Marketing", "December: Tk 25 lakh delivered", "2026-12-31", "Needs roughly double the November orders a day. Plan stock and ad budget in mid-December for the January step.", "Don't buy stock on a guess; use the plan from the Target page."],
  [P4, "Marketing", "January: Tk 45 lakh delivered", "2027-01-31", "Repeat customers and creators carry a growing share. Check the repeat-customer share.", "Don't rely on ads alone."],
  [P4, "Marketing", "February: Tk 70 lakh delivered", "2027-02-28", "Add a second sales channel or a second city focus, and keep return rate under control.", "Don't let return rate climb while growing."],
  [P4, "Marketing", "March: Tk 1 crore delivered", "2027-03-31", "About Tk 3.3 lakh a day. Roughly 185 delivered orders a day at an order value near Tk 1,800.", "Don't cut ad spend in the final week to look profitable."],
]

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx)
    return await ctx.db.query("checklistItems").withIndex("by_sort").collect()
  },
})

/** Loads the starting route the first time the page is opened. Does nothing once there are steps. */
export const ensureSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx)
    if (await ctx.db.query("checklistItems").first()) return false
    let i = 0
    for (const [phase, team, title, due, doText, dontText] of SEED) await ctx.db.insert("checklistItems", { phase, team, title, doText, dontText, dueAt: eod(due), sort: ++i * 10 })
    return true
  },
})

export const tick = mutation({
  args: { id: v.id("checklistItems"), done: v.boolean() },
  handler: async (ctx, { id, done }) => {
    const me = await requirePerm(ctx)
    const it = await ctx.db.get(id)
    if (!it) throw new ConvexError("Step not found")
    await ctx.db.patch(id, done ? { doneAt: Date.now(), doneBy: me.staff.name } : { doneAt: undefined, doneBy: undefined })
  },
})

export const addStep = mutation({
  args: { phase: v.string(), team: v.string(), title: v.string(), doText: v.string(), dontText: v.string(), due: v.string() },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    const title = a.title.trim()
    if (!title) throw new ConvexError("Give the step a name.")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.due)) throw new ConvexError("Pick a deadline date.")
    const last = await ctx.db.query("checklistItems").withIndex("by_sort").order("desc").first()
    await ctx.db.insert("checklistItems", { phase: a.phase, team: a.team, title, doText: a.doText.trim(), dontText: a.dontText.trim(), dueAt: eod(a.due), sort: (last?.sort ?? 0) + 10, custom: true })
  },
})

export const removeStep = mutation({
  args: { id: v.id("checklistItems") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "team.manage")
    const it = await ctx.db.get(id)
    if (it?.custom) await ctx.db.delete(id)
    else throw new ConvexError("Only steps you added yourself can be removed.")
  },
})

export const overdueUnflagged = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("checklistItems").collect()).filter((i) => !i.doneAt && !i.flaggedAt && i.dueAt < Date.now()),
})
export const markFlagged = internalMutation({
  args: { id: v.id("checklistItems") },
  handler: async (ctx, { id }) => { await ctx.db.patch(id, { flaggedAt: Date.now() }) },
})

/** Daily: a step past its deadline and still not ticked is raised once to the department that owns it. */
export const flagOverdue = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const it of await ctx.runQuery(internal.checklist.overdueUnflagged, {})) {
      await ctx.runMutation(internal.accountability.raiseSystem, { team: it.team, reason: `Route to Tk 1 crore: "${it.title}" missed its deadline`, note: `Due ${new Date(it.dueAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" })}. ${it.doText}` })
      await ctx.runMutation(internal.checklist.markFlagged, { id: it._id })
    }
  },
})
