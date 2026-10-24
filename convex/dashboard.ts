import { v } from "convex/values"
import { action, internalQuery } from "./_generated/server"
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

/** Everything the dashboard shows, in one call: this period, the period before, Pathao's delivery outcome and money. */
export const overview = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => {
    const span = to - from + 1
    const [now, prev, money, pathao] = await Promise.all([
      ctx.runQuery(internal.dashboard.statsData, { from, to }),
      ctx.runQuery(internal.dashboard.statsData, { from: from - span, to: from - 1 }),
      ctx.runQuery(internal.dashboard.moneyData, { from, to }),
      ctx.runAction(internal.pathao.dashboardStats, { from, to }).catch(() => null),
    ])
    return { now, prev, money, pathao }
  },
})
