// Read-only data feed for BlackBole Marketing OS (a separate app).
// It needs MARKETING_FEED_KEY set in this deployment's environment variables; without it the feed is off.
// Nothing here changes any data.
import { httpAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { webPrice } from "./website"

const MAX_PAGE = 300

function feedOrder(o: Doc<"orders">, c: Doc<"customers"> | null, warehouse: string | null) {
  return {
    id: o._id as string,
    invoice: o.invoiceCode ?? `BB-${o.invoiceNo}`,
    status: o.status,
    source: o.source,
    origin: o.origin ?? null,
    campaignId: o.campaignId ?? null,
    city: o.cityName ?? null,
    warehouse, // which warehouse the parcel ships from (Pathao charges 55 same city, 95 other city)
    zone: o.zoneName ?? null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    statusChangedAt: o.statusChangedAt,
    deliveredAt: o.deliveredAt ?? null,
    total: o.total,
    subtotal: o.subtotal,
    discount: o.discount,
    deliveryFee: o.deliveryFee,
    returnedQty: o.returnedQty ?? 0,
    purchaseCost: o.purchaseCost ?? null,
    courierCost: o.courierCost ?? null,
    codCost: o.codCost ?? null,
    otherCost: o.otherCost ?? null,
    courierPaid: !!o.courierPaid,
    courierCollected: o.courierCollected ?? null, // cash Pathao collected from the customer
    courierPayout: o.courierPayout ?? null, // what Pathao paid us (collected - fees)
    deleted: !!o.deletedAt,
    phone: o.phone,
    customer: c ? { tag: c.tag, orders: c.orderCount, delivered: c.deliveredCount, returned: c.returnedCount, cancelled: c.cancelledCount } : null,
    items: o.items.map((i) => ({ sku: i.sku, name: i.name, attrs: i.attrs ?? null, qty: i.qty, price: i.price, discount: i.discount, imageUrl: i.imageUrl ?? null })),
  }
}

/** Orders changed at or after `since` (ms), oldest change first. */
export const ordersSince = internalQuery({
  args: { since: v.number(), limit: v.number() },
  handler: async (ctx, { since, limit }) => {
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_updated", (q) => q.gte("updatedAt", since))
      .take(Math.min(Math.max(1, limit), MAX_PAGE))
    const customers = new Map<string, Doc<"customers"> | null>()
    const out: ReturnType<typeof feedOrder>[] = []
    const locations = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
    for (const o of rows) {
      const key = o.customerId as string
      if (!customers.has(key)) customers.set(key, await ctx.db.get(o.customerId))
      out.push(feedOrder(o, customers.get(key) ?? null, locations.get(o.locationId as string) ?? null))
    }
    return out
  },
})

/** Sellable stock per SKU, summed across active warehouses. */
export const stockBySku = internalQuery({
  args: { product: v.optional(v.string()) },
  handler: async (ctx, { product: only }) => {
    const locations = await ctx.db.query("locations").collect()
    const active = new Set(locations.filter((l) => l.active && !l.noCourier).map((l) => l._id as string))
    const variants = await ctx.db.query("variants").collect()
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    const out: { sku: string; product: string; variant: string; price: number; webPrice: number; cost: number; available: number; preOrder: boolean; imageUrl: string | null; handle: string | null }[] = []
    for (const vr of variants) {
      const p = products.get(vr.productId as string)
      if (!vr.active || !p || !p.active || p.deletedAt) continue
      if (only !== undefined && p.name !== only) continue
      const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", vr._id)).collect()
      const available = rows.filter((r) => active.has(r.locationId as string)).reduce((s, r) => s + r.available, 0)
      // price = the Ops selling price (what the team edits on Products). webPrice = the price saved for the website,
      // sent so Marketing OS can flag a mismatch (pre-orders: that is only the booking money, so not sent).
      out.push({ sku: vr.sku, product: p.name, variant: vr.title, price: Math.round(vr.price), webPrice: p.preOrder ? Math.round(vr.price) : webPrice(vr), cost: vr.purchasePrice ?? 0, available, preOrder: !!p.preOrder, imageUrl: vr.imageUrl ?? p.imageUrl ?? (p as any).web?.images?.[0]?.url ?? null, handle: p.handle ?? null })
    }
    return out
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

/** SHA-256 of a Bangladeshi number in the format Meta and TikTok expect (8801XXXXXXXXX). */
async function hashPhone(phone: string): Promise<string | null> {
  const d = phone.replace(/\D/g, "")
  const local = d.startsWith("880") ? d.slice(3) : d.startsWith("0") ? d.slice(1) : d
  if (local.length !== 10) return null
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`880${local}`))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function authorized(req: Request) {
  const key = process.env.MARKETING_FEED_KEY
  return !!key && key.length >= 24 && req.headers.get("X-Feed-Key") === key
}

export const orders = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "Invalid feed key" }, 401)
  const url = new URL(req.url)
  const since = Number(url.searchParams.get("since") ?? 0) || 0
  const limit = Number(url.searchParams.get("limit") ?? 200) || 200
  const rows = await ctx.runQuery(internal.marketingFeed.ordersSince, { since, limit })
  // Phone numbers leave Ops only as hashes.
  const data = await Promise.all(rows.map(async ({ phone, ...o }) => ({ ...o, phoneHash: await hashPhone(phone) })))
  return json({ orders: data, next: data.length ? data[data.length - 1].updatedAt : since, more: data.length >= Math.min(limit, MAX_PAGE) })
})

export const stock = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "Invalid feed key" }, 401)
  return json({ stock: await ctx.runQuery(internal.marketingFeed.stockBySku, {}) })
})

/** Marketing OS → a product-scoped percent code for a clearance ad (POST, feed key). */
export const discount = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "Invalid feed key" }, 401)
  const b: any = await req.json().catch(() => ({}))
  const handles = Array.isArray(b.handles) ? b.handles.map(String).filter(Boolean) : []
  if (!handles.length || !(Number(b.percent) >= 1 && Number(b.percent) <= 50)) return json({ error: "percent (1–50) and product handles are required" }, 400)
  try {
    const r = await ctx.runMutation(internal.discounts.upsertMarketing, { code: String(b.code ?? ""), title: String(b.title ?? "Clearance"), percent: Number(b.percent), handles, days: Number(b.days) || 7 })
    return json({ ok: true, ...r })
  } catch (e) { return json({ error: e instanceof Error ? e.message.replace(/^.*ConvexError: /, "") : String(e) }, 400) }
})

/** One product's sizes, prices and stock right now (Marketing OS opens a product: ?name=…). */
export const product = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "Invalid feed key" }, 401)
  const name = new URL(req.url).searchParams.get("name")?.trim()
  if (!name) return json({ error: "name is required" }, 400)
  return json({ stock: await ctx.runQuery(internal.marketingFeed.stockBySku, { product: name }), at: Date.now() })
})

/** Today's revenue target, the daily ad budget and how many pairs each product should sell — for the Marketing OS AI Brain.
 *  Never sends salaries, rent or other fixed costs one by one – only their combined monthly total. */
export const target = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "Invalid feed key" }, 401)
  const p = await ctx.runAction(internal.targets.progressForFeed, {})
  const mk = p.marketing?.state === "ok" ? p.marketing.plan : null
  // Per-order costs and ONE combined monthly fixed-cost total (never salary / rent / other one by one):
  // Marketing OS uses them in each product's profit sum.
  const { costs: c, fixedMonthly } = await ctx.runQuery(internal.targets.costsForFeed, {})
  return json({
    costs: { packaging: c.packaging ?? 0, payFeePct: c.payFeePct ?? 0, delivery: c.delivery ?? 0, returnPct: c.returnPct ?? 0, fixedMonthly },
    month: p.month, asOf: p.asOf, auto: p.auto,
    target: p.target?.amount ?? null,
    delivered: p.plan?.delivered ?? null, remaining: p.plan?.remaining ?? null, daysLeft: p.plan?.daysLeft ?? null,
    today: p.plan?.focus ? { day: p.plan.focus.day, target: p.plan.focus.target, delivered: p.plan.focus.delivered, toGo: p.plan.focus.toGo } : null,
    perDayFromTomorrow: p.plan?.perDayFromTomorrow ?? null,
    marketing: p.marketing ? { state: p.marketing.state, mer: mk?.mer ?? null, budget: mk?.budget ?? null, spentMtd: mk?.spentMtd ?? null, status: mk?.status ?? null } : null,
    daily: p.daily ? { adBudget: p.daily.adBudget, adMax: p.daily.adMax, spentToday: p.daily.spentToday, adLeft: p.daily.adLeft, ordersToBook: p.daily.ordersToBook, returnRate: p.daily.returnRate, adsCantPay: p.daily.adsCantPay } : null,
    products: (p.products ?? []).map((r) => ({
      key: r.key, name: r.name, group: r.group, price: Math.round(r.price), todayTarget: r.todayTarget, todaySold: r.todaySold, toGo: r.toGo,
      perDayAfterToday: r.perDayAfterToday, stockUnits: r.stockUnits, sizes: r.sizes, overstock: r.overstock, left: r.left,
    })),
  })
})
