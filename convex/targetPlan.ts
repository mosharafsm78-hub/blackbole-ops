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
/** c = courier cost paid on the parcel, f = payment (COD) fee — both from the order, 0 when not recorded. */
export type SaleRow = { at: number; total: number; items: SaleLine[]; c?: number; f?: number }

export type SalesSummary = {
  /** Delivered revenue (order totals) per Dhaka day. */
  byDay: Record<string, number>
  /** Everything delivered in the window, per product. */
  trailing: Record<string, { name: string; units: number; revenue: number }>
  /** Units delivered per product per Dhaka day, for the plan's month only. */
  mtd: Record<string, Record<string, number>>
  /** Order totals ÷ item-line revenue: delivery fees push it above 1, order-level discounts below. */
  ratio: number
  /** Average order total over the window (what one order brings in), 0 with no orders. */
  aov: number
  /** Real courier and payment costs on the delivered orders in the window. */
  ops: { orders: number; revenue: number; courierSum: number; courierN: number; codSum: number }
}

export function summarizeSales(rows: SaleRow[], month: { startMs: number; endMs: number }): SalesSummary {
  const byDay: Record<string, number> = {}
  const trailing: SalesSummary["trailing"] = {}
  const mtd: SalesSummary["mtd"] = {}
  let totals = 0, lines = 0
  const ops = { orders: rows.length, revenue: 0, courierSum: 0, courierN: 0, codSum: 0 }
  for (const r of rows) {
    const day = dhakaDay(r.at)
    byDay[day] = r2((byDay[day] ?? 0) + r.total)
    totals += r.total
    ops.revenue += r.total
    ops.codSum += r.f ?? 0
    if ((r.c ?? 0) > 0) { ops.courierSum += r.c!; ops.courierN++ }
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
  return { byDay, trailing, mtd, ratio, aov: rows.length > 0 ? totals / rows.length : 0, ops }
}

// ------------------------------------------------------------------------------------------------ allocation

/** focus = real stock and a proper size run (carries the pressure); other = thin stock; dead = broken size run or
 *  no sales (a small share, to clear it). */
export type Group = "focus" | "other" | "dead"
export const GROUP_SHARE: Record<Group, number> = { focus: 0.8, other: 0.12, dead: 0.08 }
export const FOCUS_MIN_STOCK = 10 // pairs
const MIN_SIZES = 3 // a product with fewer sizes than this has no size run to break (sizeless items)
const MIN_SIZE_COVER = 0.6 // share of its sizes that must be in stock

/** Which group a product belongs to. A product is "dead" when its size run is broken (sizes missing) or it has
 *  stock but no recent sales; "other" when the run is fine but the stock is thin; everything else is focus. */
export function classify(a: { stockUnits: number | null; sizesIn: number; sizesTotal: number; soldUnits: number }): Group {
  if (a.stockUnits === null) return "focus" // pre-order: nothing to clear, sells on demand
  const broken = a.sizesTotal >= MIN_SIZES && (a.sizesIn < MIN_SIZES || a.sizesIn / a.sizesTotal < MIN_SIZE_COVER)
  if (broken || a.soldUnits <= 0) return "dead"
  return a.stockUnits < FOCUS_MIN_STOCK ? "other" : "focus"
}

export type ProductInput = {
  group?: Group
  key: string
  name: string
  /** Revenue one pair brings in, order-total equivalent. */
  price: number
  /** Recent delivered revenue — the weight of this product. */
  demandRevenue: number
  /** Pairs available to sell; null = not capped (pre-order, or no stock record). */
  stockUnits: number | null
}

export type Allocation = { key: string; name: string; price: number; revenue: number; units: number; capped: boolean; group: Group }

/** Splits `revenue` across products by demand, never asking a product for more than its stock can carry. */
export function allocateRevenue(products: ProductInput[], revenue: number): { rows: Omit<Allocation, "group">[]; gap: number } {
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

  const rows: Omit<Allocation, "group">[] = []
  for (const p of products) {
    const revenueFor = alloc.get(p.key) ?? 0
    if (revenueFor <= 0) continue
    const want = Math.ceil(revenueFor / p.price)
    rows.push({ key: p.key, name: p.name, price: p.price, revenue: r2(revenueFor), units: p.stockUnits === null ? want : Math.min(p.stockUnits, want), capped: capped.has(p.key) })
  }
  return { rows, gap: left > 0.5 ? Math.round(left) : 0 }
}

/** How much weight stock gets next to sales when splitting a group's share. Half: sales say what customers buy,
 *  stock says what we are holding — a big pile (like the Veyron loafers) must be worked, not left because it sells slowly. */
export const STOCK_WEIGHT = 0.5

/** Weight = (1 − STOCK_WEIGHT) × share of sales + STOCK_WEIGHT × share of stock value, within the group. */
export function blendWeights(list: ProductInput[]): ProductInput[] {
  const stockValue = (p: ProductInput) => (p.stockUnits === null ? 0 : p.stockUnits * p.price)
  const demand = list.reduce((s, p) => s + Math.max(0, p.demandRevenue), 0)
  const stock = list.reduce((s, p) => s + stockValue(p), 0)
  if (demand <= 0 || stock <= 0) return list
  return list.map((p) => ({ ...p, demandRevenue: ((1 - STOCK_WEIGHT) * Math.max(0, p.demandRevenue)) / demand + (STOCK_WEIGHT * stockValue(p)) / stock }))
}

/** Splits `revenue` across the three groups (focus 80% / other 12% / dead 8%, renormalised over the groups that
 *  exist), then by demand inside each. What a small group can't carry in stock is handed back to focus. */
export function allocateGrouped(products: ProductInput[], revenue: number): { rows: Allocation[]; gap: number } {
  const g = (p: ProductInput): Group => p.group ?? "focus"
  const live = (["dead", "other", "focus"] as Group[]).filter((k) => products.some((p) => g(p) === k && p.demandRevenue > 0 && p.price > 0 && (p.stockUnits === null || p.stockUnits > 0)))
  const total = live.reduce((s, k) => s + GROUP_SHARE[k], 0)
  const rows: Allocation[] = []
  let left = Math.max(0, revenue)
  let gap = 0
  for (const k of live) { // small groups first; focus last takes whatever they couldn't
    const pool = k === "focus" ? left : (Math.max(0, revenue) * GROUP_SHARE[k]) / (live.includes("focus") ? 1 : total) // small groups keep their fixed share unless there is no focus group
    const res = allocateRevenue(blendWeights(products.filter((p) => g(p) === k)), pool)
    rows.push(...res.rows.map((r) => ({ ...r, group: k })))
    left -= pool - res.gap
    if (k === "focus") gap = res.gap
  }
  return { rows, gap }
}

export type PlanProduct = { name: string; units: number; price: number; group?: Group }

/** A person's manual say over one product in a plan — set, cleared independently of one another. Currently only
 *  wired up for Marketing's own plan (see targets.ts); the Cx delivered plan never reads these. */
export type ProductOverride = {
  name: string
  /** Forces this product into the plan even though it wouldn't otherwise qualify (no recent sales and no stock
   *  right now) — the "add a product" case. Has no effect once the product has real demand or stock of its own. */
  included?: boolean
  /** Drops this product from the plan entirely, whatever its sales or stock say — the "remove from the list" case.
   *  Takes priority over `included` and `units`. */
  excluded?: boolean
  /** A fixed month-total pairs target for this product, replacing its automatic share of the plan. */
  units?: number
}

export const PLAN_VERSION = 6 // bumped so today's already-cached plan rebuilds at once after dropping inactive/discontinued products from the plan
/** A plan is re-made at once when total sellable stock moves by this share or more (a stock count was corrected). */
export const STOCK_REPLAN_SHARE = 0.1
export const stockMoved = (before: number | undefined, now: number) => before === undefined || Math.abs(now - before) > Math.max(5, before * STOCK_REPLAN_SHARE)
export type ProductPlan = {
  /** Plan format; a saved plan of an older format is re-made. */
  v?: number
  /** Total sellable pairs when the plan was made — a big change (stock corrected) triggers a new plan. */
  stock?: number
  /** Fingerprint of the team's stock counts (lines counted : test pairs). Any change re-makes the plan. */
  check?: string
  at: number
  /** The part of the target still to deliver when this plan was made. */
  revenueLeft: number
  /** Revenue the current stock can't carry (0 when stock covers the target). */
  gap: number
  /** Month units per product: what was already sold when the plan was made + what is planned from here. */
  products: Record<string, PlanProduct>
}

export function buildPlan(args: { at: number; revenueLeft: number; products: ProductInput[]; soldMtd: Record<string, number>; check?: string }): ProductPlan {
  const stock = args.products.reduce((s, p) => s + (p.stockUnits ?? 0), 0)
  const { rows, gap } = allocateGrouped(args.products, args.revenueLeft)
  const out: Record<string, PlanProduct> = {}
  for (const r of rows) out[r.key] = { name: r.name, units: (args.soldMtd[r.key] ?? 0) + r.units, price: r.price, group: r.group }
  // Sold something this month but needs nothing more (e.g. out of stock): keep it, finished at what it sold.
  for (const p of args.products) {
    if (!out[p.key] && (args.soldMtd[p.key] ?? 0) > 0) out[p.key] = { name: p.name, units: args.soldMtd[p.key], price: p.price, group: p.group ?? "focus" }
  }
  return { v: PLAN_VERSION, stock, check: args.check, at: args.at, revenueLeft: Math.round(args.revenueLeft), gap, products: out }
}

// ------------------------------------------------------------------------------------------------ daily rows

export type ProductRow = {
  group: Group
  /** Sizes with stock / sizes the product comes in. Null for pre-order. */
  sizes: { inStock: number; total: number } | null
  key: string
  name: string
  /** Order-total-equivalent price: real average item price × ratio. Used for revenue-allocation math (today's
   *  target value, ad-budget split) — NOT the price customers actually see; use listedPrice for that. */
  price: number
  /** The real average listed/sale price for this product — what's on the product page, delivery fee not
   *  included (the delivery fee is the customer's own separate charge, not part of the shoe's price). This,
   *  together with cost below, is what a per-product suggested price is built from. */
  listedPrice: number
  /** Average purchase cost on file for this product; null until someone enters it. */
  cost: number | null
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
  /** Recent pairs sold per day (trailing window average) — the same number coverDays and restock suggestions are built from. */
  perDay: number
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
  sizes?: Record<string, { inStock: number; total: number } | null>
  costs?: Record<string, number | null>
  listedPrices?: Record<string, number>
}): ProductRow[] {
  const rows: ProductRow[] = []
  for (const [key, p] of Object.entries(args.plan.products)) {
    const byDay = args.sold[key] ?? {}
    const sold = Object.values(byDay).reduce((s, n) => s + n, 0)
    const todaySold = byDay[args.today] ?? 0
    const left = Math.max(0, p.units - sold)
    const atDayStart = Math.max(0, p.units - (sold - todaySold))
    // Before the month starts this is day 1's share (daysLeft is the whole month then).
    const todayTarget = args.daysLeft > 0 ? Math.ceil(atDayStart / args.daysLeft) : null
    const stock = args.stockUnits[key] ?? null
    const perDay = (args.trailingUnits[key] ?? 0) / Math.max(1, args.trailingDays)
    const coverDays = stock !== null && perDay > 0 ? Math.round(stock / perDay) : null
    rows.push({
      group: p.group ?? "focus", sizes: args.sizes?.[key] ?? null,
      key, name: p.name, price: p.price, listedPrice: args.listedPrices?.[key] ?? p.price, cost: args.costs?.[key] ?? null, monthUnits: p.units, sold, left,
      todayTarget, todaySold,
      toGo: todayTarget === null ? 0 : Math.max(0, todayTarget - todaySold),
      perDayAfterToday: args.daysLeft > 1 ? Math.ceil(left / (args.started ? args.daysLeft - 1 : args.daysLeft)) : 0,
      stockUnits: stock, coverDays, perDay,
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
  /** A fixed monthly ad budget set by the owner. When set, it replaces the worked-out budget and nothing above it is ever asked for. */
  budgetCap?: number | null
  /** Ad spend so far today (inside spentMtd) — the cap's daily share is worked out from what was spent BEFORE today. */
  spentToday?: number
}): MarketingPlan {
  const { target, deliveredMtd, spentMtd, trailingRevenue, trailingSpend, dayOfMonth, days } = args
  const cap = args.budgetCap && args.budgetCap > 0 ? Math.round(args.budgetCap) : null
  const capLeft = cap === null ? null : Math.max(0, cap - Math.round(spentMtd - (args.spentToday ?? 0)))
  const mer = trailingSpend > 0 && trailingRevenue > 0 ? trailingRevenue / trailingSpend : null
  const merMtd = spentMtd > 0 ? deliveredMtd / spentMtd : null
  if (mer === null) {
    if (cap === null) return { mer: null, budget: null, spentMtd: Math.round(spentMtd), remaining: null, expectedToDate: null, merMtd, neededForRest: null, status: "no_history" }
    return { mer: null, budget: cap, spentMtd: Math.round(spentMtd), remaining: cap - Math.round(spentMtd), expectedToDate: dayOfMonth > 0 ? Math.round((cap * dayOfMonth) / days) : 0, merMtd, neededForRest: capLeft, status: "on_track" }
  }

  const budget = cap ?? Math.ceil(target / mer)
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
    neededForRest: capLeft === null ? Math.max(0, Math.ceil((target - deliveredMtd) / mer)) : Math.min(capLeft, Math.max(0, Math.ceil((target - deliveredMtd) / mer))),
    status,
  }
}

/** Is the month's delivered revenue at least its straight-line share of the target by `dayOfMonth`? */
export const onPace = (args: { target: number; delivered: number; dayOfMonth: number; days: number }) =>
  args.delivered >= (args.target * args.dayOfMonth) / args.days

// ------------------------------------------------------------------------------------------------ profit

export type MonthlyCosts = {
  salary: number; rent: number; other: number
  /** Courier cost per order (৳). */
  delivery?: number
  /** Packaging cost per order (৳). */
  packaging?: number
  /** Payment-gateway fee, % of revenue. */
  payFeePct?: number
  /** Share of shipped orders that come back (%). Their delivery and packaging are paid but earn nothing. */
  returnPct?: number
}
export const DEFAULT_COSTS = { delivery: 120, packaging: 57, payFeePct: 2.5, returnPct: 30 }
export const fixedTotal = (c: MonthlyCosts) => Math.max(0, c.salary) + Math.max(0, c.rent) + Math.max(0, c.other)

/** Revenue-weighted gross margin (0–1) of the planned mix: Σ units×(price−cost) ÷ Σ units×price. Products with
 *  no known purchase price are left out of both sides, so they neither help nor hurt the figure. Null if none. */
export function mixMargin(lines: { units: number; price: number; cost: number | null }[]): number | null {
  let rev = 0, gp = 0
  for (const l of lines) {
    if (l.cost === null || l.units <= 0 || l.price <= 0) continue
    rev += l.units * l.price
    gp += l.units * (l.price - l.cost)
  }
  return rev > 0 ? gp / rev : null
}

export type ProfitPlan = {
  /** Share of product revenue left after the shoes' purchase cost (planned product mix, item price basis). */
  grossMargin: number
  /** The same margin, re-based onto ৳1 of order-total revenue — what's actually subtracted below. Differs from
   *  grossMargin whenever discounts or the delivery fee make the order total diverge from the item-line price
   *  (ratio ≠ 1): a discount shrinks it, a collected delivery fee (pure margin once courier cost is counted
   *  separately below) grows it. This is the number the breakdown shown to the team should foot against. */
  grossRate: number
  /** Order totals ÷ item-line revenue — >1 when the collected delivery fee outweighs discounts given, <1 the
   *  other way. The conversion factor between grossMargin (item basis) and grossRate (order-total basis); a
   *  per-product suggested price needs to go the other way, from a required order-total rate back to a required
   *  item-price margin, and this is what that conversion needs. */
  ratio: number
  /** Per ৳1 of revenue: delivery + packaging (per order, ÷ average order), and the payment fee. */
  orderCostRate: number
  payFeeRate: number
  returnRate: number
  aov: number
  /** Ad spend per taka of revenue at the 30-day efficiency (1 ÷ MER). */
  adRate: number
  /** What each taka of revenue contributes toward fixed costs: gross margin − ad rate. */
  contribution: number
  fixed: number
  /** Monthly revenue at which profit is zero; null when ads eat the whole margin (never breaks even). */
  breakEven: number | null
  /** Profit at the month's target, after shoe cost, the ad budget and fixed costs. */
  profitAtTarget: number
  /** Profit so far this month: delivered × margin − ad spend − fixed costs for the days gone. */
  profitMtd: number
  /** Target as a multiple of break-even (>1 means the target makes money). */
  coverage: number | null
}

export function profitPlan(args: {
  target: number
  grossMargin: number
  /** Order totals ÷ item-line revenue (delivery fees collected push it above 1). */
  ratio?: number
  /** Average order total. */
  aov?: number
  mer: number
  costs: MonthlyCosts
  deliveredMtd: number
  spentMtd: number
  dayOfMonth: number
  days: number
}): ProfitPlan {
  const fixed = fixedTotal(args.costs)
  const adRate = 1 / args.mer
  // Revenue is the order total. Of each ৳1, 1/ratio is shoes (earning the margin) and the rest is delivery fee
  // the customer paid, which is income against the courier. Per-order costs are spread over the average order.
  const ratio = args.ratio && args.ratio > 0 ? args.ratio : 1
  const grossRate = args.grossMargin / ratio + 1 - 1 / ratio
  const aov = args.aov && args.aov > 0 ? args.aov : 0
  // Returns: revenue counts delivered orders only, but delivery and packaging are paid on every order shipped.
  // With 30% coming back, each delivered order stands for 1 / 0.7 shipped ones.
  const returnRate = Math.min(0.9, Math.max(0, (args.costs.returnPct ?? 0) / 100))
  const orderCostRate = aov > 0 ? (Math.max(0, args.costs.delivery ?? 0) + Math.max(0, args.costs.packaging ?? 0)) / (aov * (1 - returnRate)) : 0
  const payFeeRate = Math.max(0, args.costs.payFeePct ?? 0) / 100
  const beforeAds = grossRate - orderCostRate - payFeeRate
  const contribution = beforeAds - adRate
  const breakEven = contribution > 0 ? Math.ceil(fixed / contribution) : null
  return {
    grossMargin: Math.round(args.grossMargin * 1000) / 1000,
    grossRate: Math.round(grossRate * 1000) / 1000,
    ratio: Math.round(ratio * 1000) / 1000,
    orderCostRate: Math.round(orderCostRate * 1000) / 1000,
    payFeeRate: Math.round(payFeeRate * 1000) / 1000,
    returnRate,
    aov: Math.round(aov),
    adRate: Math.round(adRate * 1000) / 1000,
    contribution: Math.round(contribution * 1000) / 1000,
    fixed,
    breakEven,
    profitAtTarget: Math.round(args.target * contribution - fixed),
    profitMtd: Math.round(args.deliveredMtd * beforeAds - args.spentMtd - (fixed * args.dayOfMonth) / args.days),
    coverage: breakEven ? Math.round((args.target / breakEven) * 100) / 100 : null,
  }
}


// ------------------------------------------------------------------------------------------------ measured costs

export type MeasuredCosts = { returnPct: number; delivery: number; payFeePct: number; sample: number }
export const MIN_SAMPLE = 30 // orders needed before measured numbers replace the typed ones

/** Return rate, courier cost per order and payment fee, measured from real orders. Null with too few orders. */
export function measureCosts(a: {
  delivered: { orders: number; revenue: number; courierSum: number; courierN: number; codSum: number }
  returned: { orders: number; courierSum: number; courierN: number }
}): MeasuredCosts | null {
  const sample = a.delivered.orders + a.returned.orders
  if (sample < MIN_SAMPLE) return null
  const courierN = a.delivered.courierN + a.returned.courierN
  return {
    returnPct: Math.round((a.returned.orders / sample) * 1000) / 10,
    delivery: courierN > 0 ? Math.round((a.delivered.courierSum + a.returned.courierSum) / courierN) : 0,
    payFeePct: a.delivered.revenue > 0 ? Math.round((a.delivered.codSum / a.delivered.revenue) * 1000) / 10 : 0,
    sample,
  }
}

// ------------------------------------------------------------------------------------------------ daily marketing

export type DailyPlan = {
  /** Orders that must be delivered to hit the day's target, and booked to allow for returns. */
  ordersToDeliver: number
  ordersToBook: number
  /** Share of shipped orders expected to come back (0–1). */
  returnRate: number
  /** Ad spend that reaches the target at the 30-day efficiency (capped at the maximum). */
  adBudget: number
  /** Most that can be spent on the day's revenue before every extra taka loses money (before fixed costs). */
  adMax: number
  spentToday: number
  /** Budget still to spend today; negative when over. */
  adLeft: number
  /** True when the efficiency needed is better than ads can actually deliver. */
  adsCantPay: boolean
}

export function dailyPlan(a: { dayTarget: number; mer: number; profit: ProfitPlan; spentToday: number }): DailyPlan {
  const p = a.profit
  const beforeAds = p.contribution + p.adRate // margin left after shoes, delivery, packaging and fees
  const adMax = Math.max(0, Math.floor(a.dayTarget * beforeAds))
  const wanted = Math.ceil(a.dayTarget / a.mer)
  const adBudget = Math.min(wanted, adMax)
  const ordersToDeliver = p.aov > 0 ? Math.ceil(a.dayTarget / p.aov) : 0
  return {
    ordersToDeliver,
    ordersToBook: Math.ceil(ordersToDeliver / (1 - p.returnRate)),
    returnRate: p.returnRate,
    adBudget, adMax,
    spentToday: Math.round(a.spentToday),
    adLeft: adBudget - Math.round(a.spentToday),
    adsCantPay: wanted > adMax,
  }
}

/** Model name without its colour/variant: "BlackBole Veyron Casual Loafer - Olive" → "BlackBole Veyron Casual Loafer". */
export const familyOf = (name: string) => name.split(" - ")[0].trim()

/** A target for a period with none set: 15% above the last 30 days' delivered revenue, never above what sellable
 *  stock could bring in, rounded to the nearest ৳10,000. Null with no sales to base it on. */
export function suggestTarget(a: { trailing30Revenue: number; stockCapacity: number }): number | null {
  if (!(a.trailing30Revenue > 0)) return null
  const wanted = a.trailing30Revenue * 1.15
  const capped = a.stockCapacity > 0 ? Math.min(wanted, a.stockCapacity) : wanted
  const rounded = Math.round(capped / 10000 + 1e-9) * 10000 // epsilon: 100000 × 1.15 is 114999.999… in floating point
  return rounded > 0 ? rounded : null
}

// ------------------------------------------------------------------------------------------------ test products → buy

export const BUY_MIN_ORDERED_7D = 5 // orders (pairs) in a week before demand counts as proven
export const BUY_COVER_WEEKS = 3 // buy enough for this many weeks at the current pace

/** For a product with test (fake) stock: has demand been proven, and if so how many pairs should be bought?
 *  The pairs already sold on test stock are owed to customers, so they are bought first; real pairs in hand count. */
export function buySuggestion(a: { ordered7: number; real: number }): { proven: boolean; buy: number } {
  if (a.ordered7 < BUY_MIN_ORDERED_7D) return { proven: false, buy: 0 }
  return { proven: true, buy: Math.max(0, Math.ceil(a.ordered7 * BUY_COVER_WEEKS) - Math.max(0, a.real)) }
}

// ------------------------------------------------------------------------------------------------ restock suggestions

/** A product is flagged once it's projected to run out within this many days at its recent pace. */
export const RESTOCK_HORIZON_DAYS = 7
/** A suggested buy covers this many days of recent demand once it lands, on top of whatever is already in hand. */
export const RESTOCK_TARGET_DAYS = 21

export type SizeStock = { variantId: string; sku: string; title: string; units: number; cost: number }

export type RestockSuggestion = {
  key: string
  name: string
  coverDays: number | null
  perDay: number
  totalStock: number
  suggestedTotal: number
  /** Why this made the list: thin on stock overall, and/or some sizes are out while others carry plenty. */
  reasons: ("running_low" | "missing_sizes")[]
  sizes: (SizeStock & { suggest: number })[]
  /** How much of what sold actually reached the customer, over the same trailing window as `perDay` — delivered
   *  ÷ (delivered + returned) parcels, 0–100. Null with no delivered-or-returned history yet to judge by: a
   *  pre-order category (no parcel ever ships against the category key itself) or a brand-new product. A low
   *  number here is a reason to restock less even when the pace alone says "running low". */
  deliveryRate: number | null
  delivered: number
  returned: number
}

/** Splits `total` across `weights` so the pieces are whole numbers that add up to exactly `total` — the largest
 *  weights get first claim on the rounding (largest-remainder method), rather than every size losing a fraction
 *  to Math.round and the total quietly drifting off. */
function allocateByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (total <= 0 || sum <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (w / sum) * total)
  const out = raw.map(Math.floor)
  let remainder = total - out.reduce((s, f) => s + f, 0)
  const byFraction = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (let i = 0; i < remainder; i++) out[byFraction[i][1]]++
  return out
}

/** What to buy, and in which sizes, before a product either runs out or keeps losing size-seeking customers.
 *  Two independent reasons put a product on this list: (1) at its recent pace, total stock runs out within
 *  `horizonDays`, or (2) some sizes are already at zero while a sibling size of the same product still has
 *  plenty — a broken size run quietly loses the customers who wanted exactly that size, even while the
 *  product's overall stock looks fine. The suggested total covers `targetDays` of recent demand, or enough to
 *  bring every size up to its best-stocked sibling, whichever is larger; it's then split across sizes weighted
 *  by how far each one is behind that sibling, so the sizes actually missing get the restock first. */
export function restockSuggestions(args: {
  rows: ProductRow[]
  sizesByKey: Record<string, SizeStock[]>
  /** Delivered vs returned parcel counts per product, over the same trailing window used for `perDay` — see
   *  `RestockSuggestion.deliveryRate`. Omitted keys get a null rate (nothing to judge by yet). */
  deliveryByKey?: Record<string, { delivered: number; returned: number }>
  horizonDays?: number
  targetDays?: number
}): RestockSuggestion[] {
  const horizon = args.horizonDays ?? RESTOCK_HORIZON_DAYS
  const target = args.targetDays ?? RESTOCK_TARGET_DAYS
  const out: RestockSuggestion[] = []
  for (const r of args.rows) {
    if (r.group === "dead") continue // no proven demand — don't suggest spending more on it
    const sizes = args.sizesByKey[r.key]
    if (!sizes || sizes.length === 0) continue // pre-order, or no catalog SKU left to buy against
    const totalStock = sizes.reduce((s, x) => s + x.units, 0)
    const maxSize = Math.max(0, ...sizes.map((x) => x.units))
    const missingSizes = maxSize > 0 && sizes.some((x) => x.units <= 0)
    const runningLow = r.coverDays !== null && r.coverDays <= horizon
    if (!runningLow && !missingSizes) continue
    const velocityTotal = Math.max(0, Math.ceil(r.perDay * target) - totalStock)
    const levelTotal = sizes.reduce((s, x) => s + Math.max(0, maxSize - x.units), 0)
    const suggestedTotal = Math.max(velocityTotal, levelTotal)
    if (suggestedTotal <= 0) continue
    const gaps = sizes.map((x) => Math.max(0, maxSize - x.units))
    const weights = gaps.some((g) => g > 0) ? gaps : sizes.map(() => 1) // even curve but still thin overall: split evenly
    const alloc = allocateByWeight(suggestedTotal, weights)
    const d = args.deliveryByKey?.[r.key]
    const judged = (d?.delivered ?? 0) + (d?.returned ?? 0)
    out.push({
      key: r.key, name: r.name, coverDays: r.coverDays, perDay: r2(r.perDay), totalStock, suggestedTotal,
      reasons: [...(runningLow ? (["running_low"] as const) : []), ...(missingSizes ? (["missing_sizes"] as const) : [])],
      sizes: sizes.map((x, i) => ({ ...x, suggest: alloc[i] })),
      deliveryRate: judged > 0 ? Math.round((d!.delivered / judged) * 1000) / 10 : null,
      delivered: d?.delivered ?? 0, returned: d?.returned ?? 0,
    })
  }
  return out.sort((a, b) => (a.coverDays ?? Infinity) - (b.coverDays ?? Infinity))
}
