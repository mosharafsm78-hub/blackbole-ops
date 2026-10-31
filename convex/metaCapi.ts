// Meta Conversions API: tell Meta about an order only once a person has CONFIRMED it (status Approved), and about the
// delivery or return afterwards. The website's own pixel fires "Purchase" when the order is placed, which teaches Meta
// to find people who place COD orders – including the 30–50% who never take the parcel. Sending the confirmed order
// server-side (the playbook's signal rule) lets the ads optimise toward orders that will actually ship.
// Needs Settings → Meta ads: the pixel ID and the same token (the pixel must belong to the ad account's business).
import { v } from "convex/values"
import { internalAction, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { getSetting } from "./lib"

const GRAPH = "https://graph.facebook.com/v21.0"
const MAX_AGE_S = 7 * 86400 // Meta rejects events older than 7 days

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("")
const phoneHash = async (phone: string) => {
  const d = phone.replace(/\D/g, "")
  const local = d.startsWith("880") ? d.slice(3) : d.startsWith("0") ? d.slice(1) : d
  return local.length === 10 ? sha(`880${local}`) : null
}

export type CapiEvent = "Purchase" | "Delivered" | "Returned"

/** Pure. The event Meta gets for an order. `Purchase` keeps the order's own time so it lands inside the 7-day click window. */
export async function buildEvent(o: { invoiceNo: number; phone: string; email?: string; createdAt: number; total: number; deliveryFee: number; items: { sku: string; qty: number; price: number }[]; city?: string }, event: CapiEvent, now = Date.now()) {
  const at = event === "Purchase" ? Math.min(now, o.createdAt) : now
  if (now / 1000 - at / 1000 > MAX_AGE_S) return null
  const ph = await phoneHash(o.phone)
  const user_data: Record<string, unknown> = { country: [await sha("bd")] }
  if (ph) user_data.ph = [ph]
  if (o.email?.includes("@")) user_data.em = [await sha(o.email.trim().toLowerCase())]
  if (o.city?.trim()) user_data.ct = [await sha(o.city.trim().toLowerCase().replace(/[^a-z]/g, ""))]
  return {
    event_name: event, event_time: Math.floor(at / 1000), event_id: `bb-${o.invoiceNo}-${event.toLowerCase()}`, action_source: "website",
    user_data,
    custom_data: { currency: "BDT", value: Math.max(0, o.total - o.deliveryFee), order_id: String(o.invoiceNo), content_type: "product", contents: o.items.map((i) => ({ id: i.sku, quantity: i.qty, item_price: i.price })) },
  }
}

export const load = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => ({ order: await ctx.db.get(orderId), meta: (await getSetting<any>(ctx, "metaAds")) ?? null }),
})

export const mark = internalMutation({
  args: { orderId: v.id("orders"), event: v.string(), ok: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { orderId, event, ok, note }) => {
    const o = await ctx.db.get(orderId)
    if (!o) return
    await ctx.db.patch(orderId, { metaEvents: { ...(o.metaEvents ?? {}), [event]: { at: Date.now(), ok, ...(note ? { note: note.slice(0, 300) } : {}) } } })
  },
})

export const send = internalAction({
  args: { orderId: v.id("orders"), event: v.union(v.literal("Purchase"), v.literal("Delivered"), v.literal("Returned")) },
  handler: async (ctx, { orderId, event }) => {
    const { order: o, meta } = await ctx.runQuery(internal.metaCapi.load, { orderId })
    if (!o || !meta?.pixelId || !meta?.token || meta.capi === false) return
    if (o.metaEvents?.[event]?.ok) return // already told Meta
    const ev = await buildEvent(o, event)
    if (!ev) return void (await ctx.runMutation(internal.metaCapi.mark, { orderId, event, ok: false, note: "Order is older than 7 days – Meta would reject it" }))
    try {
      const res = await fetch(`${GRAPH}/${meta.pixelId}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: [ev], access_token: meta.token }) })
      const j: any = await res.json().catch(() => ({}))
      if (!res.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${res.status}`)
      await ctx.runMutation(internal.metaCapi.mark, { orderId, event, ok: true })
    } catch (e) { await ctx.runMutation(internal.metaCapi.mark, { orderId, event, ok: false, note: e instanceof Error ? e.message : String(e) }) }
  },
})
