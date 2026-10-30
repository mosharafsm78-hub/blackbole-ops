// Product-level planning for the company revenue target — pure maths, no database, so it can be tested alone.
//
// How the monthly target becomes "sell this many pairs of this model":
//   1. DEMAND decides the split. Each product's share of the target follows its share of recent delivered
//      revenue (the last 60 days) — the products customers actually buy carry the most of the target.
//   2. SUPPLY caps it. A product can't be asked to sell more pairs than are in stock (pre-order products,
//      which arrive on demand, are not capped). What a capped product can't carry is moved to the products that
//      still have stock, in proportion to their demand; if the whole range can't carry the target, the missing
//      amount is reported as a stock gap instead of being hidden inside bigger numbers.
//   3. The plan is fixed per product for the month (re-planned weekly from the then-remaining target, keeping
//      what each product has already sold), so a miss is visible and carries on that same product: if 5 pairs
//      were due today and 2 sold, the 3 missing are spread over the days left on top of tomorrow's share.
//   4. The MARKETING budget is not a number someone types in. It's the month's target divided by the revenue
//      the shop actually earned per taka of ad spend over the last 30 days (marketing efficiency ratio), and is
//      then compared with what has really been spent.
//
// These are the same ideas big retailers use — demand-led, supply-constrained planning (S&OP), Pareto/ABC
// ranking of products, days of stock cover, and a blended efficiency ratio for marketing — kept simple enough
// to be explained on one screen.
import { dhakaDay } from "./targetMath"

/** Product key from a variant SKU: "BB-HSS-41" → "BB-HSS" (drops the size). Orders and stock both use it. */
export const skuBase = (sku: string) => sku.split("-").slice(0, -1).join("-") || sku

const r2 = (n: number) => Math.round(n * 100) / 100

// ------------------------------------------------------------------------------------------------ sales history

export type SaleLine = { k: string; n: string; q: number; a: number }
export type SaleRow = { at: number; total: number; items: SaleLine[] }

export type SalesSummary = {
  /** Delivered revenue (order totals) per Dhaka day. */
  byDay: Record<string, number>
  /** Everything delivered in the window, per product. */
  trailing: Record<string, { name: string; units: number; revenue: number }>
  /** Units delivered per product per Dhaka day, for the plan's month only. */
  mtd: Record<string, Record<string, number>>
  /** Order totals ÷ item-line revenue: delivery fees push it above 1, order-level discounts below. */
  ratio: number
}

export function summarizeSales(rows: SaleRow[], month: { startMs: number; endMs: number }): SalesSummary {
  const byDay: Record<string, number> = {}
  const trailing: SalesSummary["trailing"] = {}
  const mtd: SalesSummary["mtd"] = {}
  let totals = 0, lines = 0
  for (const r of rows) {
    const day = dhakaDay(r.at)
    byDay[day] = r2((byDay[day] ?? 0) + r.total)
    totals += r.total
    const inMonth = r.at >= month.startMs && r.at < month.endMs
    for (const it of r.items) {
      lines += it.a
      const t = (trailing[it.k] ??= { name: it.n, units: 0, revenue: 0 })
      t.units += it.q; t.revenue += it.a
      if (inMonth) {
        const m = (mtd[it.k] ??= {})
        m[day] = (m[day] ?? 0) + it.q
      }
    }
  }
  const ratio = lines > 0 ? Math.min(1.5, Math.max(0.5, totals / lines)) : 1
  return { byDay, trailing, mtd, ratio }
}

// ------------------------------------------------------------------------------------------------ allocation

export type ProductInput = {
  key: string
  name: string
  /** Revenue one pair brings in, order-total equivalent. */
  price: number
  /** Recent delivered revenue — the weight of this product. */
  demandRevenue: number
  /** Pairs available to sell; null = not capped (pre-order, or no stock record). */
  stockUnits: number | null
}

export type Allocation = { key: string; name: string; price: number; revenue: number; units: number; capped: boolean }

/** Splits `revenue` across products by demand, never asking a product for more than its stock can carry. */
export function allocateRevenue(products: ProductInput[], revenue: number): { rows: Allocation[]; gap: number } {
  let open = products.filter((p) => p.demandRevenue > 0 && p.price > 0 && (p.stockUnits === null || p.stockUnits > 0))
  const alloc = new Map<string, number>()
  const capped = new Set<string>()
  let left = Math.max(0, revenue)

  while (left > 0.5 && open.length > 0) {
    const w = open.reduce((s, p) => s + p.demandRevenue, 0)
    const room = (p: ProductInput) => (p.stockUnits === null ? Infinity : p.stockUnits * p.price - (alloc.get(p.key) ?? 0))
    const hitCap = open.filter((p) => (left * p.demandRevenue) / w >= room(p))
    if (hitCap.length === 0) {
      for (const p of open) alloc.set(p.key, (alloc.get(p.key) ?? 0) + (left * p.demandRevenue) / w)
      left = 0
      break
    }
    for (const p of hitCap) {
      const r = room(p)
      alloc.set(p.key, (alloc.get(p.key) ?? 0) + r)
      left -= r
      capped.add(p.key)
    }
    open = open.filter((p) => !hitCap.includes(p))
  }

  const rows: Allocation[] = []
  for (const p of products) {
    const revenueFor = alloc.get(p.key) ?? 0
    if (revenueFor <= 0) continue
    const want = Math.ceil(revenueFor / p.price)
    rows.push({ key: p.key, name: p.name, price: p.price, revenue: r2(revenueFor), units: p.stockUnits === null ? want : Math.min(p.stockUnits, want), capped: capped.has(p.key) })
  }
  return { rows, gap: left > 0.5 ? Math.round(left) : 0 }
}

export type PlanProduct = { name: string; units: number; price: number }
export type ProductPlan = {
  at: number
  /** The part of the target still to deliver when this plan was made. */
  revenueLeft: number
  /** Revenue the current stock can't carry (0 when stock covers the target). */
  gap: number
  /** Month units per product: what was already sold when the plan was made + what is planned from here. */
  products: Record<string, PlanProduct>
}

export function buildPlan(args: { at: number; revenueLeft: number; products: ProductInput[]; soldMtd: Record<string, number> }): ProductPlan {
  const { rows, gap } = allocateRevenue(args.products, args.revenueLeft)
  const out: Record<string, PlanProduct> = {}
  for (const r of rows) out[r.key] = { name: r.name, units: (args.soldMtd[r.key] ?? 0) + r.units, price: r.price }
  // Sold something this month but needs nothing more (e.g. out of stock): keep it, finished at what it sold.
  for (const p of args.products) {
    if (!out[p.key] && (args.soldMtd[p.key] ?? 0) > 0) out[p.key] = { name: p.name, units: args.soldMtd[p.key], price: p.price }
  }
  return { at: args.at, revenueLeft: Math.round(args.revenueLeft), gap, products: out }
}

// ------------------------------------------------------------------------------------------------ daily rows

export type ProductRow = {
  key: string
  name: string
  price: number
  monthUnits: number
  sold: number
  left: number
  /** Pairs due today, worked out from what was still missing when today began. Null before the month starts. */
  todayTarget: number | null
  todaySold: number
  toGo: number
  /** Pairs per day needed on each day AFTER today to still finish the plan. */
  perDayAfterToday: number
  stockUnits: number | null
  coverDays: number | null
  /** Pairs of what's still planned that current stock cannot cover. */
  stockShort: number
  /** Piling up unsold (90+ days of cover) — a candidate for a marketing push. */
  overstock: boolean
}

export function productRows(args: {
  plan: ProductPlan
  sold: Record<string, Record<string, number>>
  today: string
  daysLeft: number
  started: boolean
  stockUnits: Record<string, number | null>
  trailingUnits: Record<string, number>
  trailingDays: number
}): ProductRow[] {
  const rows: ProductRow[] = []
  for (const [key, p] of Object.entries(args.plan.products)) {
    const byDay = args.sold[key] ?? {}
    const sold = Object.values(byDay).reduce((s, n) => s + n, 0)
    const todaySold = byDay[args.today] ?? 0
    const left = Math.max(0, p.units - sold)
    const atDayStart = Math.max(0, p.units - (sold - todaySold))
    const todayTarget = args.started && args.daysLeft > 0 ? Math.ceil(atDayStart / args.daysLeft) : null
    const stock = args.stockUnits[key] ?? null
    const perDay = (args.trailingUnits[key] ?? 0) / Math.max(1, args.trailingDays)
    const coverDays = stock !== null && perDay > 0 ? Math.round(stock / perDay) : null
    rows.push({
      key, name: p.name, price: p.price, monthUnits: p.units, sold, left,
      todayTarget, todaySold,
      toGo: todayTarget === null ? 0 : Math.max(0, todayTarget - todaySold),
      perDayAfterToday: args.started && args.daysLeft > 1 ? Math.ceil(left / (args.daysLeft - 1)) : 0,
      stockUnits: stock, coverDays,
      stockShort: stock === null ? 0 : Math.max(0, left - stock),
      overstock: coverDays !== null && coverDays > 90,
    })
  }
  return rows.sort((a, b) => b.monthUnits - a.monthUnits || a.name.localeCompare(b.name))
}

// ------------------------------------------------------------------------------------------------ marketing

export type MarketingStatus = "no_history" | "on_track" | "overspending" | "underspending"

/** Delivery lags the ad, so spend-vs-revenue is only judged from this day of the month on. */
export const MIN_DAYS_TO_JUDGE = 4

export type MarketingPlan = {
  /** Revenue earned per taka of ad spend over the last 30 days (marketing efficiency ratio). */
  mer: number | null
  /** What the month needs to spend to reach the target at that efficiency. */
  budget: number | null
  spentMtd: number
  remaining: number | null
  /** Share of the budget that should be spent by now if spend follows the calendar. */
  expectedToDate: number | null
  /** Revenue per taka of spend so far this month. */
  merMtd: number | null
  /** Spend still needed to deliver the part of the target that's missing, at the 30-day efficiency. */
  neededForRest: number | null
  status: MarketingStatus
}

export function marketingPlan(args: {
  target: number
  deliveredMtd: number
  spentMtd: number
  trailingRevenue: number
  trailingSpend: number
  dayOfMonth: number
  days: number
}): MarketingPlan {
  const { target, deliveredMtd, spentMtd, trailingRevenue, trailingSpend, dayOfMonth, days } = args
  const mer = trailingSpend > 0 && trailingRevenue > 0 ? trailingRevenue / trailingSpend : null
  const merMtd = spentMtd > 0 ? deliveredMtd / spentMtd : null
  if (mer === null) return { mer: null, budget: null, spentMtd: Math.round(spentMtd), remaining: null, expectedToDate: null, merMtd, neededForRest: null, status: "no_history" }

  const budget = Math.ceil(target / mer)
  const expectedToDate = dayOfMonth > 0 ? Math.round((budget * dayOfMonth) / days) : 0
  const paceRevenue = (target * dayOfMonth) / days
  // Orders reach "delivered" days after the ad that brought them, so the first days of a month say nothing
  // about whether spend and revenue are in step — don't judge until there's a few days of deliveries.
  const judge = dayOfMonth >= MIN_DAYS_TO_JUDGE
  const behind = judge && deliveredMtd < paceRevenue
  let status: MarketingStatus = "on_track"
  if (behind && spentMtd > expectedToDate * 1.15) status = "overspending" // paying for ads but revenue isn't following
  else if (behind && spentMtd < expectedToDate * 0.85) status = "underspending" // revenue is behind and so is the spend
  return {
    mer: Math.round(mer * 100) / 100,
    budget,
    spentMtd: Math.round(spentMtd),
    remaining: budget - Math.round(spentMtd),
    expectedToDate,
    merMtd: merMtd === null ? null : Math.round(merMtd * 100) / 100,
    neededForRest: Math.max(0, Math.ceil((target - deliveredMtd) / mer)),
    status,
  }
}

/** Is the month's delivered revenue at least its straight-line share of the target by `dayOfMonth`? */
export const onPace = (args: { target: number; delivered: number; dayOfMonth: number; days: number }) =>
  args.delivered >= (args.target * args.dayOfMonth) / args.days
