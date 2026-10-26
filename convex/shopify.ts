import { v } from "convex/values"
import { httpAction, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, setSetting } from "./lib"

export const secret = internalQuery({
  args: {},
  handler: async (ctx) => ({
    hmac: (await getSetting<string>(ctx, "shopifySecret")) ?? null,
    urlKey: (await getSetting<string>(ctx, "shopifyUrlKey")) ?? null,
  }),
})

export const variantsBySku = internalQuery({
  args: { skus: v.array(v.string()) },
  handler: async (ctx, { skus }) => {
    const out: Record<string, { variantId: string; weightKg: number; imageUrl?: string; name: string; title: string }> = {}
    for (const sku of skus) {
      const vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku.toUpperCase())).first()
      if (!vr) continue
      const p = await ctx.db.get(vr.productId)
      out[sku] = { variantId: vr._id, weightKg: vr.weightKg, imageUrl: p?.imageUrl, name: p?.name ?? vr.sku, title: vr.title }
    }
    return out
  },
})

export const markSeen = internalMutation({
  args: { topic: v.string(), ok: v.boolean(), message: v.string() },
  handler: async (ctx, a) => setSetting(ctx, "shopifyLast", { ...a, at: Date.now() }),
})

async function hmacOk(body: string, header: string | null, key: string) {
  if (!header) return false
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body)))
  let bin = ""
  for (const b of sig) bin += String.fromCharCode(b)
  const expected = btoa(bin)
  if (expected.length !== header.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i)
  return diff === 0
}

const num = (x: unknown) => Number(x ?? 0) || 0

export const webhook = httpAction(async (ctx, req) => {
  const body = await req.text()
  const topic = req.headers.get("X-Shopify-Topic") ?? ""
  const keys = await ctx.runQuery(internal.shopify.secret, {})
  const urlKey = new URL(req.url).searchParams.get("key")
  const urlOk = !!keys.urlKey && urlKey === keys.urlKey
  const hmacPass = !!keys.hmac && (await hmacOk(body, req.headers.get("X-Shopify-Hmac-Sha256"), keys.hmac))
  if (!keys.urlKey && !keys.hmac) return new Response("Shopify secret not set", { status: 401 })
  if (!urlOk && !hmacPass) {
    await ctx.runMutation(internal.shopify.markSeen, { topic, ok: false, message: "Signature check failed — check the signing secret" })
    return new Response("Invalid signature", { status: 401 })
  }
  let o: any
  try {
    o = JSON.parse(body)
  } catch {
    return new Response("Bad JSON", { status: 400 })
  }

  try {
    if (topic === "orders/cancelled") {
      await ctx.runMutation(internal.orders.cancelExternal, { externalId: String(o.id), reason: o.cancel_reason ?? "cancelled on Shopify" })
      await ctx.runMutation(internal.shopify.markSeen, { topic, ok: true, message: `Cancelled ${o.name}` })
      return new Response("ok")
    }
    if (topic === "checkouts/create" || topic === "checkouts/update" || topic === "draft_orders/create" || topic === "draft_orders/update") {
      try {
        const c = topic.startsWith("draft") ? await toDraft(ctx, o) : await toCart(ctx, o)
        await ctx.runMutation(internal.checkouts.upsertFromShopify, c)
        await ctx.runMutation(internal.shopify.markSeen, { topic, ok: true, message: `${c.kind === "draft" ? "Draft" : "Checkout"} ${c.customerName || c.phone || o.id}${c.completed ? " (completed)" : ""}` })
        return new Response("ok")
      } catch (e) {
        // a cart must never be lost: answer with an error so Shopify sends it again
        await ctx.runMutation(internal.shopify.markSeen, { topic, ok: false, message: `Cart ${o?.id ?? ""}: ${e instanceof Error ? e.message : String(e)}` })
        return new Response("retry", { status: 500 })
      }
    }
    if (topic && topic !== "orders/create") return new Response("ignored")

    const ship = o.shipping_address ?? o.billing_address ?? {}
    const cust = o.customer ?? {}
    const phone = ship.phone || o.phone || cust.phone || o.billing_address?.phone || ""
    const name = ship.name || [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "Customer"
    const address = [ship.address1, ship.address2, ship.city, ship.province, ship.zip].filter(Boolean).join(", ")

    const { items, unmatched, itemDiscountTotal } = await mapLines(ctx, o.line_items ?? [])
    const deliveryFee = (o.shipping_lines ?? []).reduce((s: number, x: any) => s + num(x.price), 0)
    const orderDiscount = Math.max(0, num(o.total_discounts) - itemDiscountTotal)
    const fin = String(o.financial_status ?? "")
    const paid = fin === "paid" ? num(o.total_price) : fin === "partially_paid" ? Math.max(0, num(o.total_price) - num(o.total_outstanding)) : 0
    const gateway = (o.payment_gateway_names ?? [])[0] ?? "Online"

    const res = await ctx.runMutation(internal.orders.ingest, {
      source: "Website",
      externalId: String(o.id),
      externalName: String(o.name ?? o.order_number ?? o.id),
      customerName: name,
      phone,
      email: o.email || cust.email || undefined,
      address: address || "Address not given",
      cityName: ship.city || undefined,
      items,
      unmatchedSkus: unmatched,
      discount: orderDiscount,
      deliveryFee,
      paid,
      paidMethod: gateway,
      customerNote: o.note || undefined,
      ipAddress: o.browser_ip || o.client_details?.browser_ip || undefined,
      origin: o.referring_site ? String(o.referring_site) : o.source_name && o.source_name !== "web" ? String(o.source_name) : undefined,
      campaignId: (() => { try { return new URL(o.landing_site, "https://x.y").searchParams.get("utm_campaign") || new URL(o.landing_site, "https://x.y").searchParams.get("campaign_id") || undefined } catch { return undefined } })(),
    })
    if (o.checkout_token || o.checkout_id) {
      await ctx.runMutation(internal.checkouts.markOrdered, {
        token: o.checkout_token ? String(o.checkout_token) : undefined, checkoutId: o.checkout_id ? String(o.checkout_id) : undefined, externalId: String(o.id),
      })
    }
    await ctx.runMutation(internal.shopify.markSeen, {
      topic, ok: true, message: res.skipped ? `${o.name} already imported` : `${o.name} → BB-${res.invoiceNo}`,
    })
    return new Response("ok")
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await ctx.runMutation(internal.shopify.markSeen, { topic, ok: false, message: `${o?.name ?? ""}: ${msg}` })
    // 200 so Shopify does not keep retrying a permanently bad order; the error shows in Settings.
    return new Response("error logged")
  }
})

const taka = (v: unknown) => Number(String(v ?? "").replace(/[^0-9.]/g, "")) || 0

/** Full unit price of a pre-order line sold with an advance (from the line's "Full price" / "Due on delivery" notes), else null. */
export function preOrderFullPrice(l: any): number | null {
  // Orders send a list of {name, value}; carts/checkouts may send a plain object {name: value} or nothing
  const raw = l?.properties ?? l?.custom_attributes ?? []
  const props: { name: string; value: unknown }[] = Array.isArray(raw)
    ? raw.map((p: any) => ({ name: String(p?.name ?? p?.key ?? ""), value: p?.value }))
    : raw && typeof raw === "object" ? Object.entries(raw).map(([name, value]) => ({ name, value })) : []
  const get = (k: string) => props.find((p) => p.name.trim().toLowerCase() === k)?.value
  const full = taka(get("full price"))
  if (full > 0) return full
  const due = taka(get("due on delivery"))
  if (due > 0) return num(l.price) + due / (num(l.quantity) || 1)
  return null
}

/** Shopify line items → our order items (matched to our products by SKU). */
async function mapLines(ctx: any, lines: any[]) {
  const skus = lines.map((l) => String(l.sku ?? "").trim()).filter(Boolean)
  const found = await ctx.runQuery(internal.shopify.variantsBySku, { skus })
  // lines with no SKU (or an unknown one) in Shopify: match by product name + size instead
  const noSku = lines.map((l, i) => ({ l, key: String(i) })).filter(({ l }) => !found[String(l.sku ?? "").trim()])
  const byName: Record<string, any> = noSku.length
    ? await ctx.runQuery(internal.checkouts.variantsByName, { lines: noSku.map(({ l, key }) => ({ key, title: String(l.title ?? ""), variant: l.variant_title ? String(l.variant_title) : undefined })) })
    : {}
  const unmatched: string[] = []
  let itemDiscountTotal = 0
  const items = lines.map((l, i) => {
    const match = found[String(l.sku ?? "").trim()] ?? byName[String(i)]
    const sku = match?.sku ?? (String(l.sku ?? "").trim() || `SHOPIFY-${l.variant_id ?? l.id}`)
    if (!match) unmatched.push(sku)
    const disc = (l.discount_allocations ?? []).reduce((s: number, d: any) => s + num(d.amount), 0) || num(l.total_discount)
    itemDiscountTotal += disc
    // Pre-order with advance: Shopify charges only the advance; the line says "Full price Tk 3,168 · Due on delivery Tk 1,584".
    // Keep the FULL price on the item so the rest shows as due and Pathao collects it.
    const full = preOrderFullPrice(l)
    return {
      variantId: match ? (match.variantId as any) : undefined,
      sku: sku.toUpperCase(),
      name: match?.name ?? String(l.title ?? sku),
      attrs: match?.title ?? (l.variant_title || undefined),
      imageUrl: match?.imageUrl,
      price: full ?? num(l.price),
      qty: num(l.quantity) || 1,
      discount: disc,
      weightKg: match?.weightKg ?? num(l.grams) / 1000,
    }
  })
  return { items, unmatched, itemDiscountTotal }
}

/** Shopify checkout (abandoned cart) → what we store. */
async function toCart(ctx: any, o: any) {
  const ship = o.shipping_address ?? o.billing_address ?? {}
  const cust = o.customer ?? {}
  const { items, itemDiscountTotal } = await mapLines(ctx, o.line_items ?? [])
  const deliveryFee = (o.shipping_lines ?? []).reduce((s: number, x: any) => s + num(x.price), 0)
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)
  const discount = Math.max(0, num(o.total_discounts) - itemDiscountTotal)
  const total = num(o.total_price) || Math.max(0, subtotal - itemDiscountTotal - discount + deliveryFee)
  const t = (x: any) => { const n = Date.parse(String(x ?? "")); return Number.isFinite(n) ? n : Date.now() }
  return {
    checkoutId: String(o.id ?? o.token),
    kind: "checkout",
    token: o.token ? String(o.token) : undefined,
    customerName: ship.name || [ship.first_name, ship.last_name].filter(Boolean).join(" ") || [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "",
    phone: String(ship.phone || o.phone || cust.phone || o.billing_address?.phone || ""),
    email: o.email || cust.email || undefined,
    address: [ship.address1, ship.address2, ship.city, ship.province].filter(Boolean).join(", "),
    cityName: ship.city || undefined,
    items, subtotal, discount, deliveryFee, total,
    recoveryUrl: o.abandoned_checkout_url ? String(o.abandoned_checkout_url) : undefined,
    shopCreatedAt: t(o.created_at),
    shopUpdatedAt: t(o.updated_at ?? o.created_at),
    completed: !!o.completed_at,
  }
}

/** Shopify draft order (e.g. EasySell COD form left without ordering) → what we store. */
async function toDraft(ctx: any, o: any) {
  const ship = o.shipping_address ?? o.billing_address ?? {}
  const cust = o.customer ?? {}
  const { items, itemDiscountTotal } = await mapLines(ctx, o.line_items ?? [])
  const deliveryFee = num(o.shipping_line?.price)
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)
  const discount = Math.max(0, num(o.applied_discount?.amount) - 0) || Math.max(0, num(o.total_discounts) - itemDiscountTotal)
  const total = num(o.total_price) || Math.max(0, subtotal - itemDiscountTotal - discount + deliveryFee)
  const t = (x: any) => { const n = Date.parse(String(x ?? "")); return Number.isFinite(n) ? n : Date.now() }
  const status = String(o.status ?? "open")
  return {
    checkoutId: `draft:${o.id}`,
    kind: "draft",
    shopName: o.name ? String(o.name) : undefined,
    customerName: ship.name || [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "",
    phone: String(ship.phone || o.phone || cust.phone || o.billing_address?.phone || ""),
    email: o.email || cust.email || undefined,
    address: [ship.address1, ship.address2, ship.city && ship.city !== "-" ? ship.city : "", ship.province].filter(Boolean).join(", "),
    cityName: ship.city && ship.city !== "-" ? ship.city : undefined,
    items, subtotal, discount, deliveryFee, total,
    recoveryUrl: o.invoice_url ? String(o.invoice_url) : undefined,
    shopCreatedAt: t(o.created_at),
    shopUpdatedAt: t(o.updated_at ?? o.created_at),
    completed: status === "completed" || !!o.order_id || !!o.completed_at,
  }
}
