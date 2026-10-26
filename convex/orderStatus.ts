// Public order-status lookup for the website's "Track your order" page (like Shopify's order status page).
// GET /website/order-status?invoice=BB-12345&phone=01XXXXXXXXX
// No key needed, but: the mobile number must match the order, every miss gets the same "not found",
// only safe fields are returned, and each IP gets a few tries per minute.
import { v } from "convex/values"
import { httpAction, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"

const LIMIT = 10 // lookups per IP per minute
const WINDOW = 60_000

/** What the shopper sees for each Ops status. */
export const CUSTOMER_STATUS: Record<string, { step: number; label: string; note: string }> = {
  pending: { step: 1, label: "Order received", note: "We'll call you shortly to confirm it." },
  on_hold: { step: 1, label: "Order received", note: "We'll call you shortly to confirm it." },
  approved: { step: 2, label: "Confirmed", note: "Your order is confirmed and being packed." },
  processing: { step: 2, label: "Confirmed", note: "Your order is confirmed and being packed." },
  pre_order: { step: 2, label: "Pre-order confirmed", note: "Your pair is being made and shipped to us. We'll send it as soon as it arrives." },
  pre_order_bd: { step: 2, label: "Pre-order confirmed", note: "Your pair is being made. We'll send it as soon as it's ready." },
  ready_to_ship: { step: 3, label: "Packed", note: "Packed and being handed to the courier." },
  in_transit: { step: 4, label: "On the way", note: "Your parcel is with the courier." },
  delivered_due: { step: 5, label: "Delivered", note: "Delivered. Thank you for shopping with BlackBole." },
  delivered_paid: { step: 5, label: "Delivered", note: "Delivered. Thank you for shopping with BlackBole." },
  pending_returned: { step: 0, label: "Returned", note: "This order is being returned to us." },
  returned: { step: 0, label: "Returned", note: "This order was returned to us." },
  damaged: { step: 0, label: "Returned", note: "This order was returned to us." },
  cancelled: { step: 0, label: "Cancelled", note: "This order was cancelled." },
}

const digits = (s: string) => s.replace(/\D/g, "")
/** Bangladeshi mobile in its 11-digit 01XXXXXXXXX form ("+8801…" / "8801…" accepted). */
export const normPhone = (s: string) => { const d = digits(s); return d.length === 13 && d.startsWith("880") ? d.slice(2) : d }
/** "BB-12345", "bb 12345", "#12345" or "12345" → 12345 */
export const parseInvoice = (s: string) => { const m = /^\s*(?:BB)?[-\s#]*(\d{1,9})\s*$/i.exec(s); return m ? Number(m[1]) : null }

/** Only what the shopper may see. */
export function publicOrder(o: Doc<"orders">) {
  const st = CUSTOMER_STATUS[o.status] ?? { step: 1, label: "Order received", note: "" }
  const total = Math.round(o.total)
  const paid = Math.max(0, Math.round(o.paidAmount ?? 0))
  const cid = o.consignmentId || null
  const pathao = !!cid && (o.courier ?? "pathao") === "pathao"
  return {
    invoice: `BB-${o.invoiceNo}`,
    status: st.label,
    note: st.note,
    step: st.step,
    createdAt: o.createdAt,
    items: o.items.map((i) => ({ name: i.name, size: i.attrs ?? "", qty: i.qty })),
    total, paid, due: Math.max(0, total - paid),
    courier: cid ? (pathao ? "Pathao" : "Courier") : null,
    tracking: cid,
    trackingUrl: pathao ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(cid!)}&phone=${encodeURIComponent(normPhone(o.phone))}` : null,
  }
}

export const lookup = internalQuery({
  args: { invoiceNo: v.number(), phone: v.string() },
  handler: async (ctx, { invoiceNo, phone }) => {
    const rows = await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", invoiceNo)).collect()
    const o = rows.find((r) => !r.deletedAt && normPhone(r.phone) === normPhone(phone))
    return o ? publicOrder(o) : null
  },
})

/** Counts a hit; false once the key is over the limit for this minute. */
export const hit = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now()
    const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", key)).first()
    if (!row || now - row.windowStart > WINDOW) {
      if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 })
      else await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 })
      return true
    }
    await ctx.db.patch(row._id, { count: row.count + 1 })
    return row.count + 1 <= LIMIT
  },
})

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })

export const statusHttp = httpAction(async (ctx, req) => {
  const url = new URL(req.url)
  const invoiceNo = parseInvoice(url.searchParams.get("invoice") ?? "")
  const phone = normPhone(url.searchParams.get("phone") ?? "")
  // the website's proxy passes the shopper's IP; direct callers are limited by their own address
  const ip = (req.headers.get("X-Client-IP") || req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim().slice(0, 64)
  if (!(await ctx.runMutation(internal.orderStatus.hit, { key: `order-status:${ip}` }))) return json({ error: "Too many tries. Please wait a minute and try again." }, 429)
  if (!invoiceNo || !/^01[3-9]\d{8}$/.test(phone)) return json({ error: "Enter your order number (like BB-12345) and the mobile number you ordered with." }, 400)
  const order = await ctx.runQuery(internal.orderStatus.lookup, { invoiceNo, phone })
  if (!order) return json({ error: "We couldn't find an order with that number and mobile. Check both and try again." }, 404)
  return json({ order })
})
