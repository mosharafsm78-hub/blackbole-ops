import { v } from "convex/values"
import { action, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { currentStaff } from "./lib"

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
    const [now, prev, money, pathao, today, yesterday] = await Promise.all([
      ctx.runQuery(internal.dashboard.statsData, { from, to }),
      ctx.runQuery(internal.dashboard.statsData, { from: from - span, to: from - 1 }),
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
