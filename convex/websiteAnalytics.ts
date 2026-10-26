// Website → Home and Website → Analytics: Shopify-style sales numbers for the brand's own website.
//
// How it stays fast and inside Convex limits:
//  - Each Bangladesh day is added up once from that day's orders (orders.by_created, one day per read) into a small
//    summary row kept in the shared `cache` table (key "webDay:YYYY-MM-DD").
//  - A report for 90 days reads 90 small rows instead of thousands of orders. Rows are worked out again when they get old:
//    today/yesterday after 5 minutes, the last 2 weeks after 1 hour, older days after 12 hours (late returns/cancels).
//  - Abandoned checkouts come from `checkouts` (by_status + shopUpdatedAt range), never a full table read.
// Only what Ops has is shown: website visits/sessions are tracked by Meta, not stored here.
import { v } from "convex/values"
import { action, internalMutation, internalQuery } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"
import { ABANDON_AFTER } from "./checkouts"

export const WEB_SOURCE = "Website"
const BD = 6 * 3600000 // Asia/Dhaka
const DAY = 86400000
const MAX_DAYS = 366
const RETURNED = ["pending_returned", "returned", "damaged"]
const r2 = (n: number) => Math.round(n * 100) / 100

export const bdDay = (t: number) => new Date(t + BD).toISOString().slice(0, 10)
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - BD
const bdHour = (t: number) => new Date(t + BD).getUTCHours()
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

// ---------------------------------------------------------------- one day, added up
/** Summary of one Bangladesh day (all short keys: it is stored once per day). */
export type DayAgg = {
  day: string
  /** every Ops order that day (not cancelled), by source: n orders, v order totals */
  ch: { s: string; n: number; v: number }[]
  /** website orders: n (not cancelled), gross item sales, discounts, returns (net value of returned orders), shipping, totals, units, cancelled count */
  w: { n: number; gross: number; disc: number; ret: number; retN: number; ship: number; tot: number; units: number; canc: number }
  /** website sales per hour (0–23, Bangladesh time) and orders per hour */
  hs: number[]; hn: number[]
  /** website products: key (sku), name, units, net sales */
  it: { k: string; name: string; q: number; v: number }[]
  /** discount codes on website orders: code, orders, total sales, discount given */
  dc: { c: string; n: number; v: number; d: number }[]
  /** website customers: [customerId, 1 when they had ordered before (any channel)] */
  cu: [string, 0 | 1][]
}

type OrderLite = Pick<Doc<"orders">, "status" | "source" | "items" | "discount" | "deliveryFee" | "total" | "createdAt" | "customerId" | "discountCode" | "deletedAt">

/** Add up one day's orders. `returning` says which website customers had ordered before. */
export function aggregateDay(day: string, orders: OrderLite[], returning: Set<string>): DayAgg {
  const out: DayAgg = {
    day, ch: [], w: { n: 0, gross: 0, disc: 0, ret: 0, retN: 0, ship: 0, tot: 0, units: 0, canc: 0 },
    hs: Array(24).fill(0), hn: Array(24).fill(0), it: [], dc: [], cu: [],
  }
  const ch = new Map<string, { s: string; n: number; v: number }>()
  const it = new Map<string, { k: string; name: string; q: number; v: number }>()
  const dc = new Map<string, { c: string; n: number; v: number; d: number }>()
  const cu = new Map<string, 0 | 1>()
  for (const o of orders) {
    if (o.deletedAt) continue
    const web = o.source === WEB_SOURCE
    if (o.status === "cancelled") { if (web) out.w.canc++; continue }
    const c = ch.get(o.source) ?? { s: o.source, n: 0, v: 0 }
    c.n++; c.v = r2(c.v + o.total); ch.set(o.source, c)
    if (!web) continue
    const gross = o.items.reduce((t, i) => t + i.price * i.qty, 0)
    const itemDisc = o.items.reduce((t, i) => t + i.discount, 0)
    const disc = itemDisc + o.discount
    const units = o.items.reduce((t, i) => t + i.qty, 0)
    const w = out.w
    w.n++; w.gross = r2(w.gross + gross); w.disc = r2(w.disc + disc); w.ship = r2(w.ship + o.deliveryFee); w.tot = r2(w.tot + o.total); w.units += units
    if (RETURNED.includes(o.status)) { w.retN++; w.ret = r2(w.ret + gross - disc) }
    const h = bdHour(o.createdAt)
    out.hs[h] = r2(out.hs[h] + o.total); out.hn[h]++
    for (const i of o.items) {
      const x = it.get(i.sku) ?? { k: i.sku, name: i.name, q: 0, v: 0 }
      x.q += i.qty; x.v = r2(x.v + i.price * i.qty - i.discount); x.name = i.name
      it.set(i.sku, x)
    }
    if (o.discountCode) {
      const x = dc.get(o.discountCode) ?? { c: o.discountCode, n: 0, v: 0, d: 0 }
      x.n++; x.v = r2(x.v + o.total); x.d = r2(x.d + disc)
      dc.set(o.discountCode, x)
    }
    const id = String(o.customerId)
    cu.set(id, cu.get(id) === 1 || returning.has(id) ? 1 : 0)
  }
  out.ch = [...ch.values()]
  out.it = [...it.values()]
  out.dc = [...dc.values()]
  out.cu = [...cu.entries()]
  return out
}

// ---------------------------------------------------------------- many days → report
export type Summary = {
  orders: number; gross: number; discounts: number; returns: number; returnedOrders: number; net: number; shipping: number; total: number
  aov: number; units: number; cancelled: number; customers: number; returning: number; returningRate: number | null
}

/** Totals for a set of days (Shopify meanings: net = gross − discounts − returns; total = net + shipping; AOV = (gross − discounts) / orders). */
export function summarize(rows: DayAgg[]): Summary {
  let orders = 0, gross = 0, discounts = 0, returns = 0, returnedOrders = 0, shipping = 0, units = 0, cancelled = 0
  const cust = new Map<string, boolean>()
  const seenOrders = new Map<string, number>()
  for (const r of rows) {
    orders += r.w.n; gross += r.w.gross; discounts += r.w.disc; returns += r.w.ret; returnedOrders += r.w.retN; shipping += r.w.ship; units += r.w.units; cancelled += r.w.canc
    for (const [id, ret] of r.cu) {
      cust.set(id, (cust.get(id) ?? false) || ret === 1)
      seenOrders.set(id, (seenOrders.get(id) ?? 0) + 1)
    }
  }
  // a customer who orders on two different days in the range is returning too (the later day already says so; this is a safety net)
  for (const [id, n] of seenOrders) if (n > 1) cust.set(id, true)
  const net = r2(gross - discounts - returns)
  const returning = [...cust.values()].filter(Boolean).length
  return {
    orders, gross: r2(gross), discounts: r2(discounts), returns: r2(returns), returnedOrders, net, shipping: r2(shipping), total: r2(net + shipping),
    aov: orders ? Math.round((gross - discounts) / orders) : 0, units, cancelled,
    customers: cust.size, returning, returningRate: cust.size ? Math.round((returning / cust.size) * 1000) / 10 : null,
  }
}

/** One point per day from first to last, zero where nothing happened. */
export function dailySeries(rows: DayAgg[], fromDay: string, toDay: string) {
  const by = new Map(rows.map((r) => [r.day, r]))
  const out: { day: string; sales: number; orders: number }[] = []
  for (let d = fromDay, i = 0; d <= toDay && i < MAX_DAYS; d = addDays(d, 1), i++) {
    const r = by.get(d)
    out.push({ day: d, sales: r ? r.w.tot : 0, orders: r ? r.w.n : 0 })
  }
  return out
}

export function hourly(rows: DayAgg[]) {
  const sales = Array(24).fill(0), orders = Array(24).fill(0)
  for (const r of rows) for (let h = 0; h < 24; h++) { sales[h] = r2(sales[h] + (r.hs[h] ?? 0)); orders[h] += r.hn[h] ?? 0 }
  return sales.map((s, h) => ({ hour: h, sales: s, orders: orders[h] }))
}

export function channels(rows: DayAgg[]) {
  const m = new Map<string, { source: string; orders: number; sales: number }>()
  for (const r of rows) for (const c of r.ch) {
    const x = m.get(c.s) ?? { source: c.s, orders: 0, sales: 0 }
    x.orders += c.n; x.sales = r2(x.sales + c.v); m.set(c.s, x)
  }
  return [...m.values()].filter((x) => x.orders > 0).sort((a, b) => b.sales - a.sales)
}

export function topProducts(rows: DayAgg[], limit = 25) {
  const m = new Map<string, { sku: string; name: string; units: number; sales: number }>()
  for (const r of [...rows].sort((a, b) => a.day.localeCompare(b.day))) for (const i of r.it) {
    const x = m.get(i.k) ?? { sku: i.k, name: i.name, units: 0, sales: 0 }
    x.units += i.q; x.sales = r2(x.sales + i.v); x.name = i.name; m.set(i.k, x)
  }
  const all = [...m.values()].filter((x) => x.units > 0)
  return {
    byUnits: [...all].sort((a, b) => b.units - a.units || b.sales - a.sales).slice(0, limit),
    bySales: [...all].sort((a, b) => b.sales - a.sales || b.units - a.units).slice(0, limit),
  }
}

export function discountCodes(rows: DayAgg[]) {
  const m = new Map<string, { code: string; orders: number; sales: number; discount: number }>()
  for (const r of rows) for (const c of r.dc) {
    const x = m.get(c.c) ?? { code: c.c, orders: 0, sales: 0, discount: 0 }
    x.orders += c.n; x.sales = r2(x.sales + c.v); x.discount = r2(x.discount + c.d); m.set(c.c, x)
  }
  return [...m.values()].sort((a, b) => b.orders - a.orders || b.sales - a.sales)
}

// ---------------------------------------------------------------- abandoned checkouts
const WEBSITE_KINDS = ["webcheckout", "codform"]
const CHECKOUT_STATUSES = ["open", "ordered", "converted", "lost"] as const
type CheckoutLite = Pick<Doc<"checkouts">, "kind" | "status" | "total" | "shopCreatedAt" | "shopUpdatedAt" | "closedAt">

/** Checkout numbers. A checkout counts as abandoned when nothing happened on it for 15 minutes before it was closed (or still nothing now).
 *  Recovered = abandoned, then ordered after all (customer came back, or the team made the order). */
export function checkoutSummary(rows: CheckoutLite[], now: number) {
  const kinds = { webcheckout: 0, codform: 0, shopify: 0 }
  let started = 0, completed = 0, abandoned = 0, abandonedValue = 0, recovered = 0, recoveredValue = 0, recoveredByTeam = 0, open = 0, openValue = 0, lost = 0
  for (const c of rows) {
    started++
    const k = c.kind === "webcheckout" || c.kind === "codform" ? c.kind : "shopify"
    kinds[k]++
    const closed = c.status !== "open"
    const quiet = (closed ? (c.closedAt ?? c.shopUpdatedAt) : now) - c.shopUpdatedAt
    const wasAbandoned = quiet >= ABANDON_AFTER
    const won = c.status === "ordered" || c.status === "converted"
    if (!wasAbandoned) { if (won) completed++; continue }
    abandoned++; abandonedValue += c.total
    if (won) { recovered++; recoveredValue += c.total; if (c.status === "converted") recoveredByTeam++ }
    else if (c.status === "open") { open++; openValue += c.total }
    else lost++
  }
  return {
    started, completed, abandoned, abandonedValue: r2(abandonedValue), recovered, recoveredValue: r2(recoveredValue), recoveredByTeam,
    open, openValue: r2(openValue), lost, kinds,
    recoveryRate: abandoned ? Math.round((recovered / abandoned) * 1000) / 10 : null,
    /** checkouts that ended in an order, out of all started */
    checkoutConversion: started ? Math.round(((completed + recovered) / started) * 1000) / 10 : null,
  }
}

// ---------------------------------------------------------------- database side
async function staffOk(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  return !!s && (hasPerm(s.perms, "website.manage") || hasPerm(s.perms, "settings.manage"))
}

const cacheKey = (day: string) => `webDay:${day}`

/** How long a stored day stays good. */
export function maxAgeFor(day: string, today: string) {
  if (day >= addDays(today, -1)) return 5 * 60000
  if (day >= addDays(today, -14)) return 3600000
  return 12 * 3600000
}

export const readDays = internalQuery({
  args: { days: v.array(v.string()) },
  handler: async (ctx, { days }) => {
    if (!(await staffOk(ctx))) return null
    const out: { day: string; at: number; value: DayAgg }[] = []
    for (const day of days.slice(0, MAX_DAYS * 2)) {
      const row = await ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", cacheKey(day))).first()
      if (row) out.push({ day, at: row.at, value: row.value as DayAgg })
    }
    return out
  },
})

/** Works out a few days from their orders (each day is its own small index range). */
export const computeDays = internalQuery({
  args: { days: v.array(v.string()) },
  handler: async (ctx, { days }) => {
    if (!(await staffOk(ctx))) return null
    const out: DayAgg[] = []
    for (const day of days.slice(0, 7)) {
      const from = dayStart(day)
      const orders = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from).lt("createdAt", from + DAY)).collect()
      const returning = new Set<string>()
      const checked = new Set<string>()
      for (const o of orders) {
        if (o.deletedAt || o.source !== WEB_SOURCE || o.status === "cancelled") continue
        const id = String(o.customerId)
        if (checked.has(id)) continue
        checked.add(id)
        const firstToday = orders.filter((x) => String(x.customerId) === id && !x.deletedAt).reduce((m, x) => Math.min(m, x.createdAt), o.createdAt)
        const before = await ctx.db.query("orders").withIndex("by_customer", (q) => q.eq("customerId", o.customerId).lt("createdAt", firstToday)).order("desc").take(5)
        // a second order the same day also makes them returning
        const sameDay = orders.filter((x) => String(x.customerId) === id && !x.deletedAt && x.status !== "cancelled").length > 1
        if (sameDay || before.some((x) => !x.deletedAt)) returning.add(id)
      }
      out.push(aggregateDay(day, orders, returning))
    }
    return out
  },
})

export const saveDays = internalMutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, { rows }) => {
    const now = Date.now()
    for (const value of rows as DayAgg[]) {
      const key = cacheKey(value.day)
      const row = await ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", key)).first()
      if (row) await ctx.db.patch(row._id, { at: now, value })
      else await ctx.db.insert("cache", { key, at: now, value })
    }
  },
})

export const checkoutRows = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    if (!(await staffOk(ctx))) return null
    const out: CheckoutLite[] = []
    for (const status of CHECKOUT_STATUSES) {
      // last activity is never before the checkout began, so this range holds every checkout begun in [from, to]
      const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", status).gte("shopUpdatedAt", from)).take(5000)
      for (const c of rows) {
        if (c.shopCreatedAt < from || c.shopCreatedAt > to) continue
        out.push({ kind: c.kind, status: c.status, total: c.total, shopCreatedAt: c.shopCreatedAt, shopUpdatedAt: c.shopUpdatedAt, closedAt: c.closedAt })
      }
    }
    return out
  },
})

/** Home "to do": website orders waiting and abandoned checkouts still to call. */
export const todoData = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await staffOk(ctx))) return null
    const count = async (status: "pending" | "on_hold" | "approved") => {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(1000)
      const web = rows.filter((o) => !o.deletedAt && o.source === WEB_SOURCE)
      return { n: web.length, v: r2(web.reduce((t, o) => t + o.total, 0)) }
    }
    const now = Date.now()
    const carts = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open").gte("shopUpdatedAt", now - 7 * DAY)).take(2000)
    const toCall = carts.filter((c) => now - c.shopUpdatedAt >= ABANDON_AFTER && WEBSITE_KINDS.includes(c.kind ?? ""))
    return {
      pending: await count("pending"), onHold: await count("on_hold"), approved: await count("approved"),
      checkoutsToCall: { n: toCall.length, v: r2(toCall.reduce((t, c) => t + c.total, 0)) },
    }
  },
})

type Ctx = { runQuery: (...a: any[]) => Promise<any>; runMutation: (...a: any[]) => Promise<any> }

/** Day summaries for [fromDay, toDay]: stored ones when fresh enough, the rest worked out now and stored. */
async function loadDays(ctx: Ctx, fromDay: string, toDay: string, today: string, now: number): Promise<DayAgg[] | null> {
  const want: string[] = []
  for (let d = fromDay; d <= toDay && want.length < MAX_DAYS; d = addDays(d, 1)) want.push(d)
  const stored: { day: string; at: number; value: DayAgg }[] | null = await ctx.runQuery(internal.websiteAnalytics.readDays, { days: want })
  if (!stored) return null
  const have = new Map(stored.filter((s) => now - s.at < maxAgeFor(s.day, today) && s.value && Array.isArray(s.value.cu)).map((s) => [s.day, s.value]))
  const missing = want.filter((d) => !have.has(d))
  for (let i = 0; i < missing.length; i += 7) {
    const batch = missing.slice(i, i + 7)
    const rows: DayAgg[] | null = await ctx.runQuery(internal.websiteAnalytics.computeDays, { days: batch })
    if (!rows) return null
    for (const r of rows) have.set(r.day, r)
    // keep only days with something in them (empty days are cheap to work out again)
    const worth = rows.filter((r) => r.ch.length || r.w.canc)
    if (worth.length) await ctx.runMutation(internal.websiteAnalytics.saveDays, { rows: worth })
  }
  return want.map((d) => have.get(d)!).filter(Boolean)
}

function report(rows: DayAgg[], fromDay: string, toDay: string) {
  return { summary: summarize(rows), daily: dailySeries(rows, fromDay, toDay), hourly: hourly(rows) }
}

/** Everything Website → Home / Analytics shows, for one date range and the same number of days just before it. */
export const overview = action({
  args: { fromDay: v.string(), toDay: v.string(), compare: v.optional(v.boolean()), todo: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<any> => {
    if (!isDay(args.fromDay) || !isDay(args.toDay)) throw new Error("Pick a valid date range")
    const now = Date.now()
    const today = bdDay(now)
    const toDay = args.toDay > today ? today : args.toDay
    let fromDay = args.fromDay > toDay ? toDay : args.fromDay
    if (daysBetween(fromDay, toDay) > MAX_DAYS) fromDay = addDays(toDay, -(MAX_DAYS - 1))
    const len = daysBetween(fromDay, toDay)
    const prevTo = addDays(fromDay, -1)
    const prevFrom = addDays(fromDay, -len)

    const cur = await loadDays(ctx, fromDay, toDay, today, now)
    if (!cur) return null
    const prev = args.compare === false ? null : await loadDays(ctx, prevFrom, prevTo, today, now)
    const end = Math.min(dayStart(toDay) + DAY - 1, now)
    const carts: CheckoutLite[] = (await ctx.runQuery(internal.websiteAnalytics.checkoutRows, { from: dayStart(fromDay), to: end })) ?? []
    const prevCarts: CheckoutLite[] | null = prev ? await ctx.runQuery(internal.websiteAnalytics.checkoutRows, { from: dayStart(prevFrom), to: dayStart(prevTo) + DAY - 1 }) : null
    const webCarts = (rows: CheckoutLite[]) => rows.filter((c) => WEBSITE_KINDS.includes(c.kind ?? ""))

    return {
      fromDay, toDay, prevFromDay: prevFrom, prevToDay: prevTo, days: len, computedAt: now,
      cur: report(cur, fromDay, toDay),
      prev: prev ? report(prev, prevFrom, prevTo) : null,
      channels: channels(cur),
      products: topProducts(cur),
      discountCodes: discountCodes(cur),
      checkouts: checkoutSummary(webCarts(carts), now),
      prevCheckouts: prevCarts ? checkoutSummary(webCarts(prevCarts), now) : null,
      /** older Shopify checkouts / draft orders in the same dates, shown separately */
      shopifyCheckouts: checkoutSummary(carts.filter((c) => !WEBSITE_KINDS.includes(c.kind ?? "")), now),
      todo: args.todo ? await ctx.runQuery(internal.websiteAnalytics.todoData, {}) : null,
    }
  },
})
