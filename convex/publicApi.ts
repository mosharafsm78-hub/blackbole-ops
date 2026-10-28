import { httpAction, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { v, ConvexError } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { getSetting, invoiceLabel, logOrder } from "./lib"
import { matchByName } from "./checkouts"
import { insertOrder } from "./orders"
import { recordUse, recordAutomaticUses, normCode } from "./discounts"

export const apiKey = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<string>(ctx, "apiKey")) ?? null })

export const createFromApi = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body: b }) => {
    // the same order sent again (website retry, queued order delivered twice, payment callback + IPN): answer with the first
    if (b.external_id) {
      const dupe = await ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", String(b.external_id))).first()
      if (dupe) return { invoice: invoiceLabel(dupe), id: dupe._id, duplicate: true }
    }
    const items: Doc<"orders">["items"] = []
    const unknown: string[] = []
    for (const it of b.items ?? []) {
      const sku = String(it.sku ?? "").trim().toUpperCase()
      let vr = sku ? await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first() : null
      // SKU not in Ops (e.g. a new website product): never refuse a customer's order for that. Find the product by
      // name + size, or keep the line unlinked (named, priced) for the team to link.
      if (!vr && it.name) vr = await matchByName(ctx, String(it.name), it.attrs ? String(it.attrs) : undefined)
      const qty = Math.max(1, Math.round(Number(it.qty ?? 1)) || 1)
      if (!vr) {
        if (!sku && !it.name) continue
        unknown.push(sku || String(it.name))
        items.push({ sku: sku || "UNKNOWN", name: String(it.name ?? sku).slice(0, 160), attrs: it.attrs ? String(it.attrs).slice(0, 80) : undefined, price: Number(it.price ?? 0), qty, discount: Number(it.discount ?? 0), weightKg: 0.5 })
        continue
      }
      const p = await ctx.db.get(vr.productId)
      items.push({ variantId: vr._id, sku: vr.sku, name: p?.name ?? vr.sku, attrs: vr.title, imageUrl: vr.imageUrl ?? p?.imageUrl, price: Number(it.price ?? vr.price), qty, discount: Number(it.discount ?? 0), weightKg: vr.weightKg })
    }
    if (!items.length) throw new ConvexError("The order has no products")
    const res = await insertOrder(ctx, {
      source: String(b.source ?? "Website"), externalId: b.external_id ? String(b.external_id) : undefined,
      externalName: b.external_name ? String(b.external_name) : undefined,
      customerName: String(b.customer?.name ?? ""), phone: String(b.customer?.phone ?? ""), email: b.customer?.email,
      dob: b.customer?.dob ? String(b.customer.dob) : undefined,
      address: String(b.customer?.address ?? ""), cityName: b.customer?.city, deliveryType: b.delivery_type ?? "regular",
      items, discount: Number(b.discount ?? 0), deliveryFee: Number(b.delivery_fee ?? 0),
      advance: b.paid_amount ? { amount: Number(b.paid_amount), method: String(b.payment_method ?? "Online") } : undefined,
      customerNote: b.note, ipAddress: b.ip, origin: b.origin, campaignId: b.campaign_id,
    }, "API", { allowBlocked: true })
    // Website promo code: kept on the order (one-per-customer checks) and counted for the usage limit
    if (b.discount_code) {
      await ctx.db.patch(res.orderId, { discountCode: normCode(String(b.discount_code)) })
      await recordUse(ctx, String(b.discount_code))
    }
    await recordAutomaticUses(ctx, b.automatic_discounts) // website automatic discounts: counted in "Used"
    if (unknown.length) await logOrder(ctx, res.orderId, `Not found in Ops by SKU: ${unknown.join(", ")}. Link the product on this order (its stock is not tracked until then)`, "System")
    return { invoice: `BB-${res.invoiceNo}`, id: res.orderId, duplicate: false }
  },
})

export const statusOf = internalQuery({
  args: { invoice: v.string() },
  handler: async (ctx, { invoice }) => {
    const n = Number(invoice.replace(/^bb-?/i, ""))
    const o = Number.isFinite(n) ? await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", n)).first() : null
    if (!o) return null
    return { invoice: invoiceLabel(o), status: o.status, courier: o.deliveryPartnerName ?? null, consignment_id: o.consignmentId ?? null, courier_status: o.courierStatus ?? null, total: o.total, due: o.due }
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

export const orders = httpAction(async (ctx, req) => {
  const key = await ctx.runQuery(internal.publicApi.apiKey, {})
  if (!key || req.headers.get("X-API-Key") !== key) return json({ error: "Invalid API key" }, 401)
  if (req.method === "GET") {
    const invoice = new URL(req.url).searchParams.get("invoice") ?? ""
    const r = await ctx.runQuery(internal.publicApi.statusOf, { invoice })
    return r ? json(r) : json({ error: "Not found" }, 404)
  }
  try {
    const body = await req.json()
    return json(await ctx.runMutation(internal.publicApi.createFromApi, { body }), 201)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return json({ error: m.replace(/^.*Uncaught Error: /s, "").split("\n")[0] }, 400)
  }
})
