import { v, ConvexError } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import { internal } from "./_generated/api"
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { orderItem, orderStatus } from "./schema"
import { statsForPhone } from "./customerStats"
import {
  computePurchaseCost, currentStaff, defaultLocation, defaultPartner, emitOrderEvent, getSetting, invoiceLabel, logOrder,
  moveOrderStock, nextCounter, notify, requirePerm,
} from "./lib"
import {
  STATUS_BUCKET, STATUS_LABEL, STATUS_TABS, TRANSITIONS, canTransition, hasPerm, moveKey, normalizePhone, orderTotals,
  type OrderStatus,
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
const OPEN: OrderStatus[] = ["pending", "on_hold", "approved", "processing", "ready_to_ship"]

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

  const partner = o.deliveryPartnerId ? await ctx.db.get(o.deliveryPartnerId) : o.deliveryType === "pickup" ? null : await defaultPartner(ctx, location._id)
  const start = (await getSetting<number>(ctx, "invoiceStart")) ?? 20001
  const invoiceNo = await nextCounter(ctx, "invoice", start)
  const paid = o.advance?.amount ?? 0
  const t = orderTotals(o.items, o.discount, o.deliveryFee, paid)
  let status: OrderStatus = o.status ?? "pending"
  if (blocked) status = "cancelled"
  const orderId = await ctx.db.insert("orders", {
    invoiceNo, status, source: o.source, externalId: o.externalId, externalName: o.externalName,
    customerId: customer._id, customerName: o.customerName.trim() || customer.name, phone, email: o.email,
    address: o.address, cityName: o.cityName, pathaoCityId: o.pathaoCityId, pathaoZoneId: o.pathaoZoneId,
    pathaoAreaId: o.pathaoAreaId, zoneName: o.zoneName, areaName: o.areaName, locationId: location._id,
    deliveryType: o.deliveryType, items: o.items, subtotal: t.subtotal, discount: o.discount, deliveryFee: o.deliveryFee,
    paidAmount: paid, total: t.total, due: t.due, paymentMethod: o.paymentMethod ?? (paid > 0 && t.due === 0 ? o.advance!.method : "Cash On Delivery"),
    courier: o.deliveryType === "pickup" ? "pickup" : partner?.provider === "pathao" ? "pathao" : "manual",
    deliveryPartnerId: partner?._id, deliveryPartnerName: partner?.name,
    customerNote: o.customerNote, additionalInfo: o.additionalInfo,
    callCount: 0, createdByName: byName, createdAt: now, updatedAt: now, statusChangedAt: now,
    reason: blocked ?? undefined,
    ipAddress: o.ipAddress, origin: o.origin, campaignId: o.campaignId, followUpAt: o.followUpAt,
    isExchange: o.isExchange, exchangeOfId: o.exchangeOfId,
    noteCount: 0, itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    hasUpsell: o.hasUpsell ?? o.source === "Up Sell",
    purchaseCost: await computePurchaseCost(ctx, o.items),
  })
  await bumpStatusCount(ctx, status, 1)
  if (!o.pathaoCityId && o.deliveryType !== "pickup" && partner?.provider === "pathao" && o.address.trim().length >= 10) {
    await ctx.scheduler.runAfter(0, internal.pathao.autoPlace, { orderId })
  }
  if (paid > 0) {
    await ctx.db.insert("payments", { orderId, method: o.advance!.method, amount: paid, reference: o.advance!.reference, byName, at: now })
    const kind = o.advance!.kind === "delivery" ? " (delivery charge)" : o.advance!.kind === "full" ? " (full payment)" : ""
    await logOrder(ctx, orderId, `Advance ৳${paid}${kind} received via ${o.advance!.method}${o.advance!.reference ? ` — TrxID ${o.advance!.reference}` : ""}`, byName)
  }
  await logOrder(ctx, orderId, `Order created by ${byName} from ${o.source}${o.externalName ? ` (${o.externalName})` : ""}`, byName)
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
    }
    out.all = all
    return out
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

function matches(o: Doc<"orders">, f: Filters, tagOf?: Map<string, string>) {
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
  if (f.flag === "courierError" && !o.courierError) return false
  if (f.flag === "followUp" && !(o.followUpAt && o.followUpAt <= Date.now() + 86400000)) return false
  if (f.flag === "exchange" && !o.isExchange) return false
  if (f.customerTags?.length && tagOf && !f.customerTags.includes(tagOf.get(o.customerId) ?? "")) return false
  return true
}

async function withDupes(ctx: QueryCtx, page: Doc<"orders">[]) {
  return await Promise.all(
    page.map(async (o) => {
      const same = await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", o.phone)).take(30)
      const dupes = same.filter((x) => x._id !== o._id && !x.deletedAt && OPEN.includes(x.status as OrderStatus)).length
      const c = await ctx.db.get(o.customerId)
      return { ...o, dupes, customerTag: c?.tag ?? "NEW", customerOrders: c?.orderCount ?? 1 }
    }),
  )
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
    limit: v.number(),
    filters: v.optional(filterArgs),
  },
  handler: async (ctx, a) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const f: Filters = a.filters ?? { tab: a.tab, sources: a.source ? [a.source] : undefined, from: a.from, to: a.to, flag: a.flag }
    const limit = Math.min(a.limit, 2000)
    const tab = STATUS_TABS.find((t) => t.key === f.tab)
    let rows: Doc<"orders">[] = []
    if (f.from && (f.dateField ?? "createdAt") === "createdAt") {
      rows = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", f.from!).lte("createdAt", f.to ?? Date.now() + 86400000)).order("desc").take(6000)
    } else if (tab) {
      for (const st of tab.statuses) rows.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).order("desc").take(3000)))
    } else {
      rows = await ctx.db.query("orders").withIndex("by_created").order("desc").take(3000)
    }
    const tagOf = f.customerTags?.length ? new Map((await ctx.db.query("customers").collect()).map((c) => [c._id as string, c.tag])) : undefined
    rows = rows.filter((o) => matches(o, f, tagOf)).sort((x, y) => y.createdAt - x.createdAt)
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
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
export const search = query({
  args: { term: v.string() },
  handler: async (ctx, { term }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
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
    rows = rows.filter((o) => !o.deletedAt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
    return await withDupes(ctx, rows)
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
async function applyStatus(ctx: MutationCtx, order: Doc<"orders">, to: OrderStatus, byName: string, reason?: string) {
  const from = order.status as OrderStatus
  if (from === to) return
  if (!canTransition(from, to)) throw new ConvexError(`${invoiceLabel(order)}: can't move ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}`)
  await moveOrderStock(ctx, order, from, to, byName)
  await updateCustomerStats(ctx, order, from, to)
  const now = Date.now()
  const patch: Partial<Doc<"orders">> = { status: to, statusChangedAt: now, updatedAt: now }
  if (reason) { patch.reason = reason; patch.lastNote = `${STATUS_LABEL[to]}: ${reason}`; patch.lastNoteBy = byName }
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
  await notify(ctx, "Order Status Updated.", `Sales Order ${invoiceLabel(order)} was set to ${STATUS_LABEL[to]}.`, order._id)
  await emitOrderEvent(ctx, order._id, to)

  if (to === "ready_to_ship" && order.courier === "pathao" && !order.consignmentId) {
    const auto = (await getSetting<boolean>(ctx, "pathaoAutoBook")) ?? true
    if (auto) await ctx.scheduler.runAfter(0, internal.pathao.bookOrder, { orderId: order._id })
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
  args: { codes: v.array(v.string()), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { codes, to, reason }) => {
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
    let done = 0
    for (const id of ids) {
      const order = (await ctx.db.get(id))!
      if (!hasPerm(me.perms, moveKey(order.status as OrderStatus, to))) { errors.push(`${invoiceLabel(order)}: not allowed`); continue }
      if (order.status === to) { errors.push(`${invoiceLabel(order)}: already ${STATUS_LABEL[to]}`); continue }
      try { await applyStatus(ctx, order, to, me.staff.name, reason); done++; moved.push(invoiceLabel(order)) } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
    }
    return { done, errors, moved }
  },
})

/** Used by the Pathao sync job and auto-approve. */
export const systemStatus = internalMutation({
  args: { id: v.id("orders"), to: orderStatus, note: v.string(), byName: v.optional(v.string()) },
  handler: async (ctx, { id, to, note, byName }) => {
    const order = await ctx.db.get(id)
    if (!order || order.deletedAt || order.status === to || !canTransition(order.status as OrderStatus, to)) return false
    await applyStatus(ctx, order, to, byName ?? "Pathao sync", note)
    return true
  },
})

export const runAutoApprove = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const due = (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "pending")).take(500))
      .filter((o) => o.autoApproveAt && o.autoApproveAt <= now && !o.deletedAt)
    for (const o of due) {
      try { await applyStatus(ctx, o, "approved", "Auto-approve", "Scheduled auto-approve") } catch (e) {
        await ctx.db.patch(o._id, { autoApproveAt: undefined })
        await logOrder(ctx, o._id, `Auto-approve skipped: ${e instanceof Error ? e.message : e}`, "System")
      }
    }
  },
})

// ---------- edits ----------
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
    const editable = ["pending", "on_hold", "approved", "processing"]
    if (!editable.includes(order.status)) throw new ConvexError("Only Pending, On Hold, Approved or Processing orders can be edited")
    if (order.consignmentId) throw new ConvexError("This order is already booked with the courier")
    const phone = normalizePhone(a.phone)
    if (!/^01\d{9}$/.test(phone)) throw new ConvexError("Phone number looks wrong")

    const items = [...order.items.filter((i) => !i.variantId && a.keepUnmatched.includes(i.sku)), ...(await buildItems(ctx, a.items))]
    if (items.length === 0) throw new ConvexError("An order needs at least one product")
    const reserved = STATUS_BUCKET[order.status as OrderStatus] !== "available"
    const locationChanged = a.locationId !== order.locationId
    if (reserved) await moveOrderStock(ctx, order, order.status as OrderStatus, "pending", me.staff.name)

    const partner = a.deliveryPartnerId ? await ctx.db.get(a.deliveryPartnerId) : null
    const t = orderTotals(items, a.discount, a.deliveryFee, order.paidAmount)
    await ctx.db.patch(order._id, {
      customerName: a.customerName, phone, email: a.email, address: a.address, cityName: a.cityName,
      pathaoCityId: a.pathaoCityId, pathaoZoneId: a.pathaoZoneId, pathaoAreaId: a.pathaoAreaId,
      zoneName: a.zoneName, areaName: a.areaName, locationId: a.locationId, deliveryType: a.deliveryType,
      deliveryPartnerId: a.deliveryType === "pickup" ? undefined : partner?._id ?? order.deliveryPartnerId,
      deliveryPartnerName: a.deliveryType === "pickup" ? undefined : partner?.name ?? order.deliveryPartnerName,
      courier: a.deliveryType === "pickup" ? "pickup" : (partner?.provider ?? "pathao") === "pathao" ? "pathao" : "manual",
      source: a.source, items, discount: a.discount, deliveryFee: a.deliveryFee, subtotal: t.subtotal, total: t.total, due: t.due,
      customerNote: a.customerNote, additionalInfo: a.additionalInfo, updatedAt: Date.now(),
      itemCount: items.reduce((s, i) => s + i.qty, 0), purchaseCost: await computePurchaseCost(ctx, items),
      hasUpsell: order.hasUpsell || a.source === "Up Sell",
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
      ...(followUpAt ? { followUpAt } : {}),
    })
    await logOrder(ctx, id, note?.trim() ? `${outcome} — ${note.trim()}` : outcome, me.staff.name, "call", outcome)
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
    const partners = (await ctx.db.query("deliveryPartners").collect()).filter((p) => p.active && p.isExchange && !p.deletedAt)
    const partner = partners.find((p) => p.locationId === o.locationId) ?? partners[0]
    const items = await buildItems(ctx, a.items)
    const res = await insertOrder(ctx, {
      source: o.source, customerName: o.customerName, phone: o.phone, email: o.email, address: o.address, cityName: o.cityName,
      pathaoCityId: o.pathaoCityId, pathaoZoneId: o.pathaoZoneId, pathaoAreaId: o.pathaoAreaId, zoneName: o.zoneName, areaName: o.areaName,
      locationId: o.locationId, deliveryPartnerId: partner?._id ?? o.deliveryPartnerId, deliveryType: o.deliveryType,
      items, discount: 0, deliveryFee: a.deliveryFee, customerNote: a.note, isExchange: true, exchangeOfId: o._id,
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
    for (const st of ["pending", "on_hold", "approved", "processing", "ready_to_ship"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()
      for (const o of rows) if (!o.deletedAt && !o.pathaoCityId && o.courier === "pathao") out.push(o._id)
    }
    return out
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
    const out: { _id: Id<"orders">; consignmentId: string; status: string; partnerCreds: any }[] = []
    const partners = await ctx.db.query("deliveryPartners").collect()
    for (const st of ["ready_to_ship", "in_transit", "delivered_due", "pending_returned"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).take(400)
      for (const r of rows) {
        if (!r.consignmentId || r.courier !== "pathao" || r.deletedAt) continue
        const p = partners.find((x) => x._id === r.deliveryPartnerId)
        out.push({ _id: r._id, consignmentId: r.consignmentId, status: r.status, partnerCreds: p?.useOwnCredentials ? p.credentials ?? null : null })
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
