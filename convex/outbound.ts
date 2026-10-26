import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, invoiceLabel } from "./lib"
import { STATUS_LABEL, type OrderStatus } from "./rules"

export const context = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId)
    return {
      order,
      webhook: (await getSetting<any>(ctx, "webhook")) ?? null,
      sms: (await getSetting<any>(ctx, "sms")) ?? null,
      contact: (await getSetting<any>(ctx, "contactPoints")) ?? null,
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
  args: { phone: v.string(), text: v.string(), orderId: v.optional(v.id("orders")), status: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const order = a.orderId ? await ctx.db.get(a.orderId) : null
    await ctx.db.insert("smsLogs", { ...a, customerId: order?.customerId, at: Date.now() })
    if (order && a.status === "sent") {
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

export const sendOrderSms = internalAction({
  args: { orderId: v.id("orders"), status: v.string() },
  handler: async (ctx, { orderId, status }) => {
    const { order, sms, contact } = await ctx.runQuery(internal.outbound.context, { orderId })
    if (!order || !sms?.enabled) return
    const tpl = sms.templates?.[status] || DEFAULT_SMS[status]
    if (!tpl) return
    const amount = sms.valuePreference === "due" ? order.due : order.total
    const text = fill(tpl, {
      name: order.customerName.split(" ")[0], invoice: invoiceLabel(order), amount: String(Math.round(amount)),
      status: STATUS_LABEL[status as OrderStatus] ?? status, courier: order.deliveryPartnerName ?? "courier",
      tracking: order.consignmentId ?? "", hotline: contact?.hotline ?? "", whatsapp: contact?.whatsapp ?? "",
    })
    const error = await sendSms(sms, order.phone, text)
    await ctx.runMutation(internal.outbound.logSms, { phone: order.phone, text, orderId, status: error ? "failed" : "sent", error: error ?? undefined })
  },
})

export const smsSettingsRaw = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "sms")) ?? null })
