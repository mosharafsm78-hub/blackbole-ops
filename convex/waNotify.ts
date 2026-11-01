// WhatsApp parcel updates for the customer: shipped, out for delivery, failed attempt (with Pathao's reason),
// delivered, returned (with a "Yes, order again" button that becomes a lead for the team).
// Off unless Settings → WhatsApp verify → "Send parcel updates" is on. Only orders placed AFTER it was switched on are
// messaged, so turning it on never sends anything about old parcels. Test mode only records what would be sent.
import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, invoiceLabel, logOrder } from "./lib"

export type Kind = "shipped" | "out_for_delivery" | "failed" | "delivered" | "returned"
type Params = { first: string; invoice: string; amount: string; reason: string; rider: string; riderPhone: string; tracking: string }
/** Template names as created in Meta. Variables are numbered in the order of `params`. */
export const TEMPLATES: Record<Kind, { name: string; params: (m: Params) => string[]; buttons?: "reorder" }> = {
  // order_shipped in Meta: "Hi {{1}}, … order {{2}} has been handed to our courier (tracking ID {{3}}). You pay {{4}} on delivery…"
  shipped: { name: "order_shipped", params: (m) => [m.first, m.invoice, m.tracking, m.amount] },
  out_for_delivery: { name: "out_for_delivery", params: (m) => [m.first, m.invoice, m.amount] },
  failed: { name: "delivery_failed_v3", params: (m) => [m.first, m.invoice, m.reason] },
  delivered: { name: "order_delivered_v2", params: (m) => [m.first, m.invoice] },
  returned: { name: "order_returned_v3", params: (m) => [m.first, m.invoice] }, // plain Utility notice, no re-order button
}
/** Out for delivery with the rider's name and phone (from Pathao) when we have them; otherwise the plain version. */
const OUT_WITH_RIDER = { name: "out_for_delivery_v2", params: (m: Params) => [m.first, m.invoice, m.rider, m.riderPhone, m.amount] }
// Messages listed here are switched off (none right now). returned is back on: order_returned_v3 is an approved Utility template (about Tk 0.45).
const OFF = new Set<string>([])
const KINDS = new Set<string>(Object.keys(TEMPLATES).filter((k) => !OFF.has(k)))

const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "there"
/** WhatsApp variables can't hold line breaks or long runs of spaces. */
export const cleanReason = (r?: string) => {
  const t = String(r ?? "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140)
  return t || "we could not reach you on the phone"
}

/** Decide whether this order should get this message now. Returns what to send, or null. Once per order for
 *  shipped / delivered / returned; failed and out-for-delivery can repeat but not within 4 hours. */
export const claim = internalMutation({
  args: { orderId: v.id("orders"), kind: v.string(), reason: v.optional(v.string()), rider: v.optional(v.string()), riderPhone: v.optional(v.string()) },
  handler: async (ctx, { orderId, kind, reason, rider, riderPhone }) => {
    const c: any = (await getSetting<any>(ctx, "waVerify")) ?? {}
    if (!c.enabled || !c.lifecycle || !KINDS.has(kind)) return null
    const o = await ctx.db.get(orderId)
    if (!o || o.deletedAt) return null
    if (o.isExchange) return null // exchange parcels go by the exchange partner; their messages are handled by the team
    if (!c.lifecycleSince || o.createdAt < c.lifecycleSince) return null // old parcels are never messaged
    const digits = (o.phone ?? "").replace(/\D/g, "").replace(/^88/, "")
    if (!/^01[3-9]\d{8}$/.test(digits)) return null
    const repeat = kind === "failed" || kind === "out_for_delivery"
    const wamid = repeat ? `n-${kind}-${orderId}-${Math.floor(Date.now() / (4 * 3600_000))}` : `n-${kind}-${orderId}`
    if (await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", wamid)).first()) return null
    const waId = `88${digits}`
    const amountNum = o.due > 0 ? o.due : 0
    if ((kind === "out_for_delivery" || kind === "shipped") && amountNum <= 0) return null // nothing to collect: "you pay Tk 0" would be wrong
    if ((kind === "failed" || kind === "out_for_delivery") && o.status !== "in_transit") return null // only while the parcel is with the courier
    if (kind === "shipped" && (o.status !== "in_transit" || !o.consignmentId)) return null // already delivered/returned by the time we run, or no tracking ID yet // nothing to collect: skip the "keep Tk … ready" message
    await ctx.db.insert("waVerifyEvents", { wamid, waId, orderId, result: "life_pending", out: [`${kind}: ${TEMPLATES[kind as Kind].name}`], at: Date.now() })
    return {
      wamid, waId, id: o._id, mode: c.mode as string, phoneNumberId: String(c.phoneNumberId ?? ""), lang: String(c.templateLang || "en"),
      params: { first: first(o.customerName), invoice: invoiceLabel(o), amount: `Tk ${Math.round(amountNum).toLocaleString("en-IN")}`, reason: cleanReason(reason), tracking: String(o.consignmentId ?? ""), rider: cleanReason(rider).replace(/^we could not reach you on the phone$/, ""), riderPhone: String(riderPhone ?? "").replace(/[^\d+]/g, "") } as Params,
    }
  },
})

export const finish = internalMutation({
  args: { wamid: v.string(), orderId: v.id("orders"), result: v.string(), note: v.optional(v.string()), kind: v.string() },
  handler: async (ctx, { wamid, orderId, result, note, kind }) => {
    const ev = await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", wamid)).first()
    if (ev) await ctx.db.patch(ev._id, { result, ...(note ? { out: [...(ev.out ?? []), note] } : {}) })
    if (result === "life_sent") await logOrder(ctx, orderId, `WhatsApp parcel update sent to the customer (${kind.replace(/_/g, " ")})`, "WhatsApp")
    if (result === "life_failed") await logOrder(ctx, orderId, `WhatsApp parcel update (${kind.replace(/_/g, " ")}) could not be sent`, "WhatsApp")
  },
})

export const send = internalAction({
  args: { orderId: v.id("orders"), kind: v.string(), reason: v.optional(v.string()), rider: v.optional(v.string()), riderPhone: v.optional(v.string()), hold: v.optional(v.boolean()) },
  handler: async (ctx, { orderId, kind, reason, rider, riderPhone, hold }) => {
    // The Pathao status feed rarely carries the rider or the reason; the tracking log does.
    if ((kind === "out_for_delivery" && !(rider && riderPhone)) || (kind === "failed" && (!reason || hold))) {
      const live = await ctx.runAction(internal.pathao.liveDetails, { orderId })
      // Pathao also puts parcels "on hold" at pickup or for other reasons: only a hold AT DELIVERY is a failed attempt
      if (kind === "failed" && hold && !live.heldAtDelivery) return
      if (kind === "out_for_delivery") { rider = rider || live.rider; riderPhone = riderPhone || live.riderPhone }
      else reason = reason || live.reason
    }
    const m = await ctx.runMutation(internal.waNotify.claim, { orderId, kind, reason, rider, riderPhone })
    if (!m) return
    const t: { name: string; params: (m: Params) => string[]; buttons?: "reorder" } = kind === "out_for_delivery" && m.params.rider && m.params.riderPhone ? OUT_WITH_RIDER : TEMPLATES[kind as Kind]
    const { sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (m.mode !== "live" || !m.phoneNumberId || !sec.token) {
      await ctx.runMutation(internal.waNotify.finish, { wamid: m.wamid, orderId, kind, result: "life_test", note: `Would send ${t.name} to ${m.waId}: ${t.params(m.params).join(" | ")}` })
      return
    }
    const components: any[] = [{ type: "body", parameters: t.params(m.params).map((text) => ({ type: "text", text })) }]
    if (t.buttons === "reorder") {
      components.push({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `wv:r:${m.id}` }] })
      components.push({ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `wv:n:${m.id}` }] })
    }
    const payload = { messaging_product: "whatsapp", to: m.waId, type: "template", template: { name: t.name, language: { code: m.lang }, components } }
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${m.phoneNumberId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
      if (r.ok) await ctx.runMutation(internal.waNotify.finish, { wamid: m.wamid, orderId, kind, result: "life_sent" })
      else { const body = (await r.text()).slice(0, 200); console.error("WhatsApp parcel update failed", r.status, body); await ctx.runMutation(internal.waNotify.finish, { wamid: m.wamid, orderId, kind, result: "life_failed", note: `${r.status} ${body}` }) }
    } catch (e: any) {
      await ctx.runMutation(internal.waNotify.finish, { wamid: m.wamid, orderId, kind, result: "life_failed", note: String(e?.message ?? e).slice(0, 200) })
    }
  },
})
