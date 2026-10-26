// Daily dispatch report: what went out with each courier on a day (by the day the order moved to In Transit).
// Same numbers Nuport showed, for the WhatsApp sales update.
import { v } from "convex/values"
import { query } from "./_generated/server"
import { currentStaff } from "./lib"

type Row = { partner: string; orders: number; qty: number; productValue: number; shipping: number; orderValue: number; discount: number; advance: number; due: number }
const empty = (partner: string): Row => ({ partner, orders: 0, qty: 0, productValue: 0, shipping: 0, orderValue: 0, discount: 0, advance: 0, due: 0 })
const r2 = (n: number) => Math.round(n * 100) / 100

export const summary = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    if (!(await currentStaff(ctx))) return null
    const orders = await ctx.db.query("orders").withIndex("by_shipped", (q) => q.gte("shippedAt", from).lte("shippedAt", to)).collect()
    const byPartner = new Map<string, Row>()
    const total = empty("All couriers")
    for (const o of orders) {
      if (o.deletedAt || o.status === "cancelled") continue
      const partner = o.courier === "pickup" ? "Pickup" : o.deliveryPartnerName || (o.courier === "pathao" ? "Pathao" : "Other")
      const row = byPartner.get(partner) ?? empty(partner)
      const itemDiscount = o.items.reduce((t, i) => t + (i.discount ?? 0), 0)
      const add = (x: Row) => {
        x.orders += 1
        x.qty += o.itemCount ?? o.items.reduce((t, i) => t + i.qty, 0)
        x.productValue = r2(x.productValue + o.subtotal)
        x.shipping = r2(x.shipping + o.deliveryFee)
        x.orderValue = r2(x.orderValue + o.subtotal + o.deliveryFee)
        x.discount = r2(x.discount + o.discount + itemDiscount)
        x.advance = r2(x.advance + o.paidAmount)
        x.due = r2(x.due + Math.max(0, o.subtotal + o.deliveryFee - o.discount - itemDiscount - o.paidAmount)) // COD to collect when it went out
      }
      add(row); add(total)
      byPartner.set(partner, row)
    }
    return { partners: [...byPartner.values()].sort((a, b) => b.orders - a.orders), total }
  },
})
