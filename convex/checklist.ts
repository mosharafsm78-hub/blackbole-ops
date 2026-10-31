// The route to Tk 1 crore a month — a step-by-step checklist, each step with an owner department, a deadline, what to
// do and what NOT to do. Anyone signed in can tick a step (who and when are kept); an unticked step past its deadline
// raises one accountability flag to its department, so a missed step is chased the same way every other miss is.
import { v, ConvexError } from "convex/values"
import { internal } from "./_generated/api"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { getSetting, requirePerm, setSetting } from "./lib"

/** End of a Dhaka calendar day (UTC+6) as a timestamp. */
const eod = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d, 17, 59, 59) }

type Seed = [rung: string, team: string, title: string, due: string, doText: string, dontText: string]

/** Where BlackBole stands, read from the ops system (Reports, Dashboard, Meta ad account) on 31 Oct 2026, last 30 days. */
export const NOW: [string, string][] = [
  ["Delivered revenue", "Tk 4.44 lakh (248 orders)"],
  ["Booked orders", "431 · about 14 a day · Tk 8.1 lakh"],
  ["Average order", "Tk 1,883"],
  ["Delivery success", "65% (268 of 413 parcels)"],
  ["Returned / cancelled", "29% returned · 19% cancelled"],
  ["Ad spend", "Tk 1.47 lakh · Tk 342 per booked order · Tk 594 per delivered order"],
  ["Repeat buyers", "9% (1,355 one-time buyers spent Tk 25 lakh)"],
  ["Trend", "Orders fell from 766 in June to 458 so far in October"],
]

/** The rungs. Rung 1 IS the November revenue target already set on the Target page (Tk 12 lakh), so the two never
 *  disagree; each later rung is a month. A rung is climbed only when its numbers hold for two weeks. Order value,
 *  delivery rate and cost per order are planning figures built from the numbers above (cost per order may rise a
 *  little at each rung). Each rung's month is checked against the Target page on the checklist screen. */
export const RUNGS: { key: string; title: string; month: string; amount: number; need: { booked: number; delivery: number; cancelMax?: number }; numbers: [string, string][]; gate: string }[] = [
  { key: "R1", need: { booked: 28, delivery: 72, cancelMax: 14 }, title: "Rung 1 · Tk 12 lakh delivered · November", month: "2026-11", amount: 1200000, numbers: [["Booked orders a day", "28 (now 14)"], ["Delivery success", "72% (now 65%)"], ["Cancelled", "14% or less (now 19%)"], ["Ad spend a day", "about Tk 10,000 (now 4,900)"], ["Cost per booked order", "Tk 350 or less"], ["Pairs a month", "about 840"]], gate: "28 booked orders a day, delivery 72%, cancelled 14% or less, for 2 weeks in a row." },
  { key: "R2", need: { booked: 45, delivery: 75, cancelMax: 13 }, title: "Rung 2 · Tk 20 lakh delivered · December", month: "2026-12", amount: 2000000, numbers: [["Booked orders a day", "45"], ["Delivery success", "75%"], ["Repeat buyers", "12%"], ["Ad spend a day", "about Tk 16,500"], ["Cost per booked order", "Tk 370 or less"], ["Pairs a month", "about 1,350"]], gate: "45 booked orders a day, delivery 75%, for 2 weeks in a row." },
  { key: "R3", need: { booked: 65, delivery: 76, cancelMax: 12 }, title: "Rung 3 · Tk 30 lakh delivered · January", month: "2027-01", amount: 3000000, numbers: [["Booked orders a day", "65"], ["Delivery success", "76%"], ["Repeat buyers", "15%"], ["Ad spend a day", "about Tk 25,000"], ["Cost per booked order", "Tk 390 or less"], ["Pairs a month", "about 1,950"]], gate: "65 booked orders a day, delivery 76%, repeat buyers 15%, for 2 weeks in a row." },
  { key: "R4", need: { booked: 95, delivery: 78, cancelMax: 12 }, title: "Rung 4 · Tk 45 lakh delivered · February", month: "2027-02", amount: 4500000, numbers: [["Booked orders a day", "95"], ["Delivery success", "78%"], ["Repeat buyers", "18%"], ["Ad spend a day", "about Tk 39,000"], ["Cost per booked order", "Tk 410 or less"], ["Pairs a month", "about 2,850"]], gate: "95 booked orders a day, delivery 78%, for 2 weeks in a row." },
  { key: "R5", need: { booked: 145, delivery: 80, cancelMax: 12 }, title: "Rung 5 · Tk 70 lakh delivered · March (Eid-ul-Fitr about 9–10 March)", month: "2027-03", amount: 7000000, numbers: [["Booked orders a day", "145"], ["Delivery success", "80%"], ["Repeat buyers", "22%"], ["Ad spend a day", "about Tk 62,000"], ["Cost per booked order", "Tk 430 or less"], ["Pairs a month", "about 4,350"]], gate: "145 booked orders a day, delivery 80%, for 2 weeks in a row." },
  { key: "R6", need: { booked: 210, delivery: 80, cancelMax: 12 }, title: "Rung 6 · Tk 1 crore delivered · May–June (Eid-ul-Adha about 17 May)", month: "2027-06", amount: 10000000, numbers: [["Booked orders a day", "210"], ["Delivery success", "80%"], ["Repeat buyers", "25%"], ["Ad spend a day", "about Tk 92,000"], ["Cost per booked order", "Tk 440 or less"], ["Pairs a month", "about 6,300"]], gate: "210 booked orders a day, delivery 80%, for 2 weeks in a row. Then hold it for a full month." },
]
const T = (k: string) => RUNGS.find((r) => r.key === k)!.title

export const SEED: Seed[] = [
  // ---- Rung 1: Tk 12 lakh in November (the target on the Target page) ----
  [T("R1"), "Customer Care", "Clear the 34 orders On Hold", "2026-11-03", "Call every On Hold order (34 today, waiting on the customer). Each one confirmed or cancelled within 48 hours, and the reason set on it.", "Don't leave an order on hold for more than 2 days with no call."],
  [T("R1"), "Customer Care", "Never leave the district blank", "2026-11-07", "In the 7-day report, 66 of 99 orders had no district and delivered at 61%. Confirm district and full address on the confirmation call.", "Don't send a parcel with no district."],
  [T("R1"), "Customer Care", "Cancelled orders 19% → 14%", "2026-11-14", "101 orders were cancelled in 30 days. Call every new order within 2 hours and write the cancel reason on every cancelled one. Take the top 3 reasons to Accountability.", "Don't cancel without a reason on the order."],
  [T("R1"), "Customer Care", "Clear the 90 pending return reasons and 274 feedback calls", "2026-11-14", "Finish the 90 return reasons first, then the feedback calls. 137 parcels came back in 30 days; the reasons are what we fix.", "Don't skip the reason on a return."],
  [T("R1"), "Customer Care", "Calling team ready for 35 placed orders a day", "2026-11-12", "28 booked a day is about 35 placed. If the pending list is not empty by 6pm, add a person.", "Don't let new orders wait overnight."],
  [T("R1"), "Fulfillment", "Fix the high-return products", "2026-11-10", "Nawabi Pakistani Punjabi Shoe: 7 sold, 5 returned in the last 7 days. Veyron colour complaint (BB-11468): photos do not match the leather. Check size chart, quality and photos for both and fix.", "Don't spend ad money on a product that returns more than it delivers."],
  [T("R1"), "Fulfillment", "Full size run on the top 5 products", "2026-11-07", "Harbor Shore Black and Brown, Veyron Olive and Gray, Moonsoon Glide Hiking Shoe: every common size in stock for about 840 pairs a month.", "Don't push ads to a product with a broken size run."],
  [T("R1"), "Marketing", "Ad spend Tk 4,900 → Tk 10,000 a day, on those 5 products", "2026-11-21", "Start at Tk 6,000 on 8 Nov and raise about 20% every 3 days. Keep cost per booked order at Tk 350 or less.", "Don't double the budget overnight. Don't keep an ad with cost per order above Tk 450 for 3 days."],
  [T("R1"), "Marketing", "Win-back: 30 WhatsApp messages tapped every day", "2026-11-05", "1,355 one-time buyers spent Tk 25 lakh and went quiet. Email is automatic; tap the WhatsApp queue daily, links on blackbole.top.", "Don't skip days. Don't message customers who asked to stop."],
  [T("R1"), "Marketing", "Pre-order codes live: PREORDER500 / PREORDER700", "2026-11-14", "Gift-box pre-order offer on the home page and one ad set.", "Don't mix pre-order items into the in-stock ad sets."],
  [T("R1"), "Marketing", "Weekly review, Sunday 8 Nov", "2026-11-08", "30 minutes: live numbers against this rung, the one thing that failed this week, one fix with an owner and a date. Write it in the step's team chat.", "Don't skip it because the week was good, and don't leave a failure without an owner."],
  [T("R1"), "Marketing", "Weekly review, Sunday 15 Nov", "2026-11-15", "Same review. Check last week's fix was done.", "Don't carry a fix into a third week."],
  [T("R1"), "Marketing", "Weekly review, Sunday 22 Nov", "2026-11-22", "Same review. If delivery or cancelled is going the wrong way, stop raising ad spend until it turns.", "Don't raise spend while the leaks are growing."],
  [T("R1"), "Marketing", "Weekly review, Sunday 29 Nov", "2026-11-29", "Same review, then the gate on 30 Nov.", "Don't argue with the gate numbers."],
  [T("R1"), "Marketing", "GATE: Rung 1 numbers held for 2 weeks", "2026-11-30", "28 booked orders a day, delivery 72%, cancelled 14% or less, and Tk 12 lakh delivered on the Target page. Check on Reports (last 14 days).", "Don't tick it by feel. Don't start Rung 2 spending before this."],
  // ---- Rung 2: Tk 20 lakh ----
  [T("R2"), "Marketing", "Winter push: boots and loafers from 1 Dec", "2026-12-01", "Genuine Leather High Ankle Boot (74 in stock), Pierre Cardin Chelsea Boot, Veyron loafers. Three video creatives a week on these.", "Don't lead with sandals in December."],
  [T("R2"), "Marketing", "Ad budget Tk 16,500 a day", "2026-12-10", "Split about 70% new customers, 20% retargeting, 10% catalog. 20% steps every 3 days while cost per booked order stays at Tk 370 or less.", "Don't scale on booked orders if delivery falls below 72%."],
  [T("R2"), "Marketing", "Backup ad account ready", "2026-12-10", "Several Famons.in ad accounts were disabled for unusual activity. Verify the business, keep a second healthy account with a payment method, and keep BlackBole BDT clean.", "Don't run the whole business on one ad account."],
  [T("R2"), "Fulfillment", "Six weeks of stock on the top 5, full size run", "2026-12-05", "45 orders a day is about 1,350 pairs a month. Order what is short before the ads go up.", "Don't push ads to a broken size run."],
  [T("R2"), "Fulfillment", "40% of top-seller stock held in Dhaka", "2026-12-15", "Dhaka orders deliver faster from the Dhaka warehouse. Move 40% of the top-seller pairs there.", "Don't ship Dhaka orders from Chattogram when Dhaka has stock."],
  [T("R2"), "Customer Care", "Two more calling agents trained", "2026-12-15", "45 booked a day is about 55 placed a day to confirm.", "Don't hire without a script and the cancel-reason log."],
  [T("R2"), "Fulfillment", "Second courier trialled on 10% of orders", "2026-12-22", "Two weeks of data: delivery rate and return rate against Pathao.", "Don't move volume without two weeks of data."],
  [T("R2"), "Marketing", "Repeat buyers 9% → 12%", "2026-12-20", "SMS and WhatsApp 10–20 days after delivery with a second-order code. Count repeat share monthly on the dashboard.", "Don't give the discount to first orders."],
  [T("R2"), "Marketing", "GATE: Rung 2 numbers held for 2 weeks", "2026-12-31", "45 booked orders a day and delivery 75%, for 14 days in a row (Reports, last 14 days).", "Don't move up on a single good day."],
  // ---- Rung 3: Tk 30 lakh ----
  [T("R3"), "Marketing", "10 creators on tracked codes", "2027-01-10", "Each creator has a code or link, so results are measured.", "Don't pay up front without a tracked code."],
  [T("R3"), "Marketing", "Test TikTok ads: Tk 3,000 a day", "2027-01-12", "Same top products and creatives. Judge on cost per booked order.", "Don't expect Facebook-level results in week one."],
  [T("R3"), "Marketing", "Ad budget Tk 25,000 a day", "2027-01-15", "20% steps. Cost per booked order Tk 390 or less.", "Don't hide a rising cost by changing how it is measured."],
  [T("R3"), "Marketing", "Eid-ul-Fitr plan locked", "2027-01-25", "Eid is about 9–10 March and online sales rise 40–50% around Eid. Stock for 2,500+ pairs, creative ready by 15 Feb, ad budget plan for 2 March onward.", "Don't buy Eid stock after mid-February."],
  [T("R3"), "Marketing", "Repeat buyers 12% → 15%", "2027-01-25", "Keep the second-order message running every day.", "Don't stop it when sales are good."],
  [T("R3"), "Marketing", "GATE: Rung 3 numbers held for 2 weeks", "2027-01-31", "65 booked orders a day, delivery 76%, repeat buyers 15%.", "Don't start Rung 4 stock buying before this."],
  // ---- Rung 4: Tk 45 lakh ----
  [T("R4"), "Fulfillment", "Dispatch same day, before 4pm cut-off", "2027-02-05", "At 95 orders a day a one-day delay adds hundreds of angry customers.", "Don't batch orders to the next day."],
  [T("R4"), "Customer Care", "Calling team sized for 120 orders placed a day", "2027-02-10", "Count calls per agent and hire to that number.", "Don't scale ads faster than the team can confirm."],
  [T("R4"), "Marketing", "Ad budget Tk 39,000 a day", "2027-02-10", "20% steps only. Cost per booked order Tk 410 or less.", "Don't scale if delivery falls below 76%."],
  [T("R4"), "Fulfillment", "Eid stock in hand and counted", "2027-02-25", "Every Eid product counted in Stock check, full size run, 4,000+ pairs across Dhaka and Chattogram.", "Don't count fake stock as stock."],
  [T("R4"), "Marketing", "GATE: Rung 4 numbers held for 2 weeks", "2027-02-28", "95 booked orders a day, delivery 78%.", "Don't tick on one record day."],
  // ---- Rung 5: Tk 70 lakh (Eid-ul-Fitr) ----
  [T("R5"), "Marketing", "Eid campaign live 2 March", "2027-03-02", "Eid offer, delivery cut-off date shown on every page and ad, Messenger and WhatsApp replies ready.", "Don't promise an Eid delivery date you cannot meet."],
  [T("R5"), "Fulfillment", "Second packing shift", "2027-03-01", "145 orders a day needs a second shift or more packers. Same-day dispatch must still hold.", "Don't let the dispatch backlog grow."],
  [T("R5"), "Marketing", "Ad budget Tk 62,000 a day", "2027-03-05", "20% steps. Cut any ad whose cost per order is over Tk 520 for 3 days.", "Don't chase volume at any cost."],
  [T("R5"), "Marketing", "April: keep at Tk 55 lakh or more", "2027-04-30", "Do not let the post-Eid month fall back. Repeat buyers 22%.", "Don't cut the creative pipeline after Eid."],
  [T("R5"), "Marketing", "GATE: Rung 5 numbers held for 2 weeks", "2027-03-31", "145 booked orders a day, delivery 80%.", "Don't start Rung 6 before this."],
  // ---- Rung 6: Tk 1 crore ----
  [T("R6"), "Fulfillment", "6,300 pairs a month supplied", "2027-05-01", "A standing monthly purchase plan with supplier and factory lead times written down.", "Don't run out of the top 10 products."],
  [T("R6"), "Marketing", "Eid-ul-Adha campaign live", "2027-05-05", "About 17 May. Same plan as Eid-ul-Fitr, with the lessons from March.", "Don't repeat a mistake we already wrote down."],
  [T("R6"), "Customer Care", "Calling team sized for 260 orders placed a day", "2027-05-10", "About 5 agents on confirmation plus a returns team.", "Don't let new orders wait overnight."],
  [T("R6"), "Marketing", "Ad budget Tk 92,000 a day", "2027-05-20", "20% steps; ad spend stays near 27% of delivered revenue or lower.", "Don't scale on booked orders if delivery falls below 78%."],
  [T("R6"), "Marketing", "GATE: Tk 1 crore delivered in a month", "2027-06-30", "210 booked orders a day, delivery 80%. Delivered revenue Tk 1 crore on the Target page.", "Don't call it done before a full month."],
]


const DAYMS = 86400000
const bd = (t: number) => new Date(t + 6 * 3600000).toISOString().slice(0, 10)

/** The real numbers behind every gate, read from the daily scoreboard (the same one the dashboard uses):
 *  booked orders a day over the last 14 full days; delivery success and cancelled share over the last 30 days. */
async function readActuals(ctx: any) {
  const now = Date.now()
  const rows = await ctx.db.query("dayStats").withIndex("by_day", (q: any) => q.gte("day", bd(now - 30 * DAYMS)).lte("day", bd(now - DAYMS))).collect()
  const cut14 = bd(now - 14 * DAYMS)
  let booked14 = 0, delivered = 0, returned = 0, cancelled = 0, all = 0
  for (const r of rows as { day: string; st: { s: string; n: number }[] }[]) for (const x of r.st) {
    all += x.n
    if (x.s === "cancelled") cancelled += x.n
    else if (r.day >= cut14) booked14 += x.n
    if (x.s === "delivered_due" || x.s === "delivered_paid") delivered += x.n
    if (x.s === "pending_returned" || x.s === "returned" || x.s === "damaged") returned += x.n
  }
  return {
    bookedPerDay: Math.round((booked14 / 14) * 10) / 10,
    deliveryPct: delivered + returned > 0 ? Math.round((delivered / (delivered + returned)) * 1000) / 10 : 0,
    cancelPct: all > 0 ? Math.round((cancelled / all) * 1000) / 10 : 0,
  }
}

function judge(a: { bookedPerDay: number; deliveryPct: number; cancelPct: number }, need: { booked: number; delivery: number; cancelMax?: number }) {
  const checks = [
    { label: "Booked orders a day", have: a.bookedPerDay, need: need.booked, ok: a.bookedPerDay >= need.booked, unit: "" },
    { label: "Delivery success", have: a.deliveryPct, need: need.delivery, ok: a.deliveryPct >= need.delivery, unit: "%" },
    ...(need.cancelMax !== undefined ? [{ label: "Cancelled", have: a.cancelPct, need: need.cancelMax, ok: a.cancelPct <= need.cancelMax, unit: "%", max: true }] : []),
  ]
  return { go: checks.every((c) => c.ok), checks }
}

/** Live numbers and a GO / NO-GO for every rung. The first rung that is not GO is the one being worked on. */
export const actuals = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx)
    const a = await readActuals(ctx)
    return { ...a, rungs: RUNGS.map((r) => ({ key: r.key, title: r.title, ...judge(a, r.need) })) }
  },
})

export const ladder = query({ args: {}, handler: async (ctx) => { await requirePerm(ctx); return { now: NOW, rungs: RUNGS } } })

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx)
    return await ctx.db.query("checklistItems").withIndex("by_sort").collect()
  },
})

const LADDER_VERSION = 4

/** Loads the ladder the first time the page is opened. A newer ladder replaces the older built-in steps (steps added by
 *  hand are kept). Does nothing when the current ladder is already loaded. */
export const ensureSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx)
    const have = (await getSetting<number>(ctx, "checklistVersion")) ?? 0
    if (have >= LADDER_VERSION && (await ctx.db.query("checklistItems").first())) return false
    for (const i of await ctx.db.query("checklistItems").collect()) if (!i.custom) await ctx.db.delete(i._id)
    let n = 0
    for (const [phase, team, title, due, doText, dontText] of SEED) await ctx.db.insert("checklistItems", { phase, team, title, doText, dontText, dueAt: eod(due), sort: ++n * 10 })
    await setSetting(ctx, "checklistVersion", LADDER_VERSION)
    return true
  },
})

export const tick = mutation({
  args: { id: v.id("checklistItems"), done: v.boolean() },
  handler: async (ctx, { id, done }) => {
    const me = await requirePerm(ctx)
    const it = await ctx.db.get(id)
    if (!it) throw new ConvexError("Step not found")
    if (done && it.title.startsWith("GATE:")) {
      // A gate is a go / no-go, as in any launch review: it can only be passed on measured numbers, never on feel.
      const rung = RUNGS.find((r) => r.title === it.phase)
      if (rung) {
        const j = judge(await readActuals(ctx), rung.need)
        if (!j.go) throw new ConvexError(`NO-GO: ${j.checks.filter((c) => !c.ok).map((c) => `${c.label} ${c.have}${c.unit} (need ${(c as any).max ? "at most " : ""}${c.need}${c.unit})`).join(", ")}. The gate opens when the numbers hold.`)
      }
    }
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
