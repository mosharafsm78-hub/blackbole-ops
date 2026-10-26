// Daily dispatch report: what went out on a day (by the day the order moved to In Transit).
// Four reports, like Nuport: BlackBole Chittagong, BlackBole Dhaka, and the two exchange reports.
// The courier is not chosen — it is whatever courier that warehouse's parcels went with.
import { v } from "convex/values"
import { query } from "./_generated/server"
import { currentStaff } from "./lib"

type Row = { orders: number; qty: number; productValue: number; shipping: number; orderValue: number; discount: number; advance: number; due: number }
const empty = (): Row => ({ orders: 0, qty: 0, productValue: 0, shipping: 0, orderValue: 0, discount: 0, advance: 0, due: 0 })
const r2 = (n: number) => Math.round(n * 100) / 100

const REPORTS = [
  { key: "ctg", name: "BlackBole Chittagong" },
  { key: "dhaka", name: "BlackBole Dhaka" },
  { key: "ctg_ex", name: "BlackBole CTG Exchange" },
  { key: "dhaka_ex", name: "BlackBole Dhaka Exchange" },
] as const

export const summary = query({
  args: { from: v.number(), to: v.number(), report: v.optional(v.string()) },
  handler: async (ctx, { from, to, report }) => {
    if (!(await currentStaff(ctx))) return null
    const orders = await ctx.db.query("orders").withIndex("by_shipped", (q) => q.gte("shippedAt", from).lte("shippedAt", to)).collect()
    const locs = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l]))
    const counts: Record<string, number> = { ctg: 0, dhaka: 0, ctg_ex: 0, dhaka_ex: 0 }
    const total = empty()
    const partners = new Map<string, number>()
    const codes: { id: string; invoiceNo: number; partner: string }[] = []
    for (const o of orders) {
      if (o.deletedAt || o.status === "cancelled") continue
      const loc = locs.get(o.locationId)
      const city = /dhaka|dhk/i.test(loc?.name ?? "") ? "dhaka" : "ctg"
      const key = o.isExchange || loc?.noCourier ? `${city}_ex` : city
      counts[key]++
      if (report && report !== "all" && report !== key) continue
      const p = o.courier === "pickup" ? "Pickup" : o.deliveryPartnerName || (o.courier === "pathao" ? "Pathao" : "Other")
      partners.set(p, (partners.get(p) ?? 0) + 1)
      codes.push({ id: o._id, invoiceNo: o.invoiceNo, partner: p })
      const itemDiscount = o.items.reduce((t, i) => t + (i.discount ?? 0), 0)
      total.orders += 1
      total.qty += o.itemCount ?? o.items.reduce((t, i) => t + i.qty, 0)
      total.productValue = r2(total.productValue + o.subtotal)
      total.shipping = r2(total.shipping + o.deliveryFee)
      total.orderValue = r2(total.orderValue + o.subtotal + o.deliveryFee)
      total.discount = r2(total.discount + o.discount + itemDiscount)
      total.advance = r2(total.advance + o.paidAmount)
      total.due = r2(total.due + Math.max(0, o.subtotal + o.deliveryFee - o.discount - itemDiscount - o.paidAmount)) // COD to collect when it went out
    }
    return {
      total,
      reports: REPORTS.map((r) => ({ ...r, orders: counts[r.key] })),
      partners: [...partners.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
      codes: codes.sort((a, b) => a.invoiceNo - b.invoiceNo),
    }
  },
})
