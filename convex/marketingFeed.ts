// Read-only data feed for BlackBole Marketing OS (a separate app).
// It needs MARKETING_FEED_KEY set in this deployment's environment variables; without it the feed is off.
// Nothing here changes any data.
import { httpAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"

const MAX_PAGE = 300

function feedOrder(o: Doc<"orders">, c: Doc<"customers"> | null) {
  return {
    id: o._id as string,
    invoice: o.invoiceCode ?? `BB-${o.invoiceNo}`,
    status: o.status,
    source: o.source,
    origin: o.origin ?? null,
    campaignId: o.campaignId ?? null,
    city: o.cityName ?? null,
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
    for (const o of rows) {
      const key = o.customerId as string
      if (!customers.has(key)) customers.set(key, await ctx.db.get(o.customerId))
      out.push(feedOrder(o, customers.get(key) ?? null))
    }
    return out
  },
})

/** Sellable stock per SKU, summed across active warehouses. */
export const stockBySku = internalQuery({
  args: {},
  handler: async (ctx) => {
    const locations = await ctx.db.query("locations").collect()
    const active = new Set(locations.filter((l) => l.active && !l.noCourier).map((l) => l._id as string))
    const variants = await ctx.db.query("variants").collect()
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    const out: { sku: string; product: string; variant: string; price: number; available: number; preOrder: boolean; imageUrl: string | null }[] = []
    for (const vr of variants) {
      const p = products.get(vr.productId as string)
      if (!vr.active || !p || !p.active || p.deletedAt) continue
      const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", vr._id)).collect()
      const available = rows.filter((r) => active.has(r.locationId as string)).reduce((s, r) => s + r.available, 0)
      out.push({ sku: vr.sku, product: p.name, variant: vr.title, price: vr.price, available, preOrder: !!p.preOrder, imageUrl: vr.imageUrl ?? p.imageUrl ?? null })
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
