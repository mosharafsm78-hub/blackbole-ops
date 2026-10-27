import { v } from "convex/values"
import { action, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { currentStaff } from "./lib"
import { bdDay, statsFromDays } from "./stats"

const DAY = 86400000
const BD_OFFSET = 6 * 3600000 // Asia/Dhaka

export const statsData = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to))
      .collect()
      .then((rows) => rows.filter((o) => !o.deletedAt))
    const live = orders.filter((o) => o.status !== "cancelled")

    const days = new Map<string, { day: string; orders: number; sales: number; delivered: number; returned: number; cancelled: number; open: number }>()
    for (let t = from; t <= to; t += DAY) {
      const key = new Date(t + BD_OFFSET).toISOString().slice(0, 10)
      days.set(key, { day: key, orders: 0, sales: 0, delivered: 0, returned: 0, cancelled: 0, open: 0 })
    }
    for (const o of orders) {
      const key = new Date(o.createdAt + BD_OFFSET).toISOString().slice(0, 10)
      const d = days.get(key)
      if (!d) continue
      if (o.status === "cancelled") { d.cancelled++; continue }
      d.orders++; d.sales += o.total
      if (o.status === "delivered_due" || o.status === "delivered_paid") d.delivered++
      else if (["pending_returned", "returned", "damaged"].includes(o.status)) d.returned++
      else d.open++
    }

    const byStatus: Record<string, number> = {}
    const bySource: Record<string, { count: number; value: number }> = {}
    const items = new Map<string, { sku: string; name: string; qty: number; value: number }>()
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
      if (o.status === "cancelled") continue
      const src = (bySource[o.source] ??= { count: 0, value: 0 })
      src.count++
      src.value += o.total
      for (const i of o.items) {
        const it = items.get(i.sku) ?? { sku: i.sku, name: `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}`, qty: 0, value: 0 }
        it.qty += i.qty
        it.value += i.price * i.qty - i.discount
        items.set(i.sku, it)
      }
    }
    const delivered = orders.filter((o) => o.status === "delivered_due" || o.status === "delivered_paid").length
    const returned = orders.filter((o) => ["pending_returned", "returned", "damaged"].includes(o.status)).length
    const cancelled = byStatus.cancelled ?? 0
    const resolved = delivered + returned

    return {
      returned,
      delivered,
      deliveredValue: orders.filter((o) => o.status === "delivered_due" || o.status === "delivered_paid").reduce((t, o) => t + o.total, 0),
      totalOrders: live.length,
      totalSales: live.reduce((sum, o) => sum + o.total, 0),
      avgOrder: live.length ? Math.round(live.reduce((sum, o) => sum + o.total, 0) / live.length) : 0,
      cancelled,
      deliveryRate: resolved ? Math.round((delivered / resolved) * 100) : null,
      dueCollect: live.filter((o) => o.status === "delivered_due").reduce((sum, o) => sum + o.due, 0),
      daily: [...days.values()],
      byStatus,
      bySource: Object.entries(bySource).map(([source, x]) => ({ source, ...x })).sort((a, b) => b.count - a.count),
      topItems: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 10),
    }
  },
})

/** Not live on purpose: the dashboard refreshes every minute instead of re-adding up every order on every change. */
export const stats = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, args): Promise<any> => await ctx.runQuery(internal.dashboard.statsData, args),
})

/** Money side from Pathao for the dashboard: what Pathao paid us in these dates and what is still waiting. */
export const moneyData = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const inv = await ctx.db.query("pathaoInvoices").withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to)).collect()
    const paidInv = inv.filter((i) => i.status.toLowerCase() === "paid")
    const last = await ctx.db.query("pathaoInvoices").withIndex("by_created").order("desc").first()
    // delivered with Pathao in the last 60 days but Pathao hasn't paid us yet
    const recent = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", Date.now() - 60 * DAY)).collect()
    const waiting = recent.filter((o) => o.consignmentId && o.courier === "pathao" && !o.courierPaid && !o.deletedAt && (o.status === "delivered_due" || o.status === "delivered_paid"))
    return {
      paidToUs: paidInv.reduce((t, i) => t + i.receivable, 0),
      collected: inv.reduce((t, i) => t + i.collected, 0),
      fees: inv.reduce((t, i) => t + i.totalFee, 0),
      invoices: inv.length,
      lastInvoice: last ? { id: last.invoiceId, at: last.createdAt, amount: last.receivable, status: last.status } : null,
      waitingCount: waiting.length,
      waitingAmount: waiting.reduce((t, o) => t + (o.courierCollected ?? o.total) - (o.courierCost ?? o.courierFee ?? 0), 0),
    }
  },
})

export const signedIn = internalQuery({ args: {}, handler: async (ctx) => !!(await currentStaff(ctx)) })

/** Admin check: old way (reading every order) vs scoreboard, for the same dates. */
export const compareStats = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "team.manage" })
    const old = await ctx.runQuery(internal.dashboard.statsData, { from, to })
    const neu = statsFromDays(await ctx.runQuery(internal.stats.days, { fromDay: bdDay(from), toDay: bdDay(to) }), from, to)
    const diffs: string[] = []
    for (const k of ["returned", "delivered", "deliveredValue", "totalOrders", "totalSales", "avgOrder", "cancelled", "deliveryRate", "dueCollect"] as const) {
      if (Math.abs(Number((old as any)[k] ?? 0) - Number((neu as any)[k] ?? 0)) > 0.5) diffs.push(`${k}: old ${(old as any)[k]} new ${(neu as any)[k]}`)
    }
    for (const [st, n] of Object.entries({ ...(old as any).byStatus, ...neu.byStatus })) {
      const a = (old as any).byStatus[st] ?? 0, b = neu.byStatus[st] ?? 0
      if (a !== b) diffs.push(`status ${st}: old ${a} new ${b} (${n})`)
    }
    ;(old as any).daily.forEach((d: any, i: number) => { if (JSON.stringify(d) !== JSON.stringify(neu.daily[i])) diffs.push(`day ${d.day}: old ${JSON.stringify(d)} new ${JSON.stringify(neu.daily[i])}`) })
    return { ok: diffs.length === 0, diffs: diffs.slice(0, 40), ready: await ctx.runQuery(internal.stats.ready, {}) }
  },
})

// ---------- shared cache: heavy reports are worked out once and reused by everyone for a few minutes ----------
export const readCache = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    if (!(await currentStaff(ctx))) throw new Error("Not signed in")
    const row = await ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", key)).unique()
    return row ? { at: row.at, value: row.value } : null
  },
})
export const writeCache = internalMutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, { key, value }) => {
    const row = await ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", key)).unique()
    if (row) await ctx.db.patch(row._id, { at: Date.now(), value })
    else await ctx.db.insert("cache", { key, at: Date.now(), value })
  },
})
async function cached<T>(ctx: any, key: string, maxAgeMs: number, make: () => Promise<T>): Promise<T> {
  const hit = await ctx.runQuery(internal.dashboard.readCache, { key })
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as T
  const value = await make()
  await ctx.runMutation(internal.dashboard.writeCache, { key, value })
  return value
}

/** Everything the dashboard shows, in one call (re-worked out at most every 5 minutes, shared by everyone). */
export const overview = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => cached(ctx, `overview:${from}:${to}`, 5 * 60000, () => buildOverview(ctx, from, to)),
})

async function buildOverview(ctx: any, from: number, to: number): Promise<any> {
  {
    const span = to - from + 1
    const bd = new Date(Date.now() + BD_OFFSET); bd.setUTCHours(0, 0, 0, 0)
    const todayStart = bd.getTime() - BD_OFFSET
    const fast = await ctx.runQuery(internal.stats.ready, {})
    const range = async (a: number, b: number) => {
      if (!fast) return await ctx.runQuery(internal.dashboard.statsData, { from: a, to: b })
      if (!(await ctx.runQuery(internal.dashboard.signedIn, {}))) return null
      return statsFromDays(await ctx.runQuery(internal.stats.days, { fromDay: bdDay(a), toDay: bdDay(b) }), a, b)
    }
    const [now, prev, money, pathao, today, yesterday] = await Promise.all([
      range(from, to),
      range(from - span, from - 1),
      ctx.runQuery(internal.dashboard.moneyData, { from, to }),
      ctx.runAction(internal.pathao.dashboardStats, { from, to }).catch(() => null),
      ctx.runQuery(internal.dashboard.statsData, { from: todayStart, to: todayStart + DAY - 1 }),
      ctx.runQuery(internal.dashboard.statsData, { from: todayStart - DAY, to: Date.now() - DAY }),
    ])
    return { now, prev, money, pathao, today, yesterday }
  }
}

/** One page of compact orders for the monthly summary. */
export const monthPage = internalQuery({
  args: { from: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, cursor }) => {
    const s = await currentStaff(ctx)
    if (!s) return { rows: [], isDone: true, cursor: "" }
    const res = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from)).paginate({ cursor, numItems: 500 })
    return {
      isDone: res.isDone, cursor: res.continueCursor,
      rows: res.page.filter((o) => !o.deletedAt).map((o) => ({ at: o.createdAt, status: o.status, total: o.total, items: o.itemCount ?? o.items.reduce((t, i) => t + i.qty, 0) })),
    }
  },
})

export const monthMoney = internalQuery({
  args: { from: v.number() },
  handler: async (ctx, { from }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return (await ctx.db.query("pathaoInvoices").withIndex("by_created", (q) => q.gte("createdAt", from)).collect()).map((i) => ({ at: i.createdAt, paid: i.status.toLowerCase() === "paid" ? i.receivable : 0, fees: i.totalFee }))
  },
})

/** Month by month: orders, sales, delivered, returned, cancelled, delivery %, Pathao paid us (re-worked out at most every 2 hours). */
export const monthly = action({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, { months = 6 }): Promise<any[]> => cached(ctx, `monthly:${months}`, 2 * 3600000, () => buildMonthly(ctx, months)),
})

async function buildMonthly(ctx: any, months: number): Promise<any[]> {
  if (await ctx.runQuery(internal.stats.ready, {})) return await buildMonthlyFast(ctx, months)
  {
    const nowBD = new Date(Date.now() + BD_OFFSET)
    const start = Date.UTC(nowBD.getUTCFullYear(), nowBD.getUTCMonth() - (months - 1), 1) - BD_OFFSET
    const key = (t: number) => new Date(t + BD_OFFSET).toISOString().slice(0, 7)
    const out = new Map<string, any>()
    for (let i = 0; i < months; i++) {
      const k = new Date(Date.UTC(nowBD.getUTCFullYear(), nowBD.getUTCMonth() - (months - 1) + i, 1)).toISOString().slice(0, 7)
      out.set(k, { month: k, orders: 0, sales: 0, items: 0, delivered: 0, deliveredValue: 0, returned: 0, cancelled: 0, open: 0, pathaoPaid: 0, pathaoFees: 0 })
    }
    let cursor: string | null = null
    for (let i = 0; i < 200; i++) {
      const res: { isDone: boolean; cursor: string; rows: { at: number; status: string; total: number; items: number }[] } = await ctx.runQuery(internal.dashboard.monthPage, { from: start, cursor })
      for (const r of res.rows) {
        const m = out.get(key(r.at)); if (!m) continue
        if (r.status === "cancelled") { m.cancelled++; continue }
        m.orders++; m.sales += r.total; m.items += r.items
        if (r.status === "delivered_due" || r.status === "delivered_paid") { m.delivered++; m.deliveredValue += r.total }
        else if (["pending_returned", "returned", "damaged"].includes(r.status)) m.returned++
        else m.open++
      }
      if (res.isDone) break
      cursor = res.cursor
    }
    for (const i of await ctx.runQuery(internal.dashboard.monthMoney, { from: start })) {
      const m = out.get(key(i.at)); if (m) { m.pathaoPaid += i.paid; m.pathaoFees += i.fees }
    }
    return [...out.values()].reverse().map((m) => ({ ...m, deliveryRate: m.delivered + m.returned ? Math.round((m.delivered / (m.delivered + m.returned)) * 100) : null }))
  }
}

const DELIVERED = ["delivered_due", "delivered_paid"]
const RETURNED = ["pending_returned", "returned", "damaged"]
async function buildMonthlyFast(ctx: any, months: number): Promise<any[]> {
  if (!(await ctx.runQuery(internal.dashboard.signedIn, {}))) return []
  const nowBD = new Date(Date.now() + BD_OFFSET)
  const start = Date.UTC(nowBD.getUTCFullYear(), nowBD.getUTCMonth() - (months - 1), 1) - BD_OFFSET
  const out = new Map<string, any>()
  for (let i = 0; i < months; i++) {
    const k = new Date(Date.UTC(nowBD.getUTCFullYear(), nowBD.getUTCMonth() - (months - 1) + i, 1)).toISOString().slice(0, 7)
    out.set(k, { month: k, orders: 0, sales: 0, items: 0, delivered: 0, deliveredValue: 0, returned: 0, cancelled: 0, open: 0, pathaoPaid: 0, pathaoFees: 0 })
  }
  const rows: any[] = await ctx.runQuery(internal.stats.days, { fromDay: bdDay(start), toDay: bdDay(Date.now()) })
  for (const r of rows) {
    const m = out.get(r.day.slice(0, 7)); if (!m) continue
    m.items += r.q
    for (const s of r.st) {
      if (s.s === "cancelled") { m.cancelled += s.n; continue }
      m.orders += s.n; m.sales += s.v
      if (DELIVERED.includes(s.s)) { m.delivered += s.n; m.deliveredValue += s.v }
      else if (RETURNED.includes(s.s)) m.returned += s.n
      else m.open += s.n
    }
  }
  const key = (t: number) => new Date(t + BD_OFFSET).toISOString().slice(0, 7)
  for (const i of await ctx.runQuery(internal.dashboard.monthMoney, { from: start })) {
    const m = out.get(key(i.at)); if (m) { m.pathaoPaid += i.paid; m.pathaoFees += i.fees }
  }
  return [...out.values()].reverse().map((m) => ({ ...m, sales: Math.round(m.sales * 100) / 100, deliveredValue: Math.round(m.deliveredValue * 100) / 100, deliveryRate: m.delivered + m.returned ? Math.round((m.delivered / (m.delivered + m.returned)) * 100) : null }))
}

// ---------- business insights: a few specific, numbers-backed problems + fixes, ranked by money impact ----------
const taka = (n: number) => `৳${Math.round(n).toLocaleString("en-IN")}`
const INSIGHT_WINDOW_DAYS = 90
const MIN_SOURCE_RESOLVED = 15
const MIN_SKU_QTY = 15

export const insightsData = internalQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to))
      .collect()
      .then((rows) => rows.filter((o) => !o.deletedAt))

    const bySource = new Map<string, { count: number; value: number; delivered: number; returned: number }>()
    const bySku = new Map<string, { name: string; qty: number; returnedQty: number; returnedValue: number; reasons: { at: number; text: string }[] }>()
    const byCustomer = new Map<string, { count: number; value: number }>()

    for (const o of orders) {
      if (o.status === "cancelled") continue
      const delivered = DELIVERED.includes(o.status)
      const returned = RETURNED.includes(o.status)

      const src = bySource.get(o.source) ?? { count: 0, value: 0, delivered: 0, returned: 0 }
      src.count++; src.value += o.total
      if (delivered) src.delivered++
      if (returned) src.returned++
      bySource.set(o.source, src)

      const cust = byCustomer.get(o.customerId) ?? { count: 0, value: 0 }
      cust.count++; cust.value += o.total
      byCustomer.set(o.customerId, cust)

      for (const i of o.items) {
        const sk = bySku.get(i.sku) ?? { name: `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}`, qty: 0, returnedQty: 0, returnedValue: 0, reasons: [] as { at: number; text: string }[] }
        sk.qty += i.qty
        if (returned) {
          sk.returnedQty += i.qty; sk.returnedValue += i.price * i.qty - i.discount
          if (o.reason?.trim()) sk.reasons.push({ at: o.createdAt, text: o.reason.trim() })
        }
        bySku.set(i.sku, sk)
      }
    }
    return {
      bySource: [...bySource.entries()],
      bySku: [...bySku.entries()],
      customers: [...byCustomer.values()],
    }
  },
})

export const insights = action({
  args: {},
  handler: async (ctx): Promise<any> => cached(ctx, "insights", 30 * 60000, () => buildInsights(ctx)),
})

async function buildInsights(ctx: any) {
  const to = Date.now()
  const from = to - INSIGHT_WINDOW_DAYS * DAY
  const d = await ctx.runQuery(internal.dashboard.insightsData, { from, to })
  if (!d) return { findings: [], windowDays: INSIGHT_WINDOW_DAYS }

  const findings: { id: string; problem: string; finding: string; solution: string; impact: number; status: "automatic" | "human" | "setup"; aiDid: string; detail: string[] }[] = []

  // A. The order source with the worst return rate, if it's well clear of the rest of the business.
  const sources: [string, { count: number; value: number; delivered: number; returned: number }][] = d.bySource
  const totalResolved = sources.reduce((t, [, s]) => t + s.delivered + s.returned, 0)
  const totalReturned = sources.reduce((t, [, s]) => t + s.returned, 0)
  const overallRate = totalResolved ? totalReturned / totalResolved : 0
  let worstSrc: { source: string; rate: number; resolved: number; returned: number; avgValue: number } | null = null
  for (const [source, s] of sources) {
    const resolved = s.delivered + s.returned
    if (resolved < MIN_SOURCE_RESOLVED) continue
    const rate = s.returned / resolved
    if (rate > overallRate + 0.08 && (!worstSrc || rate > worstSrc.rate)) worstSrc = { source, rate, resolved, returned: s.returned, avgValue: s.value / s.count }
  }
  if (worstSrc) {
    const impact = Math.round(worstSrc.returned * worstSrc.avgValue)
    findings.push({
      id: "source-returns",
      problem: `"${worstSrc.source}" orders fail far more than the rest of the business`,
      finding: `Last ${INSIGHT_WINDOW_DAYS} days: ${Math.round(worstSrc.rate * 100)}% of resolved "${worstSrc.source}" orders came back (${worstSrc.returned} of ${worstSrc.resolved}), vs ${Math.round(overallRate * 100)}% across every other source — about ${taka(impact)} tied up in failed COD and courier fees.`,
      solution: `Give "${worstSrc.source}" orders a stricter confirmation call (verify address + ask for a small advance on repeat-return customers) before they go to packing — don't treat it the same as your cleaner sources.`,
      impact,
      status: "human" as const,
      aiDid: `Found the exact source and the gap (${Math.round(worstSrc.rate * 100)}% vs ${Math.round(overallRate * 100)}%). No automatic fix exists yet — auto-flagging these orders for a stricter call would need to be built.`,
      detail: [] as string[],
    })
  }

  // B. The single product driving an outsized share of returns.
  const skus: [string, { name: string; qty: number; returnedQty: number; returnedValue: number; reasons: { at: number; text: string }[] }][] = d.bySku
  let worstSku: { sku: string; name: string; qty: number; returnedQty: number; returnedValue: number; reasons: { at: number; text: string }[]; rate: number } | null = null
  for (const [sku, k] of skus) {
    if (k.qty < MIN_SKU_QTY) continue
    const rate = k.returnedQty / k.qty
    if (rate > 0.25 && (!worstSku || rate > worstSku.rate)) worstSku = { sku, ...k, rate }
  }
  if (worstSku) {
    const impact = Math.round(worstSku.returnedValue)
    const topReasons = worstSku.reasons.sort((a, b) => b.at - a.at).slice(0, 10).map((r) => r.text)
    findings.push({
      id: "sku-returns",
      problem: "One product is quietly eating your margin",
      finding: `${worstSku.name} (${worstSku.sku}) was returned ${Math.round(worstSku.rate * 100)}% of the time over ${INSIGHT_WINDOW_DAYS} days (${worstSku.returnedQty} of ${worstSku.qty} units) — about ${taka(impact)} in stock, packing and courier cost.`,
      solution: `${topReasons.length ? "Read the return reasons below first. " : ""}If it's sizing, add a fit note to the product page; if it's quality, pause ads on it until the supplier fixes the batch — right now you're paying to acquire customers who return it.`,
      impact,
      status: "human" as const,
      aiDid: topReasons.length ? `Pulled the ${topReasons.length} most recent return reasons for this SKU (below). The decision — fix the listing or pull the product — needs a person.` : "Found the SKU and the money at stake. No return reasons were logged on these orders, so the cause still needs a human look.",
      detail: topReasons,
    })
  }

  // C. Hardly anyone buys a second time — a growth lever, not just an ops problem.
  const customers = d.customers as { count: number; value: number }[]
  const repeat = customers.filter((c) => c.count >= 2)
  const single = customers.filter((c) => c.count === 1)
  const repeatRate = customers.length ? repeat.length / customers.length : 0
  if (customers.length >= 30 && repeatRate < 0.15 && single.length > 0) {
    const singleTotal = single.reduce((t, c) => t + c.value, 0)
    const impact = Math.round(singleTotal * 0.15)
    const [wb, wa] = await Promise.all([
      ctx.runQuery(internal.winback.liveStats, {}).catch(() => null),
      ctx.runQuery(internal.waQueue.liveStats, {}).catch(() => null),
    ])
    const live = wb?.enabled
    const waLine = wa ? ` WhatsApp queue: ${wa.sentTotal} sent by the team, ${wa.pendingTotal} waiting.` : ""
    findings.push({
      id: "repeat-rate",
      problem: "You're selling once and losing the customer",
      finding: `Only ${Math.round(repeatRate * 100)}% of ${customers.length} customers in the last ${INSIGHT_WINDOW_DAYS} days bought a second time. ${single.length} one-time buyers spent ${taka(Math.round(singleTotal))} total and then went quiet.`,
      solution: `Auto-send an SMS 10–20 days after delivery with a small win-back discount for a second order, plus a WhatsApp message the team taps to send. Even a 15% response on these buyers alone is worth roughly ${taka(impact)} — and it's the cheapest growth you have, since you already paid to acquire them once.`,
      impact,
      status: "automatic" as const,
      aiDid: (live
        ? `Sending the win-back SMS automatically, no one touches it. So far: ${wb!.sentTotal} sent, ${wb!.redeemed} redeemed the discount.`
        : `Built and ready — starts sending automatically from ${new Date(wb?.startAt ?? Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (Dhaka time).`) + waLine,
      detail: [] as string[],
    })
  }

  findings.sort((a, b) => b.impact - a.impact)
  return { findings, windowDays: INSIGHT_WINDOW_DAYS }
}
