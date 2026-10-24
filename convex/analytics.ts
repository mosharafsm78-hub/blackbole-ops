import { v, ConvexError } from "convex/values"
import { internal } from "./_generated/api"
import { action, internalQuery } from "./_generated/server"
import { requirePerm } from "./lib"

const DELIVERED = new Set(["delivered_due", "delivered_paid"])
const RETURNED = new Set(["pending_returned", "returned", "damaged"])
const BD = 6 * 3600000
const day = (t: number) => new Date(t + BD).toISOString().slice(0, 10)

export const checkAccess = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx, "reports.view")
    return { costs: s.perms.includes("*") || s.perms.includes("orders.costs") }
  },
})

/** One page of compact order rows for the report (by order date or by delivery date). */
export const page = internalQuery({
  args: { from: v.number(), to: v.number(), basis: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, basis, cursor }) => {
    const q = basis === "delivered"
      ? ctx.db.query("orders").withIndex("by_delivered", (x) => x.gte("deliveredAt", from).lte("deliveredAt", to))
      : ctx.db.query("orders").withIndex("by_created", (x) => x.gte("createdAt", from).lte("createdAt", to))
    const res = await q.paginate({ cursor, numItems: 300 })
    return {
      isDone: res.isDone,
      cursor: res.continueCursor,
      rows: res.page.filter((o) => !o.deletedAt).map((o) => ({
        at: basis === "delivered" ? (o.deliveredAt ?? o.createdAt) : o.createdAt,
        status: o.status,
        source: o.source,
        total: o.total,
        subtotal: o.subtotal,
        discount: o.discount,
        deliveryFee: o.deliveryFee,
        paid: o.paidAmount,
        due: o.due,
        city: o.cityName || "Not set",
        staff: o.createdByName || "—",
        method: o.paymentMethod || "Cash on delivery",
        partner: o.deliveryPartnerName || (o.deliveryType === "pickup" ? "Store pickup" : "—"),
        cost: (o.purchaseCost ?? 0) + (o.courierCost ?? o.courierFee ?? 0) + (o.codCost ?? 0) + (o.otherCost ?? 0),
        items: o.items.map((i) => ({ sku: i.sku, name: i.name, attrs: i.attrs, qty: i.qty, amount: i.price * i.qty - i.discount })),
      })),
    }
  },
})

type Agg = { key: string; orders: number; value: number; delivered: number; returned: number; cancelled: number }
const bump = (m: Map<string, Agg>, key: string, value: number, status: string) => {
  const a = m.get(key) ?? { key, orders: 0, value: 0, delivered: 0, returned: 0, cancelled: 0, open: 0 }
  a.orders++; a.value += value
  if (DELIVERED.has(status)) a.delivered++
  else if (RETURNED.has(status)) a.returned++
  else if (status === "cancelled") a.cancelled++
  m.set(key, a)
}
const sorted = (m: Map<string, Agg>) => [...m.values()].sort((a, b) => b.orders - a.orders)

export const run = action({
  args: { from: v.number(), to: v.number(), basis: v.optional(v.string()) },
  handler: async (ctx, { from, to, basis = "created" }) => {
    const access = await ctx.runQuery(internal.analytics.checkAccess, {})
    if (to - from > 370 * 86400000) throw new ConvexError("Choose a range of one year or less")
    let cursor: string | null = null
    const rows: Awaited<ReturnType<typeof ctx.runQuery<typeof internal.analytics.page>>>["rows"] = []
    for (let i = 0; i < 400; i++) {
      const res: { isDone: boolean; cursor: string; rows: typeof rows } = await ctx.runQuery(internal.analytics.page, { from, to, basis, cursor })
      rows.push(...res.rows)
      if (res.isDone) break
      cursor = res.cursor
    }

    const byStatus = new Map<string, { status: string; orders: number; value: number }>()
    const bySource = new Map<string, Agg>(), byCity = new Map<string, Agg>(), byStaff = new Map<string, Agg>()
    const byMethod = new Map<string, Agg>(), byPartner = new Map<string, Agg>()
    const byDay = new Map<string, { day: string; orders: number; value: number; delivered: number; returned: number; cancelled: number; open: number }>()
    const products = new Map<string, { name: string; sku: string; qty: number; amount: number; deliveredQty: number; returnedQty: number; orders: number }>()
    let value = 0, items = 0, delivered = 0, deliveredValue = 0, returned = 0, cancelled = 0, open = 0, collected = 0, dueOnDelivered = 0
    let discount = 0, deliveryFees = 0, profitBase = 0, cost = 0

    for (const r of rows) {
      const isDel = DELIVERED.has(r.status), isRet = RETURNED.has(r.status), isCan = r.status === "cancelled"
      value += r.total
      const s = byStatus.get(r.status) ?? { status: r.status, orders: 0, value: 0 }
      s.orders++; s.value += r.total; byStatus.set(r.status, s)
      bump(bySource, r.source, r.total, r.status)
      bump(byCity, r.city, r.total, r.status)
      bump(byStaff, r.staff, r.total, r.status)
      bump(byMethod, r.method, r.total, r.status)
      bump(byPartner, r.partner, r.total, r.status)
      const d = byDay.get(day(r.at)) ?? { day: day(r.at), orders: 0, value: 0, delivered: 0, returned: 0, cancelled: 0, open: 0 }
      d.orders++; d.value += r.total
      if (isDel) d.delivered++; else if (isRet) d.returned++; else if (isCan) d.cancelled++; else d.open++
      byDay.set(d.day, d)
      if (isDel) { delivered++; deliveredValue += r.total; dueOnDelivered += r.status === "delivered_due" ? r.due : 0; profitBase += r.subtotal - r.discount; cost += r.cost }
      else if (isRet) returned++
      else if (isCan) cancelled++
      else open++
      if (!isCan) { collected += r.paid; discount += r.discount; deliveryFees += r.deliveryFee }
      for (const it of r.items) {
        if (isCan) continue
        items += it.qty
        const key = it.name
        const p = products.get(key) ?? { name: it.name, sku: it.sku.split("-").slice(0, -1).join("-") || it.sku, qty: 0, amount: 0, deliveredQty: 0, returnedQty: 0, orders: 0 }
        p.qty += it.qty; p.amount += it.amount; p.orders++
        if (isDel) p.deliveredQty += it.qty
        if (isRet) p.returnedQty += it.qty
        products.set(key, p)
      }
    }

    // fill empty days so the chart has no gaps
    const days: { day: string; orders: number; value: number; delivered: number; returned: number; cancelled: number; open: number }[] = []
    for (let t = from; t <= to; t += 86400000) days.push(byDay.get(day(t)) ?? { day: day(t), orders: 0, value: 0, delivered: 0, returned: 0, cancelled: 0, open: 0 })

    const settled = delivered + returned
    const counted = rows.length
    return {
      basis,
      summary: {
        orders: counted, value, avgOrder: counted ? Math.round(value / counted) : 0, items,
        delivered, deliveredValue, returned, cancelled, open, collected, dueOnDelivered, discount, deliveryFees,
        successRate: settled ? Math.round((delivered / settled) * 100) : null,
        cancelRate: counted ? Math.round((cancelled / counted) * 100) : 0,
        profit: access.costs ? profitBase - cost : null,
      },
      days: days.length <= 400 ? days : [],
      byStatus: [...byStatus.values()].sort((a, b) => b.orders - a.orders),
      bySource: sorted(bySource), byCity: sorted(byCity), byStaff: sorted(byStaff), byMethod: sorted(byMethod), byPartner: sorted(byPartner),
      products: [...products.values()].sort((a, b) => b.qty - a.qty),
    }
  },
})
