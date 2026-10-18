import { v } from "convex/values"
import { query } from "./_generated/server"
import { currentStaff } from "./lib"

const DAY = 86400000
const BD_OFFSET = 6 * 3600000 // Asia/Dhaka

export const stats = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to))
      .collect()
    const live = orders.filter((o) => o.status !== "cancelled")

    const days = new Map<string, { day: string; orders: number; sales: number }>()
    for (let t = from; t <= to; t += DAY) {
      const key = new Date(t + BD_OFFSET).toISOString().slice(0, 10)
      days.set(key, { day: key, orders: 0, sales: 0 })
    }
    for (const o of live) {
      const key = new Date(o.createdAt + BD_OFFSET).toISOString().slice(0, 10)
      const d = days.get(key)
      if (d) { d.orders++; d.sales += o.total }
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
