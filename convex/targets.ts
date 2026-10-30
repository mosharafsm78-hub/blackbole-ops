// Company revenue target: the monthly number, its split by day and by product, and the marketing budget it needs.
//
// One monthly target for the whole company, set by an admin in Settings → KPI. Revenue counts delivered orders
// only (the `total` of an order that reached Delivered, on the Dhaka day it was delivered — the same definition
// the Accounting dashboard uses). Everything else is worked out from data the app already holds, nothing typed
// in by hand: the day-by-day split (targetMath.ts), the pairs-per-product plan from sales history and stock, and
// the marketing budget from the target and the revenue earned per taka of ad spend (targetPlan.ts).
//
// Like the analytics report, this pages through orders and stock in small batches inside an action instead of
// reading a whole month of documents in one query. The gathered numbers are cached for a few minutes (shared by
// everyone who opens the dashboard); the target itself and the plan are read fresh on every call.
import { v, ConvexError } from "convex/values"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { action, internalAction, internalQuery, query, type ActionCtx } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, requirePerm, setSetting } from "./lib"
import { ownersConf } from "./accountability"
import { awardPoints } from "./kpi"
import { daysInMonth, dhakaDay, dhakaMonth, isMonthKey, monthEndMs, monthStartMs, nextMonthKey, planMonth, prevMonthKey, type MonthPlan } from "./targetMath"
import {
  buildPlan, classify, PLAN_VERSION, fixedTotal, marketingPlan, mixMargin, onPace, productRows, profitPlan, skuBase, summarizeSales,
  type MarketingPlan, type MonthlyCosts, type ProfitPlan, type ProductInput, type ProductPlan, type ProductRow, type SaleRow, type SalesSummary,
} from "./targetPlan"

const DAY = 86400000
const WINDOW_DAYS = 60 // how far back "what sells" is measured
const CACHE_MS = 10 * 60000
const SPEND_MS = 15 * 60000
const REPLAN_MS = 7 * DAY // the product plan is re-made weekly from what's still missing
const DELIVERED = new Set(["delivered_due", "delivered_paid"])

// ---------------------------------------------------------------------------------------------------------------
// The target itself
// ---------------------------------------------------------------------------------------------------------------

/** A month's target, or null when none is set. */
export const getTarget = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    if (!(await currentStaff(ctx))) return null
    const row = await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique()
    return row ? { month: row.month, amount: row.amount, setByName: row.setByName, updatedAt: row.updatedAt } : null
  },
})

/** Sets (or, with 0, clears) a month's company-wide revenue target. Only the current or a future month — a
 *  finished month's target is history, and quietly rewriting it would change what "we hit it" meant. A changed
 *  amount drops the saved product plan so it is re-made for the new number. */
export const setMonthlyTarget = mutation({
  args: { month: v.string(), amount: v.number() },
  handler: async (ctx, { month, amount }) => {
    const me = await requirePerm(ctx, "team.manage")
    if (!isMonthKey(month)) throw new ConvexError("Pick a valid month.")
    if (month < dhakaMonth(Date.now())) throw new ConvexError("A target can only be set for the current or a future month.")
    if (!Number.isFinite(amount) || amount < 0) throw new ConvexError("The target must be zero or more.")
    const whole = Math.round(amount)
    const existing = await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique()
    if (whole === 0) {
      if (existing) await ctx.db.delete(existing._id)
      return
    }
    const row = { month, amount: whole, setByName: me.staff.name, updatedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, existing.amount === whole ? row : { ...row, plan: undefined })
    else await ctx.db.insert("revenueTargets", row)
  },
})

// ---- monthly running costs (salary, rent, other): they decide what target is needed to make a profit ----

const costsArgs = { salary: v.number(), rent: v.number(), other: v.number() }

/** Salary, rent and other running costs per month. Managers only — salaries are not for everyone's eyes. */
export const getCosts = query({
  args: {},
  handler: async (ctx): Promise<MonthlyCosts | null> => {
    try { await requirePerm(ctx, "team.manage") } catch { return null }
    return (await getSetting<MonthlyCosts>(ctx, "monthlyCosts")) ?? { salary: 0, rent: 0, other: 0 }
  },
})

export const setMonthlyCosts = mutation({
  args: costsArgs,
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    for (const n of [a.salary, a.rent, a.other]) if (!Number.isFinite(n) || n < 0) throw new ConvexError("Costs must be zero or more.")
    await setSetting(ctx, "monthlyCosts", { salary: Math.round(a.salary), rent: Math.round(a.rent), other: Math.round(a.other) })
  },
})

/** For the progress action: the costs, or null for anyone who may not see them. */
export const costsForProgress = internalQuery({
  args: {},
  handler: async (ctx): Promise<MonthlyCosts | null> => {
    try { await requirePerm(ctx, "team.manage") } catch { return null }
    return (await getSetting<MonthlyCosts>(ctx, "monthlyCosts")) ?? null
  },
})

export const access = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) throw new ConvexError("You are not signed in or your access was removed.")
    return true
  },
})

export const targetRow = internalQuery({
  args: { month: v.string() },
  handler: async (ctx, { month }) => await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique(),
})

export const savePlan = internalMutation({
  args: { month: v.string(), plan: v.any() },
  handler: async (ctx, { month, plan }) => {
    const row = await ctx.db.query("revenueTargets").withIndex("by_month", (q) => q.eq("month", month)).unique()
    if (row) await ctx.db.patch(row._id, { plan })
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Pages of source data (small slices, so no single query reads a month of orders)
// ---------------------------------------------------------------------------------------------------------------

type Page<T> = { isDone: boolean; cursor: string; rows: T[] }

/** One page of delivered orders in [from, to), reduced to what the plan needs. */
export const salesPage = internalQuery({
  args: { from: v.number(), to: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }): Promise<Page<SaleRow>> => {
    const res = await ctx.db
      .query("orders")
      .withIndex("by_delivered", (q) => q.gte("deliveredAt", from).lt("deliveredAt", to))
      .paginate({ cursor, numItems: 300 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page
        .filter((o) => !o.deletedAt && DELIVERED.has(o.status))
        .map((o) => ({
          at: o.deliveredAt!,
          total: o.total,
          items: o.items.map((i) => ({ k: skuBase(i.sku), n: i.name, q: i.qty, a: i.price * i.qty - i.discount })),
        })),
    }
  },
})

export const productPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<Page<{ id: string; name: string; active: boolean; deleted: boolean; preOrder: boolean }>> => {
    const res = await ctx.db.query("products").paginate({ cursor, numItems: 100 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page.map((p) => ({ id: p._id as string, name: p.name, active: p.active, deleted: !!p.deletedAt, preOrder: !!p.preOrder })),
    }
  },
})

export const variantPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<Page<{ id: string; sku: string; productId: string; active: boolean; cost: number; price: number }>> => {
    const res = await ctx.db.query("variants").paginate({ cursor, numItems: 400 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page.map((x) => ({ id: x._id as string, sku: x.sku, productId: x.productId as string, active: x.active, cost: x.purchasePrice, price: x.price })),
    }
  },
})

export const stockPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<Page<{ variantId: string; locationId: string; available: number }>> => {
    const res = await ctx.db.query("stock").paginate({ cursor, numItems: 1000 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page.map((s) => ({ variantId: s.variantId as string, locationId: s.locationId as string, available: s.available })),
    }
  },
})

/** Warehouses whose stock can be sold to customers (the exchange warehouse is internal-only). */
export const sellableLocations = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> =>
    (await ctx.db.query("locations").collect()).filter((l: Doc<"locations">) => l.active && !l.noCourier).map((l) => l._id as string),
})

async function pageAll<T>(next: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  for (let i = 0; i < 300; i++) {
    const res = await next(cursor)
    out.push(...res.rows)
    if (res.isDone) break
    cursor = res.cursor
  }
  return out
}

const salesRows = (ctx: ActionCtx, from: number, to: number): Promise<SaleRow[]> =>
  pageAll<SaleRow>((cursor) => ctx.runQuery(internal.targets.salesPage, { from, to, cursor }))

// ---------------------------------------------------------------------------------------------------------------
// Gathering what the plan is built from
// ---------------------------------------------------------------------------------------------------------------

/** units null = pre-order (not capped); cost = average purchase price per pair, null when none is recorded. */
type StockMap = Record<string, { name: string; units: number | null; cost: number | null; price: number; sizes: number; sizesIn: number }>

type Gathered = {
  at: number
  byDay: SalesSummary["byDay"]
  trailing: SalesSummary["trailing"]
  mtd: SalesSummary["mtd"]
  ratio: number
  /** Sellable pairs per product; units null = pre-order (not capped). Null for a month that's already over. */
  stock: StockMap | null
  spend?: { at: number; byDay: Record<string, number> }
}

async function gatherStock(ctx: ActionCtx): Promise<StockMap> {
  type P = { id: string; name: string; active: boolean; deleted: boolean; preOrder: boolean }
  type V = { id: string; sku: string; productId: string; active: boolean; cost: number; price: number }
  type S = { variantId: string; locationId: string; available: number }
  const sellable: string[] = await ctx.runQuery(internal.targets.sellableLocations, {})
  const products: P[] = await pageAll<P>((cursor) => ctx.runQuery(internal.targets.productPage, { cursor }))
  const variants: V[] = await pageAll<V>((cursor) => ctx.runQuery(internal.targets.variantPage, { cursor }))
  const stockRows: S[] = await pageAll<S>((cursor) => ctx.runQuery(internal.targets.stockPage, { cursor }))
  const usable = new Set(sellable)
  const prod = new Map(products.map((p) => [p.id, p] as const))
  const unitsByVariant = new Map<string, number>()
  for (const s of stockRows) if (usable.has(s.locationId)) unitsByVariant.set(s.variantId, (unitsByVariant.get(s.variantId) ?? 0) + s.available)

  const out: StockMap = {}
  const costSum: Record<string, { sum: number; n: number }> = {}
  for (const x of variants) {
    if (!x.active) continue
    const p = prod.get(x.productId)
    if (!p || !p.active || p.deleted) continue
    const key = skuBase(x.sku)
    const entry = (out[key] ??= { name: p.name, units: 0, cost: null, price: 0, sizes: 0, sizesIn: 0 })
    entry.sizes++
    entry.price += x.price // summed here, averaged below
    if (!p.preOrder && !/^PO-/i.test(x.sku) && (unitsByVariant.get(x.id) ?? 0) > 0) entry.sizesIn++
    if (x.cost > 0) { const c = (costSum[key] ??= { sum: 0, n: 0 }); c.sum += x.cost; c.n++ }
    if (p.preOrder || /^PO-/i.test(x.sku)) entry.units = null
    else if (entry.units !== null) entry.units += Math.max(0, unitsByVariant.get(x.id) ?? 0)
  }
  for (const e of Object.values(out)) e.price = e.sizes > 0 ? e.price / e.sizes : 0
  for (const [k, c] of Object.entries(costSum)) out[k].cost = c.sum / c.n
  return out
}

async function gather(ctx: ActionCtx, month: string, now: number, current: string): Promise<Gathered> {
  const historic = month < current
  const mStart = monthStartMs(month), mEnd = monthEndMs(month)
  const from = historic ? mStart : Math.min(mStart, now - WINDOW_DAYS * DAY)
  const to = historic ? mEnd : now + 1
  const [rows, stock] = await Promise.all([salesRows(ctx, from, to), historic ? Promise.resolve(null) : gatherStock(ctx)])
  const s = summarizeSales(rows, { startMs: mStart, endMs: mEnd })
  return { at: now, byDay: s.byDay, trailing: s.trailing, mtd: s.mtd, ratio: s.ratio, stock }
}

/** Daily Meta ad spend (account level) between two instants; null when Meta returns an error. */
async function fetchSpend(conf: { token: string; accounts: { id: string }[] }, fromMs: number, toMs: number): Promise<Record<string, number> | null> {
  const range = encodeURIComponent(JSON.stringify({ since: dhakaDay(fromMs), until: dhakaDay(toMs) }))
  const byDay: Record<string, number> = {}
  for (const acc of conf.accounts) {
    const url = `https://graph.facebook.com/v21.0/act_${acc.id}/insights?level=account&time_increment=1&fields=spend&limit=100&time_range=${range}&access_token=${encodeURIComponent(conf.token)}`
    try {
      const json: any = await (await fetch(url)).json()
      if (json.error) return null
      for (const r of json.data ?? []) byDay[r.date_start] = (byDay[r.date_start] ?? 0) + Number(r.spend ?? 0)
    } catch { return null }
  }
  return byDay
}

const sumDays = (byDay: Record<string, number>, from: string, to: string) =>
  Object.entries(byDay).filter(([d]) => d >= from && d <= to).reduce((s, [, n]) => s + n, 0)

// ---------------------------------------------------------------------------------------------------------------
// Where the month stands
// ---------------------------------------------------------------------------------------------------------------

export type MarketingView = { state: "ok"; plan: MarketingPlan } | { state: "not_configured" } | { state: "error" }

export type TargetProgress = {
  month: string
  asOf: number
  /** null when no target is set for the month. */
  target: { amount: number; setByName: string } | null
  plan: MonthPlan | null
  /** Pairs per product: this month's plan, today's share and the stock behind it. Null when there is no plan. */
  products: ProductRow[] | null
  productInfo: { at: number; gap: number; unitsShort: number; windowDays: number } | null
  /** Budget vs spend. Null for people without ads access (they never see spend figures). */
  marketing: MarketingView | null
  /** Margin, break-even and profit. Only for people who may see salaries and ad spend, and only once costs are entered. */
  profit: ProfitPlan | null
}

const EMPTY = (month: string, now: number): TargetProgress => ({ month, asOf: now, target: null, plan: null, products: null, productInfo: null, marketing: null, profit: null })

/** Where the month stands against its target: totals, today's target, every product's plan, and budget vs spend.
 *  Shows the current month's target, or next month's when this month has none yet. */
export const progress = action({
  args: { month: v.optional(v.string()) },
  handler: async (ctx, { month }): Promise<TargetProgress> => {
    await ctx.runQuery(internal.targets.access, {})
    const now = Date.now()
    const current = dhakaMonth(now)
    if (month !== undefined && !isMonthKey(month)) throw new ConvexError("Pick a valid month.")

    let m = month ?? current
    let row = await ctx.runQuery(internal.targets.targetRow, { month: m })
    if (!row && month === undefined) {
      const next = await ctx.runQuery(internal.targets.targetRow, { month: nextMonthKey(current) })
      if (next) { row = next; m = next.month }
    }
    if (!row) return EMPTY(m, now)

    // Whether this person may see ad spend at all (the same permission as the Ads page).
    let conf: any = null
    let adsAllowed = true
    try { conf = await ctx.runQuery(internal.ads.cfg, {}) } catch { adsAllowed = false }
    const adsConfigured = adsAllowed && !!conf?.token && (conf.accounts?.length ?? 0) > 0
    const wantSpend = adsConfigured && m >= current

    // ---- gathered data (cached a few minutes, shared) ----
    const key = `target-data:${m}`
    const hit = await ctx.runQuery(internal.dashboard.readCache, { key })
    let data: Gathered | null = hit && (hit.value as Gathered).at && now - (hit.value as Gathered).at < CACHE_MS ? (hit.value as Gathered) : null
    let dirty = false
    if (!data) { data = await gather(ctx, m, now, current); dirty = true }
    let spendFailed = false
    if (wantSpend && (!data.spend || now - data.spend.at > SPEND_MS)) {
      const byDay = await fetchSpend(conf, Math.min(monthStartMs(current), now - 30 * DAY), now)
      if (byDay) { data.spend = { at: now, byDay }; dirty = true } else spendFailed = !data.spend
    }
    if (dirty) await ctx.runMutation(internal.dashboard.writeCache, { key, value: data })

    // ---- the month, by day ----
    const today = dhakaDay(now)
    const monthPlan = planMonth({ month: m, target: row.amount, deliveredByDay: data.byDay, today })

    // ---- the product plan ----
    let snapshot: ProductPlan | undefined
    let products: ProductRow[] | null = null
    let productInfo: TargetProgress["productInfo"] = null
    if (data.stock) {
      const stockMap = data.stock
      const soldMtd = Object.fromEntries(Object.entries(data.mtd).map(([k, d]) => [k, Object.values(d).reduce((s, n) => s + n, 0)]))
      const sizeInfo: Record<string, { inStock: number; total: number } | null> = {}
      const inputs: ProductInput[] = []
      const keys = new Set([...Object.keys(data.trailing), ...Object.keys(stockMap)])
      for (const k of keys) {
        const t = data.trailing[k]
        const st = stockMap[k]
        const sold = t && t.units > 0 && t.revenue > 0 ? t : null
        // Stock with no recent sales still gets a (small) share, so dead stock is worked on rather than ignored.
        if (!sold && !(st && st.units !== null && st.units > 0)) continue
        const price = sold ? (sold.revenue / sold.units) * data.ratio : st.price * data.ratio
        if (!(price > 0)) continue
        sizeInfo[k] = st && st.units !== null ? { inStock: st.sizesIn, total: st.sizes } : null
        inputs.push({
          key: k,
          name: st?.name ?? sold!.name,
          price,
          demandRevenue: sold ? sold.revenue : (st.units ?? 0) * price,
          stockUnits: st ? st.units : null, // no stock record: not capped
          group: classify({ stockUnits: st ? st.units : null, sizesIn: st?.sizesIn ?? 0, sizesTotal: st?.sizes ?? 0, soldUnits: sold?.units ?? 0 }),
        })
      }
      snapshot = row.plan as ProductPlan | undefined
      if (!snapshot || snapshot.v !== PLAN_VERSION || now - snapshot.at > REPLAN_MS) {
        snapshot = buildPlan({ at: now, revenueLeft: Math.max(0, row.amount - monthPlan.delivered), products: inputs, soldMtd })
        if (m === current) await ctx.runMutation(internal.targets.savePlan, { month: m, plan: snapshot })
      }
      const all = productRows({
        plan: snapshot, sold: data.mtd, today, daysLeft: monthPlan.daysLeft, started: monthPlan.started,
        stockUnits: Object.fromEntries(Object.entries(stockMap).map(([k, s]) => [k, s.units])),
        trailingUnits: Object.fromEntries(Object.entries(data.trailing).map(([k, t]) => [k, t.units])),
        trailingDays: WINDOW_DAYS,
        sizes: sizeInfo,
      })
      products = all
      productInfo = { at: snapshot.at, gap: snapshot.gap, unitsShort: all.reduce((s, r) => s + r.stockShort, 0), windowDays: WINDOW_DAYS }
    }

    // ---- marketing budget vs spend ----
    let marketing: MarketingView | null = null
    if (adsAllowed) {
      if (!adsConfigured) marketing = { state: "not_configured" }
      else if (m < current) marketing = null
      else if (!data.spend || spendFailed) marketing = { state: "error" }
      else {
        const from30 = dhakaDay(now - 30 * DAY)
        const monthFirst = `${m}-01`
        marketing = {
          state: "ok",
          plan: marketingPlan({
            target: row.amount,
            deliveredMtd: monthPlan.delivered,
            spentMtd: sumDays(data.spend.byDay, monthFirst, today),
            trailingRevenue: sumDays(data.byDay, from30, today),
            trailingSpend: sumDays(data.spend.byDay, from30, today),
            dayOfMonth: monthPlan.started ? (monthPlan.finished ? daysInMonth(m) : Number(today.slice(8, 10))) : 0,
            days: daysInMonth(m),
          }),
        }
      }
    }

    // ---- profit: shoe cost + ad budget + fixed costs against the target ----
    let profit: ProfitPlan | null = null
    if (marketing?.state === "ok" && marketing.plan.mer && data.stock && snapshot) {
      const costs = await ctx.runQuery(internal.targets.costsForProgress, {})
      if (costs && fixedTotal(costs) > 0) {
        const stockMap = data.stock
        const gm = mixMargin(Object.entries(snapshot.products).map(([k, p]) => ({ units: p.units, price: p.price / data.ratio, cost: stockMap[k]?.cost ?? null })))
        if (gm !== null) {
          profit = profitPlan({
            target: row.amount, grossMargin: gm, mer: marketing.plan.mer, costs,
            deliveredMtd: monthPlan.delivered, spentMtd: marketing.plan.spentMtd,
            dayOfMonth: monthPlan.started ? (monthPlan.finished ? daysInMonth(m) : Number(today.slice(8, 10))) : 0,
            days: daysInMonth(m),
          })
        }
      }
    }

    return { month: m, asOf: now, target: { amount: row.amount, setByName: row.setByName }, plan: monthPlan, products, productInfo, marketing, profit }
  },
})

// ---------------------------------------------------------------------------------------------------------------
// KPI: the Marketing lead earns points for hitting the target — automatically, off the same delivered revenue
// ---------------------------------------------------------------------------------------------------------------

const taka = (n: number) => `৳${Math.round(n).toLocaleString("en-IN")}`

async function deliveredByDayFor(ctx: ActionCtx, month: string) {
  const rows = await salesRows(ctx, monthStartMs(month), monthEndMs(month))
  return summarizeSales(rows, { startMs: monthStartMs(month), endMs: monthEndMs(month) }).byDay
}

/** Monday morning: was the week that just ended on pace for the month's target? (Straight-line share of the
 *  target by that Sunday.) Credits Marketing's lead, like the weekly ROAS rule. */
export const weeklyTargetCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const sunday = dhakaDay(Date.now() - DAY) // the cron runs Monday morning Dhaka time
    const month = sunday.slice(0, 7)
    const row = await ctx.runQuery(internal.targets.targetRow, { month })
    if (!row) return
    const delivered = sumDays(await deliveredByDayFor(ctx, month), `${month}-01`, sunday)
    const dayOfMonth = Number(sunday.slice(8, 10))
    if (!onPace({ target: row.amount, delivered, dayOfMonth, days: daysInMonth(month) })) return
    await ctx.runMutation(internal.targets.awardTargetPoints, {
      ruleKey: "marketing.target_week_pace",
      dedupeKey: sunday,
      label: `Week ending ${sunday}: delivered ${taka(delivered)}, on pace for the ${taka(row.amount)} target`,
    })
  },
})

/** Daily, but only acts in the first days of a month: did the month that just closed reach its target? */
export const monthTargetCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    if (Number(dhakaDay(now).slice(8, 10)) > 3) return
    const month = prevMonthKey(dhakaMonth(now))
    const row = await ctx.runQuery(internal.targets.targetRow, { month })
    if (!row) return
    const delivered = sumDays(await deliveredByDayFor(ctx, month), `${month}-01`, `${month}-31`)
    if (delivered < row.amount) return
    await ctx.runMutation(internal.targets.awardTargetPoints, {
      ruleKey: "marketing.target_month_hit",
      dedupeKey: month,
      label: `${month} target reached: delivered ${taka(delivered)} of ${taka(row.amount)}`,
    })
  },
})

export const awardTargetPoints = internalMutation({
  args: { ruleKey: v.union(v.literal("marketing.target_week_pace"), v.literal("marketing.target_month_hit")), label: v.string(), dedupeKey: v.string() },
  handler: async (ctx, { ruleKey, label, dedupeKey }) => {
    const lead = (await ownersConf(ctx)).byTeam["Marketing"]
    if (!lead?.name) return
    // No order behind this award, so dedupe on the period it's for (the Sunday / the month), not an orderId:
    // a cron that fires twice, or a month check that runs on three days, can only ever pay it once.
    const recent = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", lead.name).gte("at", Date.now() - 40 * DAY)).collect()
    if (recent.some((e) => e.ruleKey === ruleKey && e.label.includes(dedupeKey))) return
    await awardPoints(ctx, { staffName: lead.name, ruleKey, label })
  },
})
