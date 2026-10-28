import { v, ConvexError } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import { internal } from "./_generated/api"
import { closeCodLead } from "./checkouts"
import { internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { orderItem, orderStatus } from "./schema"
import { statsForPhone } from "./customerStats"
import {
  computePurchaseCost, currentStaff, defaultLocation, defaultPartner, emitOrderEvent, getSetting, invoiceLabel, logOrder,
  hasPreOrderItem, moveOrderStock, preOrderOrigin, nextCounter, notify, pathaoBookAt, requirePerm,
} from "./lib"
import {
  CSAT_FOLLOWUP_OUTCOMES, EXCHANGE_SUBS, STATUS_BUCKET, STATUS_LABEL, STATUS_TABS, TRANSITIONS, canTransition, hasPerm, isRealReason, moveKey, normalizePhone, orderTotals,
  type OrderStatus,
  ALL_MOVE_KEYS, PRE_ORDER_STATUS,
} from "./rules"

// ---------- status counters (cheap tab counts) ----------
export async function bumpStatusCount(ctx: MutationCtx, status: string, delta: number) {
  const name = `st:${status}`
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()
  if (row) await ctx.db.patch(row._id, { value: row.value + delta })
  else await ctx.db.insert("counters", { name, value: delta })
}

const isDelivered = (s: OrderStatus) => s === "delivered_due" || s === "delivered_paid"
const isFlagged = (s: OrderStatus) => s === "pending_returned" || s === "returned" || s === "damaged"
const OPEN: OrderStatus[] = ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship"]

async function updateCustomerStats(ctx: MutationCtx, order: Doc<"orders">, from: OrderStatus, to: OrderStatus) {
  const c = await ctx.db.get(order.customerId)
  if (!c) return
  const patch: Partial<Doc<"customers">> = {}
  if (!isDelivered(from) && isDelivered(to)) {
    patch.deliveredCount = c.deliveredCount + 1
    patch.totalSpent = c.totalSpent + order.total
    if (c.tag === "NEW") patch.tag = "REGULAR"
  }
  if (isDelivered(from) && isFlagged(to)) {
    patch.deliveredCount = Math.max(0, c.deliveredCount - 1)
    patch.totalSpent = Math.max(0, c.totalSpent - order.total)
  }
  if (!isFlagged(from) && isFlagged(to)) patch.returnedCount = c.returnedCount + 1
  if (to === "cancelled") patch.cancelledCount = c.cancelledCount + 1
  if (from === "cancelled") patch.cancelledCount = Math.max(0, c.cancelledCount - 1)
  if (Object.keys(patch).length) await ctx.db.patch(c._id, patch)
}

async function isBlocked(ctx: QueryCtx, phone: string, ip?: string) {
  const p = await ctx.db.query("blocks").withIndex("by_value", (q) => q.eq("kind", "phone").eq("value", phone)).first()
  if (p?.active) return `Phone ${phone} is on the block list${p.reason ? ` (${p.reason})` : ""}`
  if (ip) {
    const i = await ctx.db.query("blocks").withIndex("by_value", (q) => q.eq("kind", "ip").eq("value", ip)).first()
    if (i?.active) return `IP ${ip} is on the block list${i.reason ? ` (${i.reason})` : ""}`
  }
  return null
}

// ---------- shared create used by the UI, uploads and Shopify ----------
export type NewOrder = {
  source: string
  externalId?: string
  externalName?: string
  customerName: string
  phone: string
  email?: string
  address: string
  cityName?: string
  pathaoCityId?: number
  pathaoZoneId?: number
  pathaoAreaId?: number
  zoneName?: string
  areaName?: string
  locationId?: Id<"locations">
  deliveryPartnerId?: Id<"deliveryPartners">
  deliveryType: string
  items: Doc<"orders">["items"]
  discount: number
  deliveryFee: number
  advance?: { amount: number; method: string; reference?: string; kind?: string }
  paymentMethod?: string
  customerNote?: string
  additionalInfo?: string
  status?: OrderStatus
  ipAddress?: string
  origin?: string
  campaignId?: string
  followUpAt?: number
  isExchange?: boolean
  exchangeOfId?: Id<"orders">
  hasUpsell?: boolean
}

export async function insertOrder(ctx: MutationCtx, o: NewOrder, byName: string, opts: { allowBlocked?: boolean } = {}) {
  const phone = normalizePhone(o.phone)
  if (!/^01\d{9}$/.test(phone)) throw new ConvexError(`Phone number looks wrong: ${o.phone}`)
  if (o.items.length === 0) throw new ConvexError("Add at least one product")
  const blocked = await isBlocked(ctx, phone, o.ipAddress)
  if (blocked && !opts.allowBlocked) throw new ConvexError(blocked)
  const location = o.locationId ? await ctx.db.get(o.locationId) : await defaultLocation(ctx)
  if (!location) throw new ConvexError("Add a warehouse in Settings first")

  let customer = await ctx.db.query("customers").withIndex("by_phone", (q) => q.eq("phone", phone)).unique()
  const now = Date.now()
  if (!customer) {
    const code = await nextCounter(ctx, "customer", 10001)
    const id = await ctx.db.insert("customers", {
      code, name: o.customerName.trim() || "Customer", phone, email: o.email, address: o.address, city: o.cityName,
      tag: "NEW", source: o.source, orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0,
      customerType: "E-Commerce Customer", smsCount: 0, createdAt: now,
    })
    customer = (await ctx.db.get(id))!
  }
  await ctx.db.patch(customer._id, {
    orderCount: customer.orderCount + 1,
    lastOrderAt: now,
    address: o.address || customer.address,
    email: o.email || customer.email,
    city: o.cityName || customer.city,
  })

  const noCourier = !!location.noCourier // exchange warehouse: never sent to Pathao
  const partner = noCourier ? null : o.deliveryPartnerId ? await ctx.db.get(o.deliveryPartnerId) : o.deliveryType === "pickup" ? null : await defaultPartner(ctx, location._id)
  const start = (await getSetting<number>(ctx, "invoiceStart")) ?? 20001
  const invoiceNo = await nextCounter(ctx, "invoice", start)
  const paid = o.advance?.amount ?? 0
  const t = orderTotals(o.items, o.discount, o.deliveryFee, paid)
  let status: OrderStatus = o.status ?? "pending"
  if (blocked) status = "cancelled"
  const poFrom = await preOrderOrigin(ctx, o.items)
  const preOrder = poFrom !== null
  if (poFrom && status === "approved") status = PRE_ORDER_STATUS[poFrom] // product not in hand yet: wait in Pre-Order (China / Bangladesh)
  const orderId = await ctx.db.insert("orders", {
    invoiceNo, status, source: o.source, externalId: o.externalId, externalName: o.externalName,
    customerId: customer._id, customerName: o.customerName.trim() || customer.name, phone, email: o.email,
    address: o.address, cityName: o.cityName, pathaoCityId: o.pathaoCityId, pathaoZoneId: o.pathaoZoneId,
    pathaoAreaId: o.pathaoAreaId, zoneName: o.zoneName, areaName: o.areaName, locationId: location._id,
    deliveryType: o.deliveryType, items: o.items, subtotal: t.subtotal, discount: o.discount, deliveryFee: o.deliveryFee,
    paidAmount: paid, total: t.total, due: t.due, paymentMethod: o.paymentMethod ?? (paid > 0 && t.due === 0 ? o.advance!.method : "Cash On Delivery"),
    courier: o.deliveryType === "pickup" ? "pickup" : !noCourier && partner?.provider === "pathao" ? "pathao" : "manual",
    deliveryPartnerId: partner?._id, deliveryPartnerName: noCourier ? "Exchange — not sent to Pathao" : partner?.name,
    customerNote: o.customerNote, additionalInfo: o.additionalInfo,
    callCount: 0, createdByName: byName, createdAt: now, updatedAt: now, statusChangedAt: now,
    reason: blocked ?? undefined,
    ipAddress: o.ipAddress, origin: o.origin, campaignId: o.campaignId, followUpAt: o.followUpAt,
    isExchange: o.isExchange || noCourier || undefined, exchangeOfId: o.exchangeOfId,
    noteCount: 0, itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    hasUpsell: o.hasUpsell ?? o.source === "Up Sell",
    purchaseCost: await computePurchaseCost(ctx, o.items),
    preOrder: preOrder || undefined,
    preOrderFrom: poFrom ?? undefined,
  })
  await bumpStatusCount(ctx, status, 1)
  if (noCourier) await logOrder(ctx, orderId, `Exchange warehouse (${location.name}) — this order is NOT sent to Pathao`, byName)
  if (!noCourier && !o.pathaoCityId && o.deliveryType !== "pickup" && partner?.provider === "pathao" && o.address.trim().length >= 10) {
    await ctx.scheduler.runAfter(0, internal.pathao.autoPlace, { orderId })
  }
  if (paid > 0) {
    await ctx.db.insert("payments", { orderId, method: o.advance!.method, amount: paid, reference: o.advance!.reference, byName, at: now })
    const kind = o.advance!.kind === "delivery" ? " (delivery charge)" : o.advance!.kind === "full" ? " (full payment)" : ""
    await logOrder(ctx, orderId, `Advance ৳${paid}${kind} received via ${o.advance!.method}${o.advance!.reference ? ` — TrxID ${o.advance!.reference}` : ""}`, byName)
  }
  await logOrder(ctx, orderId, `Order created by ${byName} from ${o.source}${o.externalName ? ` (${o.externalName})` : ""}`, byName)
  await closeCodLead(ctx, phone, orderId) // the customer's COD-form lead (if any) is now an order
  if (blocked) await logOrder(ctx, orderId, `Auto-cancelled: ${blocked}`, "System")
  if (STATUS_BUCKET[status] !== "available") {
    const order = (await ctx.db.get(orderId))!
    await moveOrderStock(ctx, order, "pending", status, byName)
  }
  await notify(ctx, "New order", `Order BB-${invoiceNo} from ${o.source} — ${o.customerName}`, orderId)
  await emitOrderEvent(ctx, orderId, status)
  return { orderId, invoiceNo }
}

const itemsInput = v.array(
  v.object({ variantId: v.id("variants"), qty: v.number(), price: v.number(), discount: v.number() }),
)

export async function buildItems(ctx: MutationCtx, items: { variantId: Id<"variants">; qty: number; price: number; discount: number }[]) {
  const out: Doc<"orders">["items"] = []
  for (const i of items) {
    if (i.qty <= 0) continue
    const vr = await ctx.db.get(i.variantId)
    if (!vr) throw new ConvexError("A product in the cart no longer exists")
    const p = await ctx.db.get(vr.productId)
    out.push({
      variantId: vr._id, sku: vr.sku, name: p?.name ?? vr.sku, attrs: vr.title, imageUrl: vr.imageUrl ?? p?.imageUrl,
      price: i.price, qty: i.qty, discount: i.discount, weightKg: vr.weightKg,
    })
  }
  return out
}

const addressFields = {
  customerName: v.string(),
  phone: v.string(),
  email: v.optional(v.string()),
  address: v.string(),
  cityName: v.optional(v.string()),
  pathaoCityId: v.optional(v.number()),
  pathaoZoneId: v.optional(v.number()),
  pathaoAreaId: v.optional(v.number()),
  zoneName: v.optional(v.string()),
  areaName: v.optional(v.string()),
}

export const create = mutation({
  args: {
    source: v.string(),
    ...addressFields,
    locationId: v.id("locations"),
    deliveryPartnerId: v.optional(v.id("deliveryPartners")),
    deliveryType: v.string(),
    items: itemsInput,
    discount: v.number(),
    deliveryFee: v.number(),
    advanceAmount: v.number(),
    advanceMethod: v.string(),
    advanceReference: v.optional(v.string()),
    advanceKind: v.optional(v.string()), // delivery | full | custom
    paymentMethod: v.optional(v.string()),
    customerNote: v.optional(v.string()),
    additionalInfo: v.optional(v.string()),
    followUpAt: v.optional(v.number()),
    approve: v.boolean(),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.create")
    if (a.approve && !hasPerm(me.perms, moveKey("pending", "approved"))) throw new ConvexError("You can't create approved orders")
    const items = await buildItems(ctx, a.items)
    const { advanceAmount, advanceMethod, advanceReference, advanceKind, approve, ...rest } = a
    return await insertOrder(ctx, {
      ...rest, items,
      advance: advanceAmount > 0 ? { amount: advanceAmount, method: advanceMethod, reference: advanceReference?.trim() || undefined, kind: advanceKind } : undefined,
      status: approve ? "approved" : "pending",
    }, me.staff.name)
  },
})

// ---------- lists ----------
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = await ctx.db.query("counters").collect()
    const get = (st: string) => rows.find((r) => r.name === `st:${st}`)?.value ?? 0
    const out: Record<string, number> = {}
    let all = 0
    for (const tab of STATUS_TABS) {
      out[tab.key] = tab.statuses.reduce((sum, st) => sum + get(st), 0)
      all += out[tab.key]
      for (const st of tab.statuses) out[`st:${st}`] = get(st) // sub-tabs (Payment Due / Collected, Pending Returned / Returned / Damaged)
    }
    out.all = all
    // Exchange tab (any status): exchange orders still open + the last ones finished
    const ex = (await ctx.db.query("orders").withIndex("by_exchange", (q) => q.eq("isExchange", true)).order("desc").take(1000)).filter((o) => !o.deletedAt)
    out.exchange = ex.length
    for (const sub of EXCHANGE_SUBS) out[`ex:${sub.key}`] = ex.filter((o) => sub.statuses.includes(o.status as OrderStatus)).length
    return out
  },
})

/** How far back the urgency panel reaches for feedback-calls/return-reasons — calling a customer about an
 *  order from months ago isn't realistic, so old unresolved ones just age out of this count instead of
 *  piling up forever. (Older orders are still there and still visible via the Orders list filters.) */
const URGENCY_WINDOW_DAYS = 45

/** Dashboard urgency numbers — the whole point is that a supervisor feels pressure from a number, not a mood.
 *  Pending orders reuses the same counter as the queue cards above; the other three scan the relevant status
 *  buckets directly (bounded to the last URGENCY_WINDOW_DAYS by createdAt, via the by_status index) since they
 *  depend on fields (csat, reason) the precomputed counters don't track. */
export const urgency = query({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx, "dashboard.view")
    void s
    const rows = await ctx.db.query("counters").collect()
    const get = (st: string) => rows.find((r) => r.name === `st:${st}`)?.value ?? 0
    const pendingOrders = get("pending")
    const now = Date.now()
    const since = now - URGENCY_WINDOW_DAYS * 86400000

    const delivered = (
      await Promise.all(
        (["delivered_due", "delivered_paid"] as const).map((st) =>
          ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st).gte("createdAt", since)).take(5000),
        ),
      )
    ).flat().filter((o) => !o.deletedAt)
    const feedbackPending = delivered.filter((o) => !o.csat).length
    const feedbackFollowUp = delivered.filter((o) => o.csatFollowUpAt && o.csatFollowUpAt <= now).length

    const returnLike = (
      await Promise.all(
        (["pending_returned", "returned", "damaged"] as const).map((st) =>
          ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st).gte("createdAt", since)).take(5000),
        ),
      )
    ).flat().filter((o) => !o.deletedAt)
    const reasonsPending = returnLike.filter((o) => !isRealReason(o.reason)).length

    return { pendingOrders, feedbackPending, feedbackFollowUp, reasonsPending }
  },
})

const filterArgs = v.object({
  tab: v.string(),
  sources: v.optional(v.array(v.string())),
  deliveryTypes: v.optional(v.array(v.string())),
  statuses: v.optional(v.array(v.string())),
  dateField: v.optional(v.string()), // createdAt | shippingDate | statusChangedAt
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  invoiceFrom: v.optional(v.number()),
  invoiceTo: v.optional(v.number()),
  valueMin: v.optional(v.number()),
  valueMax: v.optional(v.number()),
  qtyMin: v.optional(v.number()),
  qtyMax: v.optional(v.number()),
  partnerIds: v.optional(v.array(v.string())),
  courierStatuses: v.optional(v.array(v.string())),
  locationIds: v.optional(v.array(v.string())),
  createdBy: v.optional(v.string()),
  paid: v.optional(v.boolean()),
  hasNotes: v.optional(v.boolean()),
  hasDiscount: v.optional(v.boolean()),
  hasUpsell: v.optional(v.boolean()),
  hasAdvance: v.optional(v.boolean()),
  printed: v.optional(v.boolean()),
  hasInfo: v.optional(v.boolean()),
  flag: v.optional(v.string()), // nocall | courierError | followUp | exchange
  customerTags: v.optional(v.array(v.string())),
})

type Filters = typeof filterArgs.type

function matches(o: Doc<"orders">, f: Filters, tagOf?: Map<string, string>, openByPhone?: Map<string, number>) {
  if (o.deletedAt) return false
  const tab = STATUS_TABS.find((t) => t.key === f.tab)
  if (tab && !tab.statuses.includes(o.status as OrderStatus)) return false
  if (f.statuses?.length && !f.statuses.includes(o.status)) return false
  if (f.sources?.length && !f.sources.includes(o.source)) return false
  if (f.deliveryTypes?.length && !f.deliveryTypes.includes(o.deliveryType)) return false
  const field = (f.dateField ?? "createdAt") as "createdAt" | "shippingDate" | "statusChangedAt"
  const dv = (o as any)[field] as number | undefined
  if (f.from && (!dv || dv < f.from)) return false
  if (f.to && (!dv || dv > f.to)) return false
  if (f.invoiceFrom && o.invoiceNo < f.invoiceFrom) return false
  if (f.invoiceTo && o.invoiceNo > f.invoiceTo) return false
  if (f.valueMin !== undefined && o.total < f.valueMin) return false
  if (f.valueMax !== undefined && o.total > f.valueMax) return false
  const qty = o.itemCount ?? o.items.reduce((s, i) => s + i.qty, 0)
  if (f.qtyMin !== undefined && qty < f.qtyMin) return false
  if (f.qtyMax !== undefined && qty > f.qtyMax) return false
  if (f.partnerIds?.length && !f.partnerIds.includes(o.deliveryPartnerId ?? "")) return false
  if (f.courierStatuses?.length && !f.courierStatuses.includes(o.courierStatus ?? "")) return false
  if (f.locationIds?.length && !f.locationIds.includes(o.locationId)) return false
  if (f.createdBy && o.createdByName.trim() !== f.createdBy) return false
  if (f.paid !== undefined && (o.due === 0) !== f.paid) return false
  if (f.hasNotes !== undefined && ((o.noteCount ?? 0) > 0) !== f.hasNotes) return false
  const disc = o.discount + o.items.reduce((s, i) => s + i.discount, 0)
  if (f.hasDiscount !== undefined && (disc > 0) !== f.hasDiscount) return false
  if (f.hasUpsell !== undefined && !!o.hasUpsell !== f.hasUpsell) return false
  if (f.hasAdvance !== undefined && (o.paidAmount > 0 && !isDelivered(o.status as OrderStatus)) !== f.hasAdvance) return false
  if (f.printed !== undefined && !!o.printedAt !== f.printed) return false
  if (f.hasInfo !== undefined && !!(o.additionalInfo || o.customerNote) !== f.hasInfo) return false
  if (f.flag === "nocall" && o.callCount > 0) return false
  if (f.flag === "unprinted" && o.printedAt) return false
  // same phone has more than one open order (Nuport's "Multiple orders with the same phone number")
  if (f.flag === "duplicate" && openByPhone && !((openByPhone.get(o.phone) ?? 0) - (OPEN.includes(o.status as OrderStatus) ? 1 : 0) > 0)) return false
  if (f.flag === "courierError" && !o.courierError) return false
  // due today (Dhaka time) or overdue
  if (f.flag === "followUp" && !(o.followUpAt && o.followUpAt < Math.floor((Date.now() + 6 * 3600000) / 86400000 + 1) * 86400000 - 6 * 3600000)) return false
  if (f.flag === "exchange" && !o.isExchange) return false
  if (f.flag === "wantsCancel" && !(o.autoCall?.result === "cancel" && o.status === "pending")) return false
  // delivered, but nobody has done the post-delivery feedback call yet
  if (f.flag === "needsFeedback" && !(isDelivered(o.status as OrderStatus) && !o.csat)) return false
  // feedback call due today (Dhaka time) or overdue — mirrors the "followUp" flag above
  if (f.flag === "csatFollowUp" && !(o.csatFollowUpAt && o.csatFollowUpAt < Math.floor((Date.now() + 6 * 3600000) / 86400000 + 1) * 86400000 - 6 * 3600000)) return false
  // returned / damaged / pending-returned with no reason logged — the fulfillment-quality data point is missing
  if (f.flag === "needsReason" && !(isFlagged(o.status as OrderStatus) && !isRealReason(o.reason))) return false
  if (f.customerTags?.length && tagOf && !f.customerTags.includes(tagOf.get(o.customerId) ?? "")) return false
  return true
}

/** How many open orders each phone number has right now. */
async function openOrdersByPhone(ctx: QueryCtx) {
  const map = new Map<string, number>()
  for (const st of OPEN) {
    for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()) {
      if (!o.deletedAt) map.set(o.phone, (map.get(o.phone) ?? 0) + 1)
    }
  }
  return map
}

/** Count for the "Multiple orders with the same phone number" button on a tab. */
export const sameNumberCount = query({
  args: { tab: v.string() },
  handler: async (ctx, { tab }) => {
    const s = await currentStaff(ctx)
    if (!s) return 0
    const t = STATUS_TABS.find((x) => x.key === tab)
    const statuses = (t ? t.statuses : OPEN) as OrderStatus[]
    if (!statuses.every((st) => OPEN.includes(st))) return null // only for open-order tabs
    const map = await openOrdersByPhone(ctx)
    let n = 0
    for (const st of statuses) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()) {
        if (!o.deletedAt && (map.get(o.phone) ?? 0) > 1) n++
      }
    }
    return n
  },
})

async function withDupes(ctx: QueryCtx, page: Doc<"orders">[]) {
  const locs = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
  return await Promise.all(
    page.map(async (o) => {
      const same = await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", o.phone)).take(30)
      const dupes = same.filter((x) => x._id !== o._id && !x.deletedAt && OPEN.includes(x.status as OrderStatus)).length
      const c = await ctx.db.get(o.customerId)
      return { ...o, dupes, customerTag: c?.tag ?? "NEW", customerOrders: c?.orderCount ?? 1, locationName: locs.get(o.locationId) ?? "" }
    }),
  )
}

/** Adds the "other open orders from this number" count for screen-sized lists (not for big CSV exports). */
async function dupesIfSmall(ctx: QueryCtx, rows: Doc<"orders">[], limit: number): Promise<(Doc<"orders"> & { dupes?: number; locationName?: string })[]> {
  return limit <= 300 ? await withDupes(ctx, rows) : rows
}

/** Non-paginated list (up to 2000) with the same filters — used for CSV export and summary. */
export const list = query({
  args: {
    tab: v.string(),
    search: v.optional(v.string()),
    source: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    flag: v.optional(v.string()),
    location: v.optional(v.string()),
    status: v.optional(v.string()), // one status inside the tab (sub-tab)
    limit: v.number(),
    filters: v.optional(filterArgs),
  },
  handler: async (ctx, a) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const f: Filters = a.filters ?? { tab: a.tab, sources: a.source ? [a.source] : undefined, from: a.from, to: a.to, flag: a.flag, locationIds: a.location ? [a.location] : undefined, statuses: a.status ? [a.status] : undefined }
    const limit = Math.min(a.limit, 2000)
    // Search box: look the order up directly (invoice, phone, consignment, name…), across every status.
    if (a.search?.trim()) {
      const found = await findOrders(ctx, a.search)
      return { rows: await dupesIfSmall(ctx, found.slice(0, limit), limit), hasMore: false }
    }
    if (f.tab === "exchange") {
      // Exchange tab: every exchange order, any status (newest first), other filters still apply
      const ex = (await ctx.db.query("orders").withIndex("by_exchange", (q) => q.eq("isExchange", true)).order("desc").take(3000))
        .filter((o) => {
          const sub = EXCHANGE_SUBS.find((x) => `ex:${x.key}` === f.statuses?.[0])
          return matches(o, { ...f, tab: "all", statuses: undefined }) && (!sub || sub.statuses.includes(o.status as OrderStatus))
        })
      return { rows: await dupesIfSmall(ctx, ex.slice(0, limit), limit), hasMore: ex.length > limit }
    }
    const tab = STATUS_TABS.find((t) => t.key === f.tab)
    let rows: Doc<"orders">[] = []
    // Fast path: plain tab with no extra filters — read only the newest `limit` orders, not thousands.
    const { tab: _t, ...extra } = f
    const plain = Object.values(extra).every((x) => x === undefined || (Array.isArray(x) && x.length === 0))
    // Sub-tab (e.g. Delivered → Payment Due) with no other filters: newest orders of that one status from the index
    const oneStatus = f.statuses?.length === 1 && Object.entries(extra).every(([k, x]) => k === "statuses" || x === undefined || (Array.isArray(x) && x.length === 0))
    if (oneStatus) {
      rows = (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", f.statuses![0] as OrderStatus)).order("desc").take(limit + 25)).filter((o) => !o.deletedAt).sort((x, y) => y.createdAt - x.createdAt)
      return { rows: await dupesIfSmall(ctx, rows.slice(0, limit), limit), hasMore: rows.length > limit }
    }
    if (plain) {
      const take = limit + 25 // a little extra to cover deleted orders
      if (tab) for (const st of tab.statuses) rows.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).order("desc").take(take)))
      else rows = await ctx.db.query("orders").withIndex("by_created").order("desc").take(take)
      rows = rows.filter((o) => !o.deletedAt).sort((x, y) => y.createdAt - x.createdAt)
      return { rows: await dupesIfSmall(ctx, rows.slice(0, limit), limit), hasMore: rows.length > limit }
    }
    if (f.from && (f.dateField ?? "createdAt") === "createdAt") {
      rows = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", f.from!).lte("createdAt", f.to ?? Date.now() + 86400000)).order("desc").take(6000)
    } else if (tab) {
      for (const st of tab.statuses) rows.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).order("desc").take(3000)))
    } else {
      rows = await ctx.db.query("orders").withIndex("by_created").order("desc").take(3000)
    }
    const tagOf = f.customerTags?.length ? new Map((await ctx.db.query("customers").collect()).map((c) => [c._id as string, c.tag])) : undefined
    const openByPhone = f.flag === "duplicate" ? await openOrdersByPhone(ctx) : undefined
    rows = rows.filter((o) => matches(o, f, tagOf, openByPhone)).sort((x, y) => y.createdAt - x.createdAt)
    if (f.flag === "duplicate") rows.sort((x, y) => x.phone.localeCompare(y.phone) || y.createdAt - x.createdAt) // same numbers next to each other
    return { rows: await dupesIfSmall(ctx, rows.slice(0, limit), limit), hasMore: rows.length > limit }
  },
})

/** Paginated order queue with Nuport's full filter set. */
export const queue = query({
  args: { filters: filterArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { filters, paginationOpts }) => {
    const s = await currentStaff(ctx)
    if (!s) return { page: [], isDone: true, continueCursor: "" }
    const tab = STATUS_TABS.find((t) => t.key === filters.tab)
    const base =
      tab && tab.statuses.length === 1
        ? ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", tab.statuses[0]))
        : ctx.db.query("orders").withIndex("by_created")
    const tagOf = filters.customerTags?.length ? new Map<string, string>() : undefined
    if (tagOf) {
      for (const c of await ctx.db.query("customers").collect()) tagOf.set(c._id, c.tag)
    }
    // Cheap index-side filters; the rest run per document.
    const result = await base
      .order("desc")
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .paginate(paginationOpts)
    const page = result.page.filter((o) => matches(o, filters, tagOf))
    return { ...result, page: await withDupes(ctx, page) }
  },
})

/** Direct lookup: invoice, phone, name, consignment, website order no, SKU. */
async function findOrders(ctx: QueryCtx, term: string) {
  const t = term.trim()
  if (!t) return []
  let rows: Doc<"orders">[] = []
  const phone = normalizePhone(t)
  const num = Number(t.replace(/^bb-?/i, "").replace(/^#/, ""))
  if (/^01\d{9}$/.test(phone)) rows = await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", phone)).collect()
  else if (/^so-?\d+$/i.test(t)) rows = await ctx.db.query("orders").withIndex("by_invoice_code", (q) => q.eq("invoiceCode", t.toUpperCase().replace(/^SO-?/, "SO-"))).collect()
  else if (Number.isFinite(num) && num > 0) {
    rows = await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", num)).collect()
    if (!rows.length) rows = (await ctx.db.query("orders").withIndex("by_created").order("desc").take(4000)).filter((o) => o.externalName === `#${num}` || o.externalName === String(num))
  }
  if (!rows.length) {
    const byConsignment = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", t)).collect()
    if (byConsignment.length) rows = byConsignment
  }
  if (!rows.length) {
    const low = t.toLowerCase()
    rows = (await ctx.db.query("orders").withIndex("by_created").order("desc").take(4000)).filter(
      (o) => o.customerName.toLowerCase().includes(low) || o.items.some((i) => i.sku.toLowerCase() === low) || (o.consignmentId ?? "").toLowerCase().includes(low),
    )
  }
  return rows.filter((o) => !o.deletedAt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
}

export const search = query({
  args: { term: v.string() },
  handler: async (ctx, { term }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await withDupes(ctx, await findOrders(ctx, term))
  },
})

export const get = query({
  args: { id: v.id("orders") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const order = await ctx.db.get(id)
    if (!order) return { missing: true as const }
    const events = await ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", id)).order("desc").collect()
    const payments = await ctx.db.query("payments").withIndex("by_order", (q) => q.eq("orderId", id)).collect()
    const customer = await ctx.db.get(order.customerId)
    const location = await ctx.db.get(order.locationId)
    const partner = order.deliveryPartnerId ? await ctx.db.get(order.deliveryPartnerId) : null
    const history = await ctx.db.query("orders").withIndex("by_customer", (q) => q.eq("customerId", order.customerId)).order("desc").take(30)
    const next = TRANSITIONS[order.status as OrderStatus].filter((t) => hasPerm(s.perms, moveKey(order.status as OrderStatus, t)))
    const newer = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", order.status).gt("createdAt", order.createdAt)).order("asc").first()
    const older = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", order.status).lt("createdAt", order.createdAt)).order("desc").first()
    const exchangeOf = order.exchangeOfId ? await ctx.db.get(order.exchangeOfId) : null
    const customerStats = await statsForPhone(ctx, order.phone, customer)
    return {
      missing: false as const,
      order, events, payments, customer, customerStats, locationName: location?.name ?? "",
      partner: partner ? { _id: partner._id, name: partner.name, provider: partner.provider } : null,
      history: history.filter((h) => h._id !== id && !h.deletedAt).map((h) => ({ _id: h._id, invoiceNo: h.invoiceNo, invoiceCode: h.invoiceCode, status: h.status, total: h.total, createdAt: h.createdAt })),
      next, newerId: newer?._id ?? null, olderId: older?._id ?? null,
      exchangeOf: exchangeOf ? { _id: exchangeOf._id, label: invoiceLabel(exchangeOf) } : null,
      canCosts: hasPerm(s.perms, "orders.costs"),
    }
  },
})

// ---------- status changes ----------
export async function applyStatus(ctx: MutationCtx, order: Doc<"orders">, to: OrderStatus, byName: string, reason?: string, opts: { force?: boolean; quiet?: boolean; systemReason?: boolean } = {}) {
  const from = order.status as OrderStatus
  if (from === to) return
  if (!opts.force && !canTransition(from, to)) throw new ConvexError(`${invoiceLabel(order)}: can't move ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}`)
  // Approving an order with a pre-order product sends it to Pre-Order (it waits there until the product arrives)
  const poFrom = to === "approved" && !opts.quiet && ["pending", "on_hold", "cancelled"].includes(from) ? await preOrderOrigin(ctx, order.items) : null
  if (poFrom) {
    to = PRE_ORDER_STATUS[poFrom]
    await ctx.db.patch(order._id, { preOrder: true, preOrderFrom: poFrom })
    await logOrder(ctx, order._id, `Has a pre-order product (${poFrom === "china" ? "China" : "Bangladesh"}) — moved to Pre-Order instead of Approved`, byName)
  }
  await moveOrderStock(ctx, order, from, to, byName)
  await updateCustomerStats(ctx, order, from, to)
  const now = Date.now()
  const patch: Partial<Doc<"orders">> = { status: to, statusChangedAt: now, updatedAt: now }
  // A system-sync note (Pathao status text, Nuport migration text) still goes in the order log below, but it
  // is never a real customer-given reason — never let it land in `reason`/`lastNote`, which the UI reads as
  // "someone found out and recorded why."
  if (reason && !opts.systemReason) { patch.reason = reason; patch.lastNote = `${STATUS_LABEL[to]}: ${reason}`; patch.lastNoteBy = byName }
  if (to === "approved" && !order.approvedAt) patch.approvedAt = now
  if (to === "in_transit" && !order.shippedAt) patch.shippedAt = now
  if (isDelivered(to) && !order.deliveredAt) {
    patch.deliveredAt = now
    const codRate = (await getSetting<number>(ctx, "codRate")) ?? 1
    const collected = to === "delivered_paid" || to === "delivered_due" ? order.due : 0
    if (order.courier !== "pickup") patch.codCost = Math.round(collected * codRate) / 100
    if (order.courierFee !== undefined && order.courierCost === undefined) patch.courierCost = order.courierFee
  }
  if (to === "delivered_paid" && order.due > 0) {
    await ctx.db.insert("payments", { orderId: order._id, method: "Cash On Delivery", amount: order.due, reference: order.consignmentId, byName, at: now })
    patch.paidAmount = order.total
    patch.due = 0
  }
  await ctx.db.patch(order._id, patch)
  await bumpStatusCount(ctx, from, -1)
  await bumpStatusCount(ctx, to, 1)
  await logOrder(ctx, order._id, `Status changed ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}${reason ? ` — ${reason}` : ""}`, byName)
  if (opts.quiet) return // sync from Nuport: no notifications, webhooks or courier booking (Nuport already did those)
  await notify(ctx, "Order Status Updated.", `Sales Order ${invoiceLabel(order)} was set to ${STATUS_LABEL[to]}.`, order._id)
  await emitOrderEvent(ctx, order._id, to)

  // Send to Pathao at the step chosen in Settings (default In Transit, like Nuport; or Ready To Ship; or only by button)
  if (order.courier === "pathao" && !order.consignmentId && to === (await pathaoBookAt(ctx))) {
    await ctx.scheduler.runAfter(0, internal.pathao.bookOrder, { orderId: order._id })
  }
}

export const changeStatus = mutation({
  args: { ids: v.array(v.id("orders")), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { ids, to, reason }) => {
    const me = await requirePerm(ctx, "orders.view")
    const errors: string[] = []
    let done = 0
    for (const id of ids) {
      const order = await ctx.db.get(id)
      if (!order || order.deletedAt) continue
      if (!hasPerm(me.perms, moveKey(order.status as OrderStatus, to))) {
        errors.push(`${invoiceLabel(order)}: you can't move ${STATUS_LABEL[order.status as OrderStatus]} → ${STATUS_LABEL[to]}`)
        continue
      }
      try {
        await applyStatus(ctx, order, to, me.staff.name, reason)
        done++
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    return { done, errors }
  },
})

/** "Fast action": scan or type invoice numbers / consignment IDs and move them all in one go. */
export const fastAction = mutation({
  args: { codes: v.array(v.string()), to: orderStatus, reason: v.optional(v.string()), exchangeOnly: v.optional(v.boolean()) },
  handler: async (ctx, { codes, to, reason, exchangeOnly }) => {
    const me = await requirePerm(ctx, "orders.view")
    const ids: Id<"orders">[] = []
    const notFound: string[] = []
    for (const raw of codes.map((c) => c.trim()).filter(Boolean)) {
      const num = Number(raw.replace(/^bb-?/i, ""))
      let o = Number.isFinite(num) && num > 0 ? await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", num)).first() : null
      if (!o) o = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", raw)).first()
      if (!o) o = await ctx.db.query("orders").withIndex("by_invoice_code", (q) => q.eq("invoiceCode", raw.toUpperCase())).first()
      if (o) ids.push(o._id); else notFound.push(raw)
    }
    const errors: string[] = notFound.map((n) => `${n}: not found`)
    const moved: string[] = []
    // what the scan screen shows for each parcel: status, when it was last scanned, and look-alike parcels
    const details: {
      label: string; customer: string; items: string; from: string; status: string; moved: boolean; error?: string
      already?: { at: number; by: string }; same: { label: string; status: string; at: number }[]
    }[] = []
    let done = 0
    for (const id of ids) {
      const order = (await ctx.db.get(id))!
      const label = invoiceLabel(order)
      const from = order.status
      let error: string | undefined
      let already: { at: number; by: string } | undefined
      if (exchangeOnly !== undefined && !!order.isExchange !== exchangeOnly) {
        error = exchangeOnly ? `${label}: NOT an exchange order — use “Handed over → In Transit”` : `${label}: this is an EXCHANGE order — use “Exchange handed over”`
      } else if (order.status === to) {
        // scanned twice: when and by whom it got this status
        const ev = (await ctx.db.query("orderEvents").withIndex("by_order", (q) => q.eq("orderId", id)).order("desc").take(30))
          .find((e) => e.type === "log" && e.text.includes(`→ ${STATUS_LABEL[to]}`))
        already = { at: ev?.at ?? order.statusChangedAt ?? order.updatedAt, by: ev?.byName ?? "" }
        error = `${label}: ALREADY ${STATUS_LABEL[to]}`
      } else if (!hasPerm(me.perms, moveKey(order.status as OrderStatus, to))) error = `${label}: not allowed`
      else {
        try { await applyStatus(ctx, order, to, me.staff.name, reason); done++; moved.push(label) } catch (e) { error = e instanceof Error ? e.message : String(e) }
      }
      if (error) errors.push(error)
      // same customer + same products in another live order = maybe packed twice
      const key = (o: Doc<"orders">) => o.items.map((i) => `${i.sku}x${i.qty}`).sort().join("|")
      const same = (await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", order.phone)).order("desc").take(20))
        .filter((o) => o._id !== order._id && !o.deletedAt && o.status !== "cancelled" && Math.abs(o.createdAt - order.createdAt) < 30 * 86400000 && key(o) === key(order))
        .map((o) => ({ label: invoiceLabel(o), status: STATUS_LABEL[o.status as OrderStatus] ?? o.status, at: o.createdAt }))
      const now = (await ctx.db.get(id))!
      details.push({
        label, customer: order.customerName, items: order.items.map((i) => `${i.qty} × ${i.name}${i.attrs ? ` · ${i.attrs}` : ""}`).join(", "),
        from: STATUS_LABEL[from as OrderStatus] ?? from, status: STATUS_LABEL[now.status as OrderStatus] ?? now.status,
        moved: !error, error, already, same,
      })
    }
    return { done, errors, moved, details, notFound }
  },
})

/** Used by the Pathao sync job and auto-approve. */
export const systemStatus = internalMutation({
  args: { id: v.id("orders"), to: orderStatus, note: v.string(), byName: v.optional(v.string()) },
  handler: async (ctx, { id, to, note, byName }) => {
    const order = await ctx.db.get(id)
    if (!order || order.deletedAt || order.status === to || !canTransition(order.status as OrderStatus, to)) return false
    await applyStatus(ctx, order, to, byName ?? "Pathao sync", note, { systemReason: true })
    return true
  },
})

export const runAutoApprove = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const due = (await ctx.db.query("orders").withIndex("by_auto_approve", (q) => q.gt("autoApproveAt", 0).lte("autoApproveAt", now)).take(200))
      .filter((o) => o.status === "pending" && !o.deletedAt)
    for (const o of due) {
      try { await applyStatus(ctx, o, "approved", "Auto-approve", "Scheduled auto-approve") } catch (e) {
        await ctx.db.patch(o._id, { autoApproveAt: undefined })
        await logOrder(ctx, o._id, `Auto-approve skipped: ${e instanceof Error ? e.message : e}`, "System")
      }
    }
  },
})

// ---------- edits ----------
async function partnerForLocation(ctx: QueryCtx, locationId: Id<"locations">, exchange: boolean) {
  const all = (await ctx.db.query("deliveryPartners").collect()).filter((p) => p.active && !p.deletedAt && p.locationId === locationId)
  return all.find((p) => p.provider === "pathao" && !!p.isExchange === exchange) ?? (await defaultPartner(ctx, locationId))
}

export const update = mutation({
  args: {
    id: v.id("orders"),
    ...addressFields,
    locationId: v.id("locations"),
    deliveryPartnerId: v.optional(v.id("deliveryPartners")),
    deliveryType: v.string(),
    source: v.string(),
    items: itemsInput,
    keepUnmatched: v.array(v.string()),
    discount: v.number(),
    deliveryFee: v.number(),
    customerNote: v.optional(v.string()),
    additionalInfo: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.edit")
    const order = await ctx.db.get(a.id)
    if (!order) throw new ConvexError("Order not found")
    const editable = ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd"]
    if (!editable.includes(order.status)) throw new ConvexError("Only Pending, On Hold, Approved, Processing or Pre-Order orders can be edited")
    if (order.consignmentId) throw new ConvexError("This order is already booked with the courier")
    const phone = normalizePhone(a.phone)
    if (!/^01\d{9}$/.test(phone)) throw new ConvexError("Phone number looks wrong")

    const items = [...order.items.filter((i) => !i.variantId && a.keepUnmatched.includes(i.sku)), ...(await buildItems(ctx, a.items))]
    if (items.length === 0) throw new ConvexError("An order needs at least one product")
    const reserved = STATUS_BUCKET[order.status as OrderStatus] !== "available"
    const locationChanged = a.locationId !== order.locationId
    if (reserved) await moveOrderStock(ctx, order, order.status as OrderStatus, "pending", me.staff.name)

    const newLoc = await ctx.db.get(a.locationId)
    const noCourier = !!newLoc?.noCourier // exchange warehouse: never Pathao
    // Warehouse changed and no courier picked: use the courier linked to the new warehouse (was: kept the old warehouse's Pathao store)
    const partner = noCourier ? null : a.deliveryPartnerId ? await ctx.db.get(a.deliveryPartnerId)
      : locationChanged ? await partnerForLocation(ctx, a.locationId, !!order.isExchange) : null
    const t = orderTotals(items, a.discount, a.deliveryFee, order.paidAmount)
    await ctx.db.patch(order._id, {
      customerName: a.customerName, phone, email: a.email, address: a.address, cityName: a.cityName,
      pathaoCityId: a.pathaoCityId, pathaoZoneId: a.pathaoZoneId, pathaoAreaId: a.pathaoAreaId,
      zoneName: a.zoneName, areaName: a.areaName, locationId: a.locationId, deliveryType: a.deliveryType,
      deliveryPartnerId: a.deliveryType === "pickup" || noCourier ? undefined : partner?._id ?? order.deliveryPartnerId,
      deliveryPartnerName: a.deliveryType === "pickup" ? undefined : noCourier ? "Exchange — not sent to Pathao" : partner?.name ?? order.deliveryPartnerName,
      courier: a.deliveryType === "pickup" ? "pickup" : noCourier ? "manual" : (partner?.provider ?? "pathao") === "pathao" ? "pathao" : "manual",
      ...(noCourier ? { isExchange: true } : {}),
      source: a.source, items, discount: a.discount, deliveryFee: a.deliveryFee, subtotal: t.subtotal, total: t.total, due: t.due,
      customerNote: a.customerNote, additionalInfo: a.additionalInfo, updatedAt: Date.now(),
      itemCount: items.reduce((s, i) => s + i.qty, 0), purchaseCost: await computePurchaseCost(ctx, items),
      hasUpsell: order.hasUpsell || a.source === "Up Sell",
      ...(await (async () => { const f = await preOrderOrigin(ctx, items); return { preOrder: f !== null || undefined, preOrderFrom: f ?? undefined } })()),
    })
    if (reserved) {
      const fresh = (await ctx.db.get(order._id))!
      await moveOrderStock(ctx, fresh, "pending", order.status as OrderStatus, me.staff.name)
    }
    await logOrder(ctx, order._id, `Order edited${locationChanged ? " (warehouse changed)" : ""}. Total now ৳${t.total}`, me.staff.name)
  },
})

export const setDates = mutation({
  args: {
    ids: v.array(v.id("orders")),
    shippingDate: v.optional(v.number()),
    followUpAt: v.optional(v.union(v.number(), v.null())),
    autoApproveAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.edit")
    for (const id of a.ids) {
      const patch: Partial<Doc<"orders">> = { updatedAt: Date.now() }
      const bits: string[] = []
      if (a.shippingDate !== undefined) { patch.shippingDate = a.shippingDate; bits.push("shipping date") }
      if (a.followUpAt !== undefined) { patch.followUpAt = a.followUpAt ?? undefined; bits.push("follow-up date") }
      if (a.autoApproveAt !== undefined) { patch.autoApproveAt = a.autoApproveAt ?? undefined; bits.push("auto-approve date") }
      await ctx.db.patch(id, patch)
      await logOrder(ctx, id, `Updated ${bits.join(", ")}`, me.staff.name)
    }
  },
})

export const setCosts = mutation({
  args: { id: v.id("orders"), purchaseCost: v.number(), codCost: v.number(), courierCost: v.number(), otherCost: v.number() },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.costs")
    const { id, ...costs } = a
    await ctx.db.patch(id, { ...costs, updatedAt: Date.now() })
    await logOrder(ctx, id, `Costs updated — purchase ৳${a.purchaseCost}, COD ৳${a.codCost}, courier ৳${a.courierCost}, other ৳${a.otherCost}`, me.staff.name)
  },
})

export const addNote = mutation({
  args: { id: v.id("orders"), text: v.string() },
  handler: async (ctx, { id, text }) => {
    const me = await requirePerm(ctx, "orders.view")
    if (!text.trim()) return
    const o = await ctx.db.get(id)
    await logOrder(ctx, id, text.trim(), me.staff.name, "note")
    if (o) await ctx.db.patch(id, { noteCount: (o.noteCount ?? 0) + 1, lastNote: text.trim(), lastNoteBy: me.staff.name })
  },
})

export const logCall = mutation({
  args: { id: v.id("orders"), outcome: v.string(), note: v.optional(v.string()), followUpAt: v.optional(v.number()) },
  handler: async (ctx, { id, outcome, note, followUpAt }) => {
    const me = await requirePerm(ctx, "orders.view")
    const order = await ctx.db.get(id)
    if (!order) throw new ConvexError("Order not found")
    await ctx.db.patch(id, {
      callCount: order.callCount + 1, lastCallOutcome: outcome, updatedAt: Date.now(),
      followUpAt: followUpAt || undefined, // a new call without a follow-up time clears the old one
    })
    const when = followUpAt ? ` · follow up ${new Date(followUpAt + 6 * 3600000).toISOString().slice(0, 16).replace("T", " ")}` : ""
    await logOrder(ctx, id, `${note?.trim() ? `${outcome} — ${note.trim()}` : outcome}${when}`, me.staff.name, "call", outcome)
  },
})

/** Set or correct the reason on an order after the fact — e.g. a migrated order whose reason is just a
 *  placeholder, or a return logged without one. Doesn't touch status, just the record. */
/** reason = short category (a preset, or free text typed as "Other") — never raw courier/migration text.
 *  note = the customer's own words, Bangla or English, exactly as they said it — real data for later analysis
 *  (return-reason patterns, fulfillment mistakes, AI processing), kept separate from the category on purpose. */
export const setReason = mutation({
  args: { id: v.id("orders"), reason: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { id, reason, note }) => {
    const me = await requirePerm(ctx, "orders.edit")
    const order = await ctx.db.get(id)
    if (!order) throw new ConvexError("Order not found")
    const clean = reason.trim()
    if (!clean) throw new ConvexError("Enter a reason")
    const cleanNote = note?.trim() || undefined
    if (!cleanNote) throw new ConvexError("Write what the customer actually said before saving — that's the real data this is for.")
    // Once a real, human-logged reason is on file, lock it — only a Super Admin can change it, so the record
    // can't quietly get edited after the fact. A system-sync placeholder doesn't count as "already logged";
    // the first real human entry always goes through.
    if (isRealReason(order.reason) && order.reasonAt && !hasPerm(me.perms, "*")) {
      throw new ConvexError("This reason has already been logged — ask a Super Admin to change it.")
    }
    await ctx.db.patch(id, {
      reason: clean,
      reasonNote: cleanNote,
      reasonBy: me.staff.name,
      reasonAt: Date.now(),
      lastNote: `${STATUS_LABEL[order.status as OrderStatus]}: ${clean}`,
      lastNoteBy: me.staff.name,
      updatedAt: Date.now(),
    })
    await logOrder(ctx, id, `Reason set: ${clean}${cleanNote ? ` — "${cleanNote}"` : ""}`, me.staff.name)
  },
})

/** Post-delivery feedback call — how did it actually go. Its own field (`csat`) and its own log type so it
 *  never touches callCount/lastCallOutcome, which the pre-delivery confirmation-call cron reads. */
export const logCsat = mutation({
  args: { id: v.id("orders"), outcome: v.string(), note: v.optional(v.string()), followUpAt: v.optional(v.number()) },
  handler: async (ctx, { id, outcome, note, followUpAt }) => {
    const me = await requirePerm(ctx, "orders.view")
    const order = await ctx.db.get(id)
    if (!order) throw new ConvexError("Order not found")
    const cleanNote = note?.trim() || undefined
    // No note needed when nothing was actually said (couldn't reach them, or they declined) — otherwise this
    // is the real customer-given data the call exists to capture, so it's required.
    if (!cleanNote && !CSAT_FOLLOWUP_OUTCOMES.includes(outcome) && outcome !== "Declined to answer") {
      throw new ConvexError("Write what the customer actually said before saving.")
    }
    // A finished outcome is locked once logged — only a Super Admin can correct it. "Could not reach" stays
    // open, since that's not a finished call, it's a signal to try again.
    const existing = order.csat as { outcome: string } | undefined
    if (existing && !CSAT_FOLLOWUP_OUTCOMES.includes(existing.outcome) && !hasPerm(me.perms, "*")) {
      throw new ConvexError("This feedback call has already been logged — ask a Super Admin to change it.")
    }
    const csat = { outcome, note: cleanNote, byName: me.staff.name, at: Date.now() }
    // a new log without a follow-up time clears any old one — same pattern as the confirmation-call follow-up
    await ctx.db.patch(id, { csat, csatFollowUpAt: followUpAt, updatedAt: Date.now() })
    await logOrder(ctx, id, `Feedback call: ${outcome}${csat.note ? ` — ${csat.note}` : ""}`, me.staff.name, "call", outcome)
  },
})

/** Post-return feedback call — same idea as logCsat, but for a returned/damaged order: an actual call to the
 *  customer confirming why it came back, not the category logged by setReason when the return was first
 *  raised. Its own field (`returnCsat`) so it never collides with `reason`/`reasonNote`. */
export const logReturnCsat = mutation({
  args: { id: v.id("orders"), outcome: v.string(), note: v.optional(v.string()), followUpAt: v.optional(v.number()) },
  handler: async (ctx, { id, outcome, note, followUpAt }) => {
    const me = await requirePerm(ctx, "orders.view")
    const order = await ctx.db.get(id)
    if (!order) throw new ConvexError("Order not found")
    const cleanNote = note?.trim() || undefined
    if (!cleanNote && !CSAT_FOLLOWUP_OUTCOMES.includes(outcome) && outcome !== "Declined to answer") {
      throw new ConvexError("Write what the customer actually said before saving.")
    }
    const existing = order.returnCsat as { outcome: string } | undefined
    if (existing && !CSAT_FOLLOWUP_OUTCOMES.includes(existing.outcome) && !hasPerm(me.perms, "*")) {
      throw new ConvexError("This return feedback call has already been logged — ask a Super Admin to change it.")
    }
    const returnCsat = { outcome, note: cleanNote, byName: me.staff.name, at: Date.now() }
    await ctx.db.patch(id, { returnCsat, returnCsatFollowUpAt: followUpAt, updatedAt: Date.now() })
    await logOrder(ctx, id, `Return feedback call: ${outcome}${returnCsat.note ? ` — ${returnCsat.note}` : ""}`, me.staff.name, "call", outcome)
  },
})

export const addPayment = mutation({
  args: { id: v.id("orders"), amount: v.number(), method: v.string(), reference: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.payments")
    const order = await ctx.db.get(a.id)
    if (!order) throw new ConvexError("Order not found")
    if (a.amount <= 0) throw new ConvexError("Amount must be more than 0")
    await ctx.db.insert("payments", { orderId: a.id, method: a.method, amount: a.amount, reference: a.reference, byName: me.staff.name, at: Date.now() })
    const paid = order.paidAmount + a.amount
    await ctx.db.patch(a.id, { paidAmount: paid, due: Math.max(0, order.total - paid), paymentMethod: paid >= order.total && (!order.paymentMethod || order.paymentMethod === "Cash On Delivery") ? a.method : order.paymentMethod ?? "Cash On Delivery", updatedAt: Date.now() })
    await logOrder(ctx, a.id, `Payment ৳${a.amount} via ${a.method}${a.reference ? ` (${a.reference})` : ""}`, me.staff.name, "payment")
  },
})

/** Exchange: a new order linked to the original, sent via an exchange delivery partner. */
export const createExchange = mutation({
  args: { id: v.id("orders"), items: itemsInput, deliveryFee: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.create")
    const o = await ctx.db.get(a.id)
    if (!o) throw new ConvexError("Order not found")
    // Exchange parcels go out of an exchange warehouse (same city) and are never booked on Pathao as a new order
    const locs = await ctx.db.query("locations").collect()
    const origLoc = locs.find((l) => l._id === o.locationId)
    const dhaka = /dhaka/i.test(origLoc?.name ?? "")
    const exWh = locs.find((l) => l.noCourier && l.active && /dhaka/i.test(l.name) === dhaka) ?? locs.find((l) => l.noCourier && l.active)
    const partners = (await ctx.db.query("deliveryPartners").collect()).filter((p) => p.active && p.isExchange && !p.deletedAt)
    const partner = exWh ? null : partners.find((p) => p.locationId === o.locationId) ?? partners[0]
    const items = await buildItems(ctx, a.items)
    const res = await insertOrder(ctx, {
      source: o.source, customerName: o.customerName, phone: o.phone, email: o.email, address: o.address, cityName: o.cityName,
      pathaoCityId: o.pathaoCityId, pathaoZoneId: o.pathaoZoneId, pathaoAreaId: o.pathaoAreaId, zoneName: o.zoneName, areaName: o.areaName,
      locationId: exWh?._id ?? o.locationId, deliveryPartnerId: exWh ? undefined : partner?._id ?? o.deliveryPartnerId, deliveryType: o.deliveryType,
      items, discount: 0, deliveryFee: a.deliveryFee, customerNote: a.note, isExchange: true, exchangeOfId: o._id,
      additionalInfo: `EXCHANGE parcel of ${invoiceLabel(o)}${o.consignmentId ? ` — Pathao ID ${o.consignmentId}` : ""}`,
    }, me.staff.name)
    await logOrder(ctx, o._id, `Exchange order BB-${res.invoiceNo} created`, me.staff.name)
    return res
  },
})

// ---------- print, pick list, summary ----------
export const printData = query({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const out: (Doc<"orders"> & { locationName: string; locationAddress: string; locationPhone: string })[] = []
    for (const id of ids) {
      const o = await ctx.db.get(id)
      if (!o) continue
      const l = await ctx.db.get(o.locationId)
      out.push({ ...o, locationName: l?.name ?? "", locationAddress: l?.address ?? "", locationPhone: l?.phone ?? "" })
    }
    return out
  },
})

export const markPrinted = mutation({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }) => {
    const me = await requirePerm(ctx, "orders.print")
    for (const id of ids) {
      const o = await ctx.db.get(id)
      if (!o) continue
      await ctx.db.patch(id, { printedAt: Date.now() })
      if (!o.printedAt) await logOrder(ctx, id, "Invoice printed", me.staff.name)
      // Same as Nuport: printing an approved order's invoice starts processing it.
      if (o.status === "approved" && hasPerm(me.perms, moveKey("approved", "processing"))) {
        await applyStatus(ctx, (await ctx.db.get(id))!, "processing", me.staff.name)
      }
    }
  },
})

export const pickList = query({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const map = new Map<string, { sku: string; name: string; attrs?: string; imageUrl?: string; qty: number; orders: string[] }>()
    for (const id of ids) {
      const o = await ctx.db.get(id)
      if (!o) continue
      for (const i of o.items) {
        const row = map.get(i.sku) ?? { sku: i.sku, name: i.name, attrs: i.attrs, imageUrl: i.imageUrl, qty: 0, orders: [] }
        row.qty += i.qty
        row.orders.push(invoiceLabel(o))
        map.set(i.sku, row)
      }
    }
    return [...map.values()].sort((a, b) => a.sku.localeCompare(b.sku))
  },
})

// ---------- recycle bin ----------
export const softDelete = mutation({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }) => {
    const me = await requirePerm(ctx, "orders.delete")
    for (const id of ids) {
      const o = await ctx.db.get(id)
      if (!o || o.deletedAt) continue
      if (STATUS_BUCKET[o.status as OrderStatus] !== "available" && STATUS_BUCKET[o.status as OrderStatus] !== "sold") {
        await moveOrderStock(ctx, o, o.status as OrderStatus, "cancelled", me.staff.name)
      }
      await ctx.db.patch(id, { deletedAt: Date.now() })
      await bumpStatusCount(ctx, o.status, -1)
      await logOrder(ctx, id, "Moved to recycle bin", me.staff.name)
    }
  },
})

export const restore = mutation({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }) => {
    const me = await requirePerm(ctx, "orders.delete")
    for (const id of ids) {
      const o = await ctx.db.get(id)
      if (!o || !o.deletedAt) continue
      await ctx.db.patch(id, { deletedAt: undefined })
      if (STATUS_BUCKET[o.status as OrderStatus] !== "available" && STATUS_BUCKET[o.status as OrderStatus] !== "sold") {
        await moveOrderStock(ctx, o, "cancelled", o.status as OrderStatus, me.staff.name)
      }
      await bumpStatusCount(ctx, o.status, 1)
      await logOrder(ctx, id, "Restored from recycle bin", me.staff.name)
    }
  },
})

export const listDeleted = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return (await ctx.db.query("orders").withIndex("by_deleted", (q) => q.gt("deletedAt", 0)).order("desc").take(300))
  },
})

// ---------- upload ----------
export const upload = mutation({
  args: {
    rows: v.array(v.object({
      customerName: v.string(), phone: v.string(), address: v.string(), cityName: v.optional(v.string()),
      source: v.optional(v.string()), sku: v.string(), qty: v.number(), price: v.optional(v.number()),
      deliveryFee: v.optional(v.number()), discount: v.optional(v.number()), advance: v.optional(v.number()), note: v.optional(v.string()),
      ref: v.optional(v.string()),
    })),
    locationId: v.id("locations"),
  },
  handler: async (ctx, { rows, locationId }) => {
    const me = await requirePerm(ctx, "orders.upload")
    // Rows with the same ref (or same phone when no ref) become one order.
    const groups = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = r.ref?.trim() || normalizePhone(r.phone)
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    const created: number[] = []
    const errors: string[] = []
    for (const [key, g] of groups) {
      try {
        const items: Doc<"orders">["items"] = []
        for (const r of g) {
          const vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", r.sku.trim().toUpperCase())).first()
          if (!vr) throw new ConvexError(`SKU ${r.sku} not found`)
          const p = await ctx.db.get(vr.productId)
          items.push({ variantId: vr._id, sku: vr.sku, name: p?.name ?? vr.sku, attrs: vr.title, imageUrl: vr.imageUrl ?? p?.imageUrl, price: r.price ?? vr.price, qty: r.qty || 1, discount: 0, weightKg: vr.weightKg })
        }
        const f = g[0]
        const res = await insertOrder(ctx, {
          source: f.source || "Offline", customerName: f.customerName, phone: f.phone, address: f.address, cityName: f.cityName,
          locationId, deliveryType: "regular", items, discount: f.discount ?? 0, deliveryFee: f.deliveryFee ?? 0,
          advance: f.advance ? { amount: f.advance, method: "Cash" } : undefined, customerNote: f.note,
        }, me.staff.name)
        created.push(res.invoiceNo)
      } catch (e) {
        errors.push(`${key}: ${e instanceof Error ? e.message : e}`)
      }
    }
    return { created, errors }
  },
})

// ---------- internals used by Shopify, Pathao ----------
export const ingest = internalMutation({
  args: {
    source: v.string(),
    externalId: v.string(),
    externalName: v.string(),
    customerName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    address: v.string(),
    cityName: v.optional(v.string()),
    items: v.array(orderItem),
    unmatchedSkus: v.array(v.string()),
    discount: v.number(),
    deliveryFee: v.number(),
    paid: v.number(),
    paidMethod: v.string(),
    customerNote: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    origin: v.optional(v.string()),
    campaignId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const dupe = await ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", a.externalId)).first()
    if (dupe) return { skipped: true, invoiceNo: dupe.invoiceNo }
    const { unmatchedSkus, paid, paidMethod, ...rest } = a
    const res = await insertOrder(ctx, {
      ...rest,
      deliveryType: "regular",
      advance: paid > 0 ? { amount: paid, method: paidMethod, reference: a.externalName } : undefined,
    }, "Website", { allowBlocked: true })
    if (unmatchedSkus.length) {
      await logOrder(ctx, res.orderId, `SKU not found in products, stock not tracked: ${unmatchedSkus.join(", ")}`, "Shopify")
    }
    return { skipped: false, invoiceNo: res.invoiceNo }
  },
})

export const cancelExternal = internalMutation({
  args: { externalId: v.string(), reason: v.string() },
  handler: async (ctx, { externalId, reason }) => {
    const order = await ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", externalId)).first()
    if (!order) return
    if (canTransition(order.status as OrderStatus, "cancelled") && ["pending", "on_hold", "approved", "processing"].includes(order.status)) {
      await applyStatus(ctx, order, "cancelled", "Shopify", reason)
    } else {
      await logOrder(ctx, order._id, `Cancelled on Shopify (${reason}) — status left as is, check manually`, "Shopify")
    }
  },
})

export const internalGet = internalMutation({
  args: { id: v.id("orders") },
  handler: async (ctx, { id }) => {
    const order = await ctx.db.get(id)
    if (!order) return null
    const location = await ctx.db.get(order.locationId)
    const partner = order.deliveryPartnerId ? await ctx.db.get(order.deliveryPartnerId) : null
    return {
      order,
      pathaoStoreId: partner?.pathaoStoreId ?? location?.pathaoStoreId ?? null,
      partnerCreds: partner?.useOwnCredentials ? partner.credentials ?? null : null,
      partnerId: partner?._id ?? null,
      noCourier: !!location?.noCourier,
      locationName: location?.name ?? "",
    }
  },
})

export const setPlace = internalMutation({
  args: { id: v.id("orders"), cityId: v.number(), cityName: v.string(), zoneId: v.optional(v.number()), zoneName: v.optional(v.string()), areaId: v.optional(v.number()), areaName: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const o = await ctx.db.get(a.id)
    if (!o || o.pathaoCityId) return false
    await ctx.db.patch(a.id, {
      pathaoCityId: a.cityId, cityName: o.cityName || a.cityName, pathaoZoneId: a.zoneId, zoneName: a.zoneName,
      pathaoAreaId: a.areaId, areaName: a.areaName, updatedAt: Date.now(),
    })
    await logOrder(ctx, a.id, `Pathao detected: ${[a.areaName, a.zoneName, a.cityName].filter(Boolean).join(", ")}`, "Pathao")
    return true
  },
})

export const needingPlace = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: Id<"orders">[] = []
    for (const st of ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()
      for (const o of rows) if (!o.deletedAt && !o.pathaoCityId && o.courier === "pathao") out.push(o._id)
    }
    return out
  },
})

/** After a parcel is cancelled on Pathao: the order is no longer linked to it (it can be pushed again later). */
export const clearParcel = internalMutation({
  args: { id: v.id("orders"), cid: v.string(), by: v.string() },
  handler: async (ctx, { id, cid, by }) => {
    const o = await ctx.db.get(id)
    if (!o || o.consignmentId !== cid) return
    await ctx.db.patch(id, { consignmentId: undefined, courierStatus: undefined, courierError: undefined, courierFee: undefined, courierLinkedBy: undefined, updatedAt: Date.now() })
    await logOrder(ctx, id, `Pathao parcel ${cid} cancelled on Pathao`, by)
  },
})

export const setCourier = internalMutation({
  args: {
    id: v.id("orders"),
    consignmentId: v.optional(v.string()),
    courierStatus: v.optional(v.string()),
    courierFee: v.optional(v.number()),
    courierError: v.optional(v.string()),
    log: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const cur = await ctx.db.get(a.id)
    if (!cur) return
    // Skip writes that change nothing — the 30-minute Pathao sync checks hundreds of orders,
    // and every needless write makes every open screen reload.
    const same = (a.consignmentId === undefined || a.consignmentId === cur.consignmentId)
      && (a.courierStatus === undefined || a.courierStatus === cur.courierStatus)
      && (a.courierFee === undefined || a.courierFee === cur.courierFee)
      && (a.courierError ?? undefined) === (cur.courierError ?? undefined)
    if (same && !a.log) return
    const patch: Partial<Doc<"orders">> = { updatedAt: Date.now() }
    if (a.consignmentId !== undefined) patch.consignmentId = a.consignmentId
    if (a.courierStatus !== undefined) patch.courierStatus = a.courierStatus
    if (a.courierFee !== undefined) { patch.courierFee = a.courierFee; patch.courierCost = a.courierFee }
    patch.courierError = a.courierError
    await ctx.db.patch(a.id, patch)
    if (a.log) await logOrder(ctx, a.id, a.log, "Pathao")
  },
})

export const shippedForSync = internalMutation({
  args: {},
  handler: async (ctx) => {
    const out: { _id: Id<"orders">; invoice: string; consignmentId: string; status: string; partnerCreds: any }[] = []
    const partners = await ctx.db.query("deliveryPartners").collect()
    for (const st of ["ready_to_ship", "in_transit", "delivered_due", "pending_returned"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).take(400)
      for (const r of rows) {
        if (!r.consignmentId || r.courier !== "pathao" || r.deletedAt) continue
        if (/^R[BE]/i.test(r.consignmentId)) continue // Pathao return parcels (RB/RE) — Pathao's order lookup doesn't know them
        const p = partners.find((x) => x._id === r.deliveryPartnerId)
        out.push({ _id: r._id, invoice: invoiceLabel(r), consignmentId: r.consignmentId, status: r.status, partnerCreds: p?.useOwnCredentials ? p.credentials ?? null : null })
      }
    }
    return out
  },
})

// ---------- manual consignment for custom (non-API) couriers ----------
export const setConsignment = mutation({
  args: { id: v.id("orders"), consignmentId: v.string(), courierStatus: v.optional(v.string()), courierFee: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "courier.book")
    await ctx.db.patch(a.id, {
      consignmentId: a.consignmentId.trim() || undefined, courierStatus: a.courierStatus, courierError: undefined,
      ...(a.courierFee !== undefined ? { courierFee: a.courierFee, courierCost: a.courierFee } : {}), updatedAt: Date.now(),
    })
    await logOrder(ctx, a.id, `Courier ID set to ${a.consignmentId}${a.courierStatus ? ` (${a.courierStatus})` : ""}`, me.staff.name)
  },
})

// ---------- Nuport → this app status sync (while the team still works in Nuport) ----------
export const nuportIndexPage = internalQuery({
  args: { from: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, cursor }) => {
    const res = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from)).paginate({ cursor, numItems: 1000 })
    return {
      isDone: res.isDone, cursor: res.continueCursor,
      rows: res.page.filter((o) => !o.deletedAt).map((o) => ({ id: o._id, no: o.invoiceNo, code: o.invoiceCode ?? null, ext: o.externalName ?? null, phone: o.phone, status: o.status, cid: o.consignmentId ?? null })),
    }
  },
})

export const nuportApply = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("orders"), to: orderStatus, cid: v.optional(v.string()), nuport: v.string() })) },
  handler: async (ctx, { rows }) => {
    let changed = 0, linked = 0
    const errors: string[] = []
    for (const r of rows) {
      const o = await ctx.db.get(r.id)
      if (!o || o.deletedAt) continue
      const loc = await ctx.db.get(o.locationId)
      if (r.cid && !o.consignmentId && !loc?.noCourier) {
        const other = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", r.cid)).first()
        if (!other) { await ctx.db.patch(o._id, { consignmentId: r.cid, courier: "pathao", courierLinkedBy: "nuport" }); linked++ }
      }
      if (o.status !== r.to) {
        try {
          await applyStatus(ctx, (await ctx.db.get(o._id))!, r.to, "Nuport sync", `Same as Nuport (${r.nuport})`, { force: true, quiet: true, systemReason: true })
          changed++
        } catch (e) { errors.push(`${invoiceLabel(o)}: ${e instanceof Error ? e.message : String(e)}`) }
      }
    }
    return { changed, linked, errors }
  },
})

/** Gives orders Nuport's invoice numbers (see migrate.nuportSync) and keeps the invoice counter above all of them. */
export const nuportRenumber = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("orders"), from: v.number(), to: v.number() })), top: v.number() },
  handler: async (ctx, { rows, top }) => {
    for (const r of rows) {
      const o = await ctx.db.get(r.id)
      if (!o || o.invoiceNo === r.to) continue
      await ctx.db.patch(o._id, { invoiceNo: r.to })
      await logOrder(ctx, o._id, `Invoice number changed BB-${o.invoiceNo} → BB-${r.to} (same number as in Nuport)`, "Nuport sync")
    }
    const inv = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "invoice")).unique()
    if (!inv) await ctx.db.insert("counters", { name: "invoice", value: top })
    else if (inv.value < top) await ctx.db.patch(inv._id, { value: top })
  },
})

/** One-time: mark pre-order products and orders. Open orders with a pre-order product get the flag; Approved ones move to Pre-Order. */
export const markPreOrders = internalMutation({
  args: { productNames: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    let products = 0
    if (a.productNames?.length) {
      const want = new Set(a.productNames.map((n) => n.trim().toLowerCase()))
      for (const p of await ctx.db.query("products").collect()) {
        if (want.has(p.name.trim().toLowerCase()) && !p.preOrder) { await ctx.db.patch(p._id, { preOrder: true }); products++ }
      }
    }
    let flagged = 0, moved = 0
    for (const st of ["pending", "on_hold", "approved", "processing", "ready_to_ship"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()
      for (const o of rows) {
        if (o.deletedAt || !(await hasPreOrderItem(ctx, o.items))) continue
        if (!o.preOrder) { await ctx.db.patch(o._id, { preOrder: true }); flagged++ }
        if (st === "approved") { await applyStatus(ctx, { ...o, preOrder: true }, PRE_ORDER_STATUS[(await preOrderOrigin(ctx, o.items)) ?? "china"], "System", "Pre-order product — waiting for stock", { quiet: true }); moved++ }
      }
    }
    // Roles that can move Approved → Processing also get the new Pre-Order moves
    const newKeys = ALL_MOVE_KEYS.filter((k) => k.includes("pre_order"))
    let roles = 0
    for (const r of await ctx.db.query("roles").collect()) {
      if (!r.permissions.includes("move:approved>processing")) continue
      const add = newKeys.filter((k) => !r.permissions.includes(k))
      if (add.length) { await ctx.db.patch(r._id, { permissions: [...r.permissions, ...add] }); roles++ }
    }
    return { products, flagged, moved, roles }
  },
})

/** One-time: pre-order lines were saved at the advance price only. Put the full price back so the rest shows as due on delivery. */
export const fixPreOrderPrices = internalMutation({
  args: { rows: v.array(v.object({ invoice: v.string(), sku: v.string(), fullPrice: v.number() })) },
  handler: async (ctx, { rows }) => {
    const done: string[] = []
    for (const r of rows) {
      const no = Number(r.invoice.replace(/\D/g, ""))
      const o = await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", no)).filter((q) => q.eq(q.field("deletedAt"), undefined)).first()
      if (!o || o.consignmentId) continue
      let changed = false
      const items = o.items.map((i) => (i.sku.toUpperCase() === r.sku.toUpperCase() && i.price < r.fullPrice ? ((changed = true), { ...i, price: r.fullPrice }) : i))
      if (!changed) continue
      const t = orderTotals(items, o.discount, o.deliveryFee, o.paidAmount)
      await ctx.db.patch(o._id, { items, subtotal: t.subtotal, total: t.total, due: t.due, preOrder: true, updatedAt: Date.now() })
      await logOrder(ctx, o._id, `Pre-order advance: ${r.sku} full price ৳${r.fullPrice}. Total now ৳${t.total}, paid ৳${o.paidAmount}, due on delivery ৳${t.due}`, "System")
      done.push(`${r.invoice} ${r.sku} → due ৳${t.due}`)
    }
    return done
  },
})

/** One-time: roles that already move orders through Pre-Order also get the new Bangladesh moves; existing pre-orders get their origin. */
export const addPreOrderBd = internalMutation({
  args: {},
  handler: async (ctx) => {
    const newKeys = ALL_MOVE_KEYS.filter((k) => k.includes("pre_order"))
    let roles = 0
    for (const r of await ctx.db.query("roles").collect()) {
      if (!r.permissions.includes("move:approved>processing")) continue
      const add = newKeys.filter((k) => !r.permissions.includes(k))
      if (add.length) { await ctx.db.patch(r._id, { permissions: [...r.permissions, ...add] }); roles++ }
    }
    let marked = 0
    for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "pre_order")).collect()) {
      if (!o.preOrderFrom) { await ctx.db.patch(o._id, { preOrderFrom: (await preOrderOrigin(ctx, o.items)) ?? "china" }); marked++ }
    }
    return { roles, marked }
  },
})
