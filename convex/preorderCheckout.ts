// China pre-order checkout (Emon, 19 Nov 2026). Two ways to order a China pre-order on the website:
//   • Book:     pay only the booking money now (৳200 = the Shopify price), no delivery charge at checkout.
//               The rest of the price AND the ৳90 delivery charge are collected on delivery.
//   • Pay full: pay the full price −15%, plus the ৳90 delivery charge, now. Nothing is collected on delivery.
// The website calls this endpoint; Ops builds a Shopify checkout (draft order) with exactly those amounts and sends
// the customer to it. Prices always come from Shopify, never from the browser. Bangladesh pre-orders are not allowed here.
import { httpAction } from "./_generated/server"
import { shopifyGql } from "./shopifyStock"

export const PRE_FULL_OFF = 0.15
export const PRE_DELIVERY = 90

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })
const fmt = (n: number) => `Tk ${Math.round(n).toLocaleString("en-IN")}`

/** China pre-order = tagged pre-order with a China supplier tag (or made-in-china), not made-in-bangladesh, not a delivery-charge booking. */
export function isChinaPreorder(tags: string[], preFee: unknown): boolean {
  const t = tags.map((x) => x.toLowerCase())
  if (!t.includes("pre-order") || t.includes("made-in-bangladesh") || preFee) return false
  return t.some((x) => x.startsWith("supplier-") || x === "made-in-china")
}

/** What the customer pays now, and what is left for the rider, for one unit. */
export function preorderAmounts(price: number, compareAt: number, mode: "book" | "full") {
  const full = compareAt > price ? compareAt : price * 2
  if (mode === "full") {
    const unit = Math.round(full * (1 - PRE_FULL_OFF))
    return { full, unit, shipping: PRE_DELIVERY, dueOnDelivery: 0 }
  }
  return { full, unit: price, shipping: 0, dueOnDelivery: full - price + PRE_DELIVERY }
}

export const preorderCheckoutHttp = httpAction(async (ctx, req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  try {
    const text = await req.text()
    if (text.length > 5000) return json({ ok: false, error: "Too big" }, 413)
    const b = JSON.parse(text)
    const mode: "book" | "full" = b.mode === "full" ? "full" : "book"
    const variantNum = String(b.variantId ?? "").replace(/\D/g, "")
    const qty = Math.min(3, Math.max(1, Math.floor(Number(b.qty) || 1)))
    if (!variantNum) return json({ ok: false, error: "Choose a size first" }, 400)
    const preDays = String(b.preDays ?? "15–20").slice(0, 20)

    const d = await shopifyGql(ctx, `query($id: ID!) { productVariant(id: $id) { id sku price compareAtPrice availableForSale product { title tags metafield(namespace: "bb26", key: "pre_fee") { value } } } }`, { id: `gid://shopify/ProductVariant/${variantNum}` })
    const v = d?.productVariant
    if (!v) return json({ ok: false, error: "This size was not found" }, 404)
    if (!v.availableForSale) return json({ ok: false, error: "That size is sold out" }, 409)
    if (!isChinaPreorder(v.product.tags ?? [], v.product.metafield?.value)) return json({ ok: false, error: "Not available for this product" }, 400)

    const a = preorderAmounts(Number(v.price), Number(v.compareAtPrice ?? 0), mode)
    const attrs: { key: string; value: string }[] = [{ key: "Pre-order", value: `Arrives in ${preDays} days` }, { key: "Full price", value: fmt(a.full) }]
    if (mode === "full") {
      attrs.push({ key: "Paid in full", value: `15% off · ${fmt(a.unit)}` }, { key: "Due on delivery", value: "Tk 0 (paid in full)" })
    } else {
      attrs.push({ key: "Booking paid", value: fmt(a.unit) }, { key: "Delivery charge on delivery", value: fmt(PRE_DELIVERY) }, { key: "Due on delivery", value: fmt(a.dueOnDelivery) })
    }
    // the shopper's ad link (utm_*, fbclid, landing page) goes on the order so Ops can match it to the Meta campaign
    const extra: { key: string; value: string }[] = []
    if (b.attrs && typeof b.attrs === "object") {
      for (const [k, val] of Object.entries(b.attrs as Record<string, unknown>).slice(0, 12)) {
        if (typeof val === "string" && val && /^[a-z_ ]{2,30}$/i.test(k)) extra.push({ key: k, value: val.slice(0, 900) })
      }
    }
    const input: any = {
      lineItems: [{
        variantId: v.id, quantity: qty, customAttributes: attrs,
        ...(mode === "full" ? { priceOverride: { amount: String(a.unit), currencyCode: "BDT" } } : {}),
      }],
      shippingLine: { title: mode === "full" ? "Delivery" : "Delivery (pay Tk 90 on delivery)", priceWithCurrency: { amount: String(a.shipping), currencyCode: "BDT" } },
      tags: ["pre-order", "china-pre-order", mode === "full" ? "pre-order-paid-full" : "pre-order-booking"],
      customAttributes: [{ key: "Pre-order payment", value: mode === "full" ? "Paid in full (15% off)" : "Booking only" }, ...extra],
      note: mode === "full"
        ? `China pre-order paid in full: ${fmt(a.unit)} + ${fmt(PRE_DELIVERY)} delivery. Nothing to collect on delivery.`
        : `China pre-order booking: ${fmt(a.unit)} paid. Collect ${fmt(a.dueOnDelivery)} on delivery (incl. ${fmt(PRE_DELIVERY)} delivery).`,
      allowDiscountCodesInCheckout: false,
    }
    const r = await shopifyGql(ctx, `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`, { input })
    const res = r?.draftOrderCreate
    if (res?.userErrors?.length) return json({ ok: false, error: res.userErrors.map((e: any) => e.message).join("; ") }, 400)
    return json({ ok: true, url: res.draftOrder.invoiceUrl, total: Number(res.draftOrder.totalPriceSet?.shopMoney?.amount ?? 0) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ ok: false, error: msg.includes("ACCESS_DENIED") ? "Checkout is not set up yet" : "Could not start checkout. Please try again.", detail: msg.slice(0, 300) }, 500)
  }
})
