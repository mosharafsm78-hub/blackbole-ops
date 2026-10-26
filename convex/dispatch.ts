// Daily dispatch report: what went out on a day (by the day the order moved to In Transit),
// per warehouse and courier. Same numbers Nuport showed, for the WhatsApp sales update.
import { v } from "convex/values"
import { query } from "./_generated/server"
import { currentStaff } from "./lib"

type Row = { orders: number; qty: number; productValue: number; shipping: number; orderValue: number; discount: number; advance: number; due: number }
const empty = (): Row => ({ orders: 0, qty: 0, productValue: 0, shipping: 0, orderValue: 0, discount: 0, advance: 0, due: 0 })
const r2 = (n: number) => Math.round(n * 100) / 100

export const summary = query({
  args: { from: v.number(), to: v.number(), locationId: v.optional(v.id("locations")), partner: v.optional(v.string()) },
  handler: async (ctx, { from, to, locationId, partner }) => {
    if (!(await currentStaff(ctx))) return null
    const orders = await ctx.db.query("orders").withIndex("by_shipped", (q) => q.gte("shippedAt", from).lte("shippedAt", to)).collect()
    const locs = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
    const total = empty()
    const warehouses = new Map<string, { id: string; name: string; orders: number }>()
    const partners = new Map<string, number>()
    for (const o of orders) {
      if (o.deletedAt || o.status === "cancelled") continue
      const p = o.courier === "pickup" ? "Pickup" : o.deliveryPartnerName || (o.courier === "pathao" ? "Pathao" : "Other")
      // lists for the pickers (each list respects the other choice)
      if (!partner || partner === p) {
        const w = warehouses.get(o.locationId) ?? { id: o.locationId, name: locs.get(o.locationId) ?? "Warehouse", orders: 0 }
        w.orders++; warehouses.set(o.locationId, w)
      }
      if (!locationId || locationId === o.locationId) partners.set(p, (partners.get(p) ?? 0) + 1)
      if (locationId && o.locationId !== locationId) continue
      if (partner && p !== partner) continue
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
      warehouses: [...warehouses.values()].sort((a, b) => b.orders - a.orders),
      partners: [...partners.entries()].map(([name, n]) => ({ name, orders: n })).sort((a, b) => b.orders - a.orders),
      allWarehouses: [...locs.entries()].map(([id, name]) => ({ id, name })),
    }
  },
})
