import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, invoiceLabel } from "./lib"
import { SMS_STATUSES, STATUS_LABEL, type OrderStatus } from "./rules"

export const context = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId)
    return {
      order,
      webhook: (await getSetting<any>(ctx, "webhook")) ?? null,
      sms: (await getSetting<any>(ctx, "sms")) ?? null,
      contact: (await getSetting<any>(ctx, "contactPoints")) ?? null,
      email: (await getSetting<any>(ctx, "email")) ?? null,
    }
  },
})

export const logWebhook = internalMutation({
  args: { event: v.string(), status: v.number(), orderId: v.optional(v.id("orders")) },
  handler: async (ctx, a) => {
    await ctx.db.insert("webhookLogs", { ...a, at: Date.now() })
  },
})

export const logSms = internalMutation({
  args: { phone: v.string(), text: v.string(), orderId: v.optional(v.id("orders")), status: v.string(), error: v.optional(v.string()), channel: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const order = a.orderId ? await ctx.db.get(a.orderId) : null
    await ctx.db.insert("smsLogs", { ...a, customerId: order?.customerId, at: Date.now() })
    if (order && a.status === "sent" && a.channel !== "email") {
      const c = await ctx.db.get(order.customerId)
      if (c) await ctx.db.patch(c._id, { smsCount: (c.smsCount ?? 0) + 1 })
    }
  },
})

async function hmacHex(secret: string, body: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const sendOrderWebhook = internalAction({
  args: { orderId: v.id("orders"), event: v.string() },
  handler: async (ctx, { orderId, event }) => {
    const { order, webhook } = await ctx.runQuery(internal.outbound.context, { orderId })
    if (!order || !webhook?.url) return
    if (webhook.sources?.length && !webhook.sources.includes(order.source)) return
    const body = JSON.stringify({
      event,
      sent_at: new Date().toISOString(),
      order: {
        id: order._id, invoice: invoiceLabel(order), status: order.status, source: order.source,
        website_order_id: order.externalName ?? null, customer: { name: order.customerName, phone: order.phone, email: order.email ?? null },
        address: order.address, city: order.cityName ?? null, zone: order.zoneName ?? null,
        items: order.items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, price: i.price, discount: i.discount })),
        total: order.total, paid: order.paidAmount, due: order.due, delivery_fee: order.deliveryFee,
        courier: order.deliveryPartnerName ?? null, consignment_id: order.consignmentId ?? null,
      },
    })
    let status = 0
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BlackBole-Event": event,
          ...(webhook.secret ? { "X-BlackBole-Signature": await hmacHex(webhook.secret, body) } : {}),
        },
        body,
      })
      status = res.status
    } catch {
      status = 0
    }
    await ctx.runMutation(internal.outbound.logWebhook, { event, status, orderId })
  },
})

function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
}

export const DEFAULT_SMS: Record<string, string> = {
  pending: "Dear {name}, we received your BlackBole order {invoice} ({amount} Tk). We will call you to confirm.",
  approved: "Dear {name}, your BlackBole order {invoice} is confirmed. Amount: {amount} Tk.",
  ready_to_ship: "Your BlackBole order {invoice} is packed and ready to ship.",
  in_transit: "Your BlackBole order {invoice} is on the way with {courier}. Tracking: {tracking}. Please keep {amount} Tk ready.",
  delivered_paid: "Thank you {name}! Your BlackBole order {invoice} was delivered. Enjoy your purchase.",
  out_for_delivery_paid: "Your BlackBole order {invoice} is out for delivery today. Please keep your phone on. Hotline {hotline}",
  out_for_delivery: "Your BlackBole order {invoice} is out for delivery today. Please keep {amount} Tk ready and your phone on. Hotline {hotline}",
  failed_delivery: "Dear {name}, our courier could not deliver your BlackBole order {invoice}. Please keep your phone on, we will try again. Hotline {hotline}",
  pending_returned: "Dear {name}, your BlackBole order {invoice} is being returned to us. For any help call {hotline}.",
  cancelled: "Your BlackBole order {invoice} was cancelled. For help call {hotline}.",
}

/** How to call the SMS company. REVE SMS (smpp.revesms.com) is built in; any other gateway works with a URL template. */
export function smsRequest(sms: any, phone11: string, text: string): { url: string; method: string; kind: "reve" | "custom" } | null {
  if (sms?.provider === "reve") {
    if (!sms.apiKey || !sms.secretKey) return null
    const q = new URLSearchParams({ apikey: sms.apiKey, secretkey: sms.secretKey, callerID: sms.senderId || "BLACKBOLE", toUser: `88${phone11}`, messageContent: text })
    return { url: `https://smpp.revesms.com:7790/sendtext?${q.toString()}`, method: "GET", kind: "reve" }
  }
  if (!sms?.urlTemplate) return null
  const url = fill(sms.urlTemplate, { phone: encodeURIComponent(`88${phone11}`), phone11: encodeURIComponent(phone11), message: encodeURIComponent(text) })
  return { url, method: sms.method === "POST" ? "POST" : "GET", kind: "custom" }
}

/** Send one SMS; returns null when sent, or a short error. REVE answers {"Status":"0","Text":"ACCEPTD",...} when accepted. */
export async function sendSms(sms: any, phone11: string, text: string): Promise<string | null> {
  const req = smsRequest(sms, phone11, text)
  if (!req) return "SMS is not set up (missing API key / gateway)"
  try {
    const res = await fetch(req.url, { method: req.method })
    const body = await res.text()
    if (!res.ok) return `HTTP ${res.status}`
    if (req.kind === "reve") {
      let j: any = null
      try { j = JSON.parse(body) } catch { return `REVE: ${body.slice(0, 120)}` }
      if (String(j?.Status) !== "0") return `REVE ${j?.Status ?? "?"}: ${j?.Text ?? body.slice(0, 120)}`
    }
    return null
  } catch (e) {
    return String(e).slice(0, 200)
  }
}

/** The customer message for an order status (same text for SMS and email). */
export function orderMessage(order: any, status: string, sms: any, contact: any): string | null {
  const tpl = sms?.templates?.[status] || DEFAULT_SMS[status]
  if (!tpl) return null
  const amount = sms?.valuePreference === "due" ? order.due : order.total
  return fill(tpl, {
    name: order.customerName.split(" ")[0], invoice: invoiceLabel(order), amount: String(Math.round(amount)),
    status: STATUS_LABEL[status as OrderStatus] ?? status, courier: order.deliveryPartnerName ?? "courier",
    tracking: order.consignmentId ?? "", hotline: contact?.hotline ?? "", whatsapp: contact?.whatsapp ?? "",
  })
}

/** Out for delivery / failed delivery may repeat (another attempt) but never twice within this time; every other moment is sent once per order. */
const REPEAT_MS: Record<string, number> = { out_for_delivery: 12 * 3600_000, failed_delivery: 12 * 3600_000 }
/** Only plain English letters keep an SMS at 160 characters; one Bangla letter makes it Unicode (70 per part = costs more). */
const plain = (s: string | undefined | null, fallback: string) => (s && /^[\x20-\x7E]+$/.test(s.trim()) ? s.trim() : fallback)

/** One SMS per moment per order: reserves the send (so two triggers at once can't both go out), or returns null if it was already sent. */
export const claimSms = internalMutation({
  args: { orderId: v.id("orders"), kind: v.string() },
  handler: async (ctx, { orderId, kind }) => {
    const now = Date.now()
    const logs = await ctx.db.query("smsLogs").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect()
    const win = REPEAT_MS[kind]
    if (logs.some((l) => l.kind === kind && (l.status === "sent" || (l.status === "sending" && now - l.at < 5 * 60_000)) && (win === undefined || now - l.at < win))) return null
    return await ctx.db.insert("smsLogs", { phone: "", text: "", orderId, kind, status: "sending", at: now })
  },
})

export const finishSms = internalMutation({
  args: { logId: v.id("smsLogs"), phone: v.string(), text: v.string(), status: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { logId, phone, text, status, error }) => {
    const row = await ctx.db.get(logId)
    if (!row) return
    await ctx.db.patch(logId, { phone, text, status, error })
    const order = row.orderId ? await ctx.db.get(row.orderId) : null
    if (order && status === "sent") {
      const c = await ctx.db.get(order.customerId)
      if (c) await ctx.db.patch(c._id, { smsCount: (c.smsCount ?? 0) + 1 })
    }
  },
})

export const sendOrderSms = internalAction({
  args: { orderId: v.id("orders"), status: v.string() },
  handler: async (ctx, { orderId, status }) => {
    const { order, sms, contact } = await ctx.runQuery(internal.outbound.context, { orderId })
    if (!order || order.deletedAt || !sms?.enabled) return
    if (!(sms.statuses ?? SMS_STATUSES).includes(status)) return // switched off in Settings → SMS & Email
    if (Date.now() - order.createdAt > 60 * 86400_000) return // never message about old parcels
    if (!/^01\d{9}$/.test(order.phone ?? "")) return
    if ((status === "out_for_delivery" || status === "failed_delivery" || status === "pending_returned") && order.isExchange) return
    if ((status === "out_for_delivery" || status === "failed_delivery") && order.status !== "in_transit") return // only while the parcel is with the courier
    const amount = sms.valuePreference === "due" ? order.due : order.total
    // Nothing to collect (already paid): the "keep Tk … ready" version would be wrong.
    const key = status === "out_for_delivery" && !(order.due > 0) && !sms.templates?.[status] ? "out_for_delivery_paid" : status
    const tpl = sms.templates?.[status] || DEFAULT_SMS[key]
    if (!tpl) return
    const logId = await ctx.runMutation(internal.outbound.claimSms, { orderId, kind: status })
    if (!logId) return // already sent for this order
    const text = fill(tpl, {
      name: plain(order.customerName.trim().split(/\s+/)[0], "Customer"), invoice: invoiceLabel(order), amount: String(Math.round(amount)),
      status: STATUS_LABEL[status as OrderStatus] ?? status, courier: plain(order.deliveryPartnerName, "courier"),
      tracking: order.consignmentId ?? "", hotline: contact?.hotline ?? "", whatsapp: contact?.whatsapp ?? "",
    })
    const error = await sendSms(sms, order.phone, text)
    await ctx.runMutation(internal.outbound.finishSms, { logId, phone: order.phone, text, status: error ? "failed" : "sent", error: error ?? undefined })
  },
})

export const smsSettingsRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "sms")) ?? null })

export const emailSettingsRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "email")) ?? null })

export const contactRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "contactPoints")) ?? null })
