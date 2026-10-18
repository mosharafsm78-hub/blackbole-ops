import { v, ConvexError } from "convex/values"
import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { currentStaff, nextCounter, requirePerm } from "./lib"
import { hasPerm } from "./rules"

const DAY = 86400000
const BD = 6 * 3600000
const dayKey = (t: number) => new Date(t + BD).toISOString().slice(0, 10)

async function periodNumbers(ctx: QueryCtx, from: number, to: number, locationId?: Id<"locations">) {
  const delivered = (await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", from).lte("deliveredAt", to)).collect())
    .filter((o) => !o.deletedAt && (o.status === "delivered_due" || o.status === "delivered_paid") && (!locationId || o.locationId === locationId))
  const returned = (await Promise.all(["returned", "pending_returned", "damaged"].map((st) =>
    ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", st as any).gte("statusChangedAt", from).lte("statusChangedAt", to)).collect(),
  ))).flat().filter((o) => !o.deletedAt && (!locationId || o.locationId === locationId))
  const paidReturns = returned.filter((o) => o.paidAmount > 0)

  const salesRevenue = delivered.reduce((s, o) => s + o.total, 0)
  const returnRevenue = paidReturns.reduce((s, o) => s + o.paidAmount, 0)
  const productCost = delivered.reduce((s, o) => s + (o.purchaseCost ?? 0), 0)
  const productUnits = delivered.reduce((s, o) => s + (o.itemCount ?? o.items.reduce((x, i) => x + i.qty, 0)), 0)
  const deliveryCost = [...delivered, ...returned].reduce((s, o) => s + (o.courierCost ?? 0), 0)
  const codCost = delivered.reduce((s, o) => s + (o.codCost ?? 0), 0)
  const otherCost = [...delivered, ...returned].reduce((s, o) => s + (o.otherCost ?? 0), 0)

  const fromMonth = dayKey(from).slice(0, 7), toMonth = dayKey(to).slice(0, 7)
  const expenses = (await ctx.db.query("expenses").collect()).filter(
    (e) => e.status === "paid" && e.month >= fromMonth && e.month <= toMonth && (!locationId || !e.locationId || e.locationId === locationId),
  )
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)
  const revenue = salesRevenue + returnRevenue
  const gross = revenue - productCost - deliveryCost - codCost - otherCost
  return {
    delivered, returned, expenses,
    totals: {
      salesOrders: delivered.length, salesRevenue, paidReturns: paidReturns.length, returnRevenue, revenue,
      productCost, productUnits, deliveryCost, codCost, otherCost, associated: deliveryCost + codCost + otherCost,
      gross, expenses: expenseTotal, net: gross - expenseTotal,
    },
  }
}

export const dashboard = query({
  args: { from: v.number(), to: v.number(), locationId: v.optional(v.id("locations")) },
  handler: async (ctx, { from, to, locationId }) => {
    const s = await currentStaff(ctx)
    if (!s || !hasPerm(s.perms, "accounting.view")) return null
    const cur = await periodNumbers(ctx, from, to, locationId)
    const len = to - from
    const prev = await periodNumbers(ctx, from - len - 1, from - 1, locationId)
    const change = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : Math.round(((a - b) / Math.abs(b)) * 1000) / 10)
    const t = cur.totals, p = prev.totals

    const days = new Map<string, { day: string; revenue: number; gross: number; net: number }>()
    for (let x = from; x <= to; x += DAY) days.set(dayKey(x), { day: dayKey(x), revenue: 0, gross: 0, net: 0 })
    for (const o of cur.delivered) {
      const d = days.get(dayKey(o.deliveredAt!))
      if (!d) continue
      const g = o.total - (o.purchaseCost ?? 0) - (o.courierCost ?? 0) - (o.codCost ?? 0) - (o.otherCost ?? 0)
      d.revenue += o.total; d.gross += g; d.net += g
    }
    const dailyExpense = t.expenses / Math.max(1, days.size)
    for (const d of days.values()) d.net -= dailyExpense

    const heads = new Map<string, number>()
    for (const e of cur.expenses) heads.set(e.head, (heads.get(e.head) ?? 0) + e.amount)

    const products = new Map<string, { name: string; orders: number; units: number; revenue: number; cost: number; other: number }>()
    for (const o of cur.delivered) {
      const share = o.items.reduce((s2, i) => s2 + i.price * i.qty - i.discount, 0) || 1
      const assoc = (o.courierCost ?? 0) + (o.codCost ?? 0) + (o.otherCost ?? 0)
      for (const i of o.items) {
        const key = i.sku
        const row = products.get(key) ?? { name: `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}`, orders: 0, units: 0, revenue: 0, cost: 0, other: 0 }
        const line = i.price * i.qty - i.discount
        row.orders += 1; row.units += i.qty; row.revenue += line
        row.other += assoc * (line / share)
        products.set(key, row)
      }
    }
    // purchase cost per line from the variant cost at the time (approximation from order total cost share)
    for (const o of cur.delivered) {
      const share = o.items.reduce((s2, i) => s2 + i.price * i.qty - i.discount, 0) || 1
      for (const i of o.items) {
        const row = products.get(i.sku)!
        row.cost += (o.purchaseCost ?? 0) * ((i.price * i.qty - i.discount) / share)
      }
    }
    const topProducts = [...products.entries()].map(([sku, r]) => {
      const gross = r.revenue - r.cost - r.other
      return { sku, ...r, gross, margin: r.revenue ? Math.round((gross / r.revenue) * 10000) / 100 : 0 }
    }).sort((a, b) => b.gross - a.gross).slice(0, 10)

    return {
      totals: t,
      change: {
        revenue: change(t.revenue, p.revenue), productCost: change(t.productCost, p.productCost), associated: change(t.associated, p.associated),
        gross: change(t.gross, p.gross), expenses: change(t.expenses, p.expenses), net: change(t.net, p.net),
      },
      daily: [...days.values()],
      expenseHeads: [...heads.entries()].map(([head, amount]) => ({ head, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10),
      topProducts,
    }
  },
})

// ---------------- Expenses ----------------
export const listExpenses = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = await ctx.db.query("expenses").withIndex("by_month", (q) => q.eq("month", month)).collect()
    const locs = await ctx.db.query("locations").collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt).map((e) => ({ ...e, locationName: locs.find((l) => l._id === e.locationId)?.name ?? "" }))
  },
})

export const saveExpense = mutation({
  args: {
    id: v.optional(v.id("expenses")),
    head: v.string(),
    amount: v.number(),
    month: v.string(),
    locationId: v.optional(v.id("locations")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "expenses.request")
    if (a.amount <= 0) throw new ConvexError("Amount must be more than 0")
    if (a.id) {
      const e = await ctx.db.get(a.id)
      if (e && e.status !== "requested" && !hasPerm(me.perms, "expenses.approve")) throw new ConvexError("Only requested expenses can be edited")
      await ctx.db.patch(a.id, { head: a.head, amount: a.amount, month: a.month, locationId: a.locationId, note: a.note, updatedAt: Date.now() })
      return a.id
    }
    const code = await nextCounter(ctx, "expense", 1)
    return await ctx.db.insert("expenses", {
      code, head: a.head, amount: a.amount, month: a.month, locationId: a.locationId, note: a.note,
      status: "requested", requestedBy: me.staff.name, createdAt: Date.now(), updatedAt: Date.now(),
    })
  },
})

export const setExpenseStatus = mutation({
  args: { id: v.id("expenses"), status: v.union(v.literal("requested"), v.literal("approved"), v.literal("paid"), v.literal("refused")) },
  handler: async (ctx, { id, status }) => {
    const me = await requirePerm(ctx, "expenses.approve")
    await ctx.db.patch(id, { status, decidedBy: me.staff.name, updatedAt: Date.now() })
  },
})

export const deleteExpense = mutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    const me = await requirePerm(ctx, "expenses.request")
    const e = await ctx.db.get(id)
    if (!e) return
    if (e.status !== "requested" && !hasPerm(me.perms, "expenses.approve")) throw new ConvexError("Only requested expenses can be deleted")
    await ctx.db.delete(id)
  },
})

export type _Unused = Doc<"orders">
