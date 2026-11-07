// Ops -> Shopify order status. The website order in Shopify follows the Ops order:
//   Processing (and later)  -> Shopify order is FULFILLED (customer is not emailed; Pathao tracking number attached)
//   Delivered (due or paid) -> fulfilment marked DELIVERED
//   Delivered & paid (Pathao has paid us) -> Shopify order marked PAID
// Each change is queued (table shopifyOrderSync) and retried every 5 minutes until Shopify accepts it, so a hiccup never loses an order.
// Safe to repeat: it looks at Shopify first and only does what is still missing.
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { notify } from "./lib"
import { shopifyGql } from "./shopifyStock"

const MAX_TRIES = 8
const FULFIL_LEVEL: Record<string, number> = { processing: 1, ready_to_ship: 1, in_transit: 1, delivered_due: 2, delivered_paid: 3 }

/** What still has to be done on Shopify, given the Ops status and what Shopify shows. Pure, so it is easy to test. */
export function planSync(status: string, shop: { cancelled: boolean; financial: string; openFulfilmentOrders: number; fulfilments: { id: string; status: string }[] }) {
  const level = FULFIL_LEVEL[status] ?? 0
  if (!level || shop.cancelled) return { fulfil: false, deliver: [] as string[], pay: false }
  const needFulfil = shop.openFulfilmentOrders > 0
  // fulfilments that already exist (and the one we are about to create) get the delivered mark when Ops says delivered
  const deliver = level >= 2 ? shop.fulfilments.filter((f) => f.status !== "DELIVERED").map((f) => f.id) : []
  const pay = level >= 3 && !["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"].includes(shop.financial)
  return { fulfil: needFulfil, deliver, pay }
}

/** Called after an Ops order changes status: put it in the queue and try straight away. */
export const enqueue = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const o = await ctx.db.get(orderId)
    if (!o || o.source !== "Website" || !o.externalId || !FULFIL_LEVEL[o.status]) return null
    const row = await ctx.db.query("shopifyOrderSync").withIndex("by_order", (q) => q.eq("orderId", orderId)).first()
    if (row) await ctx.db.patch(row._id, { done: false, tries: 0, nextAt: Date.now(), lastError: undefined })
    else await ctx.db.insert("shopifyOrderSync", { orderId, done: false, tries: 0, nextAt: Date.now() })
    await ctx.scheduler.runAfter(2000, internal.shopifyOrders.syncOne, { orderId })
    return true
  },
})

export const load = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const o = await ctx.db.get(orderId)
    if (!o) return null
    return { status: o.status as string, externalId: o.externalId ?? "", consignmentId: o.consignmentId ?? "", courier: o.courier ?? "", invoiceNo: o.invoiceNo }
  },
})

export const mark = internalMutation({
  args: { orderId: v.id("orders"), error: v.optional(v.string()) },
  handler: async (ctx, { orderId, error }) => {
    const row = await ctx.db.query("shopifyOrderSync").withIndex("by_order", (q) => q.eq("orderId", orderId)).first()
    if (!row) return
    if (!error) return void (await ctx.db.patch(row._id, { done: true, lastError: undefined, lastOkAt: Date.now() }))
    const tries = row.tries + 1
    await ctx.db.patch(row._id, { tries, lastError: error.slice(0, 500), nextAt: Date.now() + Math.min(2 ** tries * 5 * 60_000, 6 * 3600_000), done: tries >= MAX_TRIES })
    if (tries === MAX_TRIES) await notify(ctx, "Shopify order not updated", `Ops could not update this order on Shopify after ${MAX_TRIES} tries: ${error.slice(0, 200)}`, orderId, "warning")
  },
})

export const due = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("shopifyOrderSync").withIndex("by_open", (q) => q.eq("done", false).lte("nextAt", Date.now())).take(40)).map((r) => r.orderId),
})

const ORDER_Q = `query($id: ID!){ order(id:$id){ id cancelledAt displayFinancialStatus
  fulfillmentOrders(first:10){ nodes{ id status } }
  fulfillments(first:10){ id displayStatus } } }`

function fail(what: string, errs: any[] | undefined) {
  if (errs?.length) throw new Error(`${what}: ${errs.map((e: any) => e.message).join("; ")}`)
}

/** Bring one Shopify order in line with its Ops order. */
export const syncOne = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    try {
      const o = await ctx.runQuery(internal.shopifyOrders.load, { orderId })
      if (!o || !o.externalId) return await ctx.runMutation(internal.shopifyOrders.mark, { orderId })
      const gid = `gid://shopify/Order/${o.externalId}`
      const d: any = await shopifyGql(ctx, ORDER_Q, { id: gid })
      if (!d?.order) throw new Error("Order not found on Shopify")
      const fos: { id: string; status: string }[] = d.order.fulfillmentOrders.nodes
      const open = fos.filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS")
      const plan = planSync(o.status, {
        cancelled: !!d.order.cancelledAt,
        financial: d.order.displayFinancialStatus,
        openFulfilmentOrders: open.length,
        fulfilments: d.order.fulfillments.map((f: any) => ({ id: f.id, status: f.displayStatus })),
      })
      const deliver = [...plan.deliver]
      if (plan.fulfil) {
        const tracking = o.consignmentId ? { trackingInfo: { number: o.consignmentId, company: o.courier === "pathao" ? "Pathao" : "Courier" } } : {}
        const r: any = await shopifyGql(ctx, `mutation($f: FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id } userErrors{ field message } } }`, {
          f: { notifyCustomer: false, lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), ...tracking },
        })
        fail("Fulfil", r.fulfillmentCreate.userErrors)
        if ((FULFIL_LEVEL[o.status] ?? 0) >= 2 && r.fulfillmentCreate.fulfillment?.id) deliver.push(r.fulfillmentCreate.fulfillment.id)
      }
      for (const fulfillmentId of deliver) {
        const r: any = await shopifyGql(ctx, `mutation($e: FulfillmentEventInput!){ fulfillmentEventCreate(fulfillmentEvent:$e){ fulfillmentEvent{ id } userErrors{ field message } } }`, {
          e: { fulfillmentId, status: "DELIVERED", message: "Delivered (updated from BlackBole Ops)" },
        })
        fail("Mark delivered", r.fulfillmentEventCreate.userErrors)
      }
      if (plan.pay) {
        const r: any = await shopifyGql(ctx, `mutation($i: OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$i){ order{ id } userErrors{ field message } } }`, { i: { id: gid } })
        fail("Mark paid", r.orderMarkAsPaid.userErrors)
      }
      await ctx.runMutation(internal.shopifyOrders.mark, { orderId })
    } catch (e: any) {
      await ctx.runMutation(internal.shopifyOrders.mark, { orderId, error: String(e?.message ?? e) })
    }
  },
})

/** Every 5 minutes: orders whose update to Shopify failed or is still waiting. */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const orderId of await ctx.runQuery(internal.shopifyOrders.due, {})) await ctx.runAction(internal.shopifyOrders.syncOne, { orderId })
  },
})

/** One-time catch-up: website orders from the last 30 days that are already processing / delivered. */
export const backfill = internalMutation({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const since = Date.now() - (days ?? 30) * 86400000
    let n = 0
    for (const status of Object.keys(FULFIL_LEVEL) as (keyof typeof FULFIL_LEVEL)[]) {
      const rows = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", status as any).gte("statusChangedAt", since)).collect()
      for (const o of rows) {
        if (o.source !== "Website" || !o.externalId) continue
        const row = await ctx.db.query("shopifyOrderSync").withIndex("by_order", (q) => q.eq("orderId", o._id)).first()
        if (row) continue
        await ctx.db.insert("shopifyOrderSync", { orderId: o._id as Id<"orders">, done: false, tries: 0, nextAt: Date.now() + n * 3000 })
        n++
      }
    }
    return { queued: n }
  },
})
