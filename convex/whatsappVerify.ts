// WhatsApp order verification. After the COD form, the customer taps "Verify on WhatsApp": WhatsApp opens to our
// business number with "Verify BB-12345" already typed. They press Send; we reply at once with a short message (no
// order details) and two buttons: Confirm / Cancel.
//   Confirm → NOT auto-approved: the order shows "Confirmed on WhatsApp" + a notification in ops; a short message tells them when it arrives, to pick up the
//             courier's call, and that exchange is free.
//   Cancel  → the order shows Cancelled in ops, the customer is told customer care will call, and a follow-up is set.
// The customer's own WhatsApp number must match the order's phone: that proves the number is real and stops anyone
// from confirming or cancelling someone else's order. An order whose address or phone looks incomplete gets no
// buttons: the team is asked to call instead, so a wrong address is never "confirmed".
//
// Test mode places nothing on WhatsApp: Settings → WhatsApp verify lets you play the customer and shows the replies.
import { v, ConvexError } from "convex/values"
import { httpAction, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { currentStaff, getSetting, invoiceLabel, logOrder, notify, requirePerm, setSetting } from "./lib"
import { applyStatus } from "./orders"
import { canTransition } from "./rules"

export type WaConf = { enabled: boolean; mode: "test" | "live"; phoneNumberId: string; businessNumber: string }
export const DEFAULT_CONF: WaConf = { enabled: false, mode: "test", phoneNumberId: "", businessNumber: "" }
type Secrets = { token?: string; verifyToken?: string; appSecret?: string }
const conf = async (ctx: any): Promise<WaConf> => ({ ...DEFAULT_CONF, ...((await getSetting<WaConf>(ctx, "waVerify")) ?? {}) })
const secrets = async (ctx: any): Promise<Secrets> => (await getSetting<Secrets>(ctx, "waVerifySecrets")) ?? {}

// ---------- small pure helpers ----------
/** The last 10 digits of a phone number, so 8801712345678, +8801712345678 and 01712345678 all compare equal. */
export const phoneKey = (s: string) => (s ?? "").replace(/\D/g, "").slice(-10)
/** The order number in a customer's message: "Verify BB-12345" → { no: 12345 }; legacy codes like SO-0005 → { code }. */
export function invoiceFromText(text: string): { no?: number; code?: string } | null {
  const bb = /\bBB-?\s?(\d{1,9})\b/i.exec(text)
  if (bb) return { no: Number(bb[1]) }
  const legacy = /\b([A-Z]{2,4}-\d{2,9})\b/i.exec(text)
  return legacy ? { code: legacy[1].toUpperCase() } : null
}
/** Why this order can't simply be "confirmed" by the customer, or null when phone and address look usable. */
export function detailsProblem(o: { phone: string; address: string; cityName?: string }): string | null {
  if (!/^01[3-9]\d{8}$/.test((o.phone ?? "").replace(/\D/g, "").replace(/^88/, ""))) return "the phone number looks incomplete"
  if ((o.address ?? "").trim().length < 12 || /^[\d\s,.-]+$/.test(o.address ?? "")) return "the address looks too short"
  return null
}
const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "there"
const tk = (n: number) => `Tk ${Math.round(n).toLocaleString("en-IN")}`

/** Short and without order details: the customer only decides Confirm or Cancel. */
export function summaryText(o: Doc<"orders">): string {
  return `Hi ${first(o.customerName)}, thank you for choosing BlackBole! 🙏 Please tap Confirm to place your order ${invoiceLabel(o)}. If you have changed your mind, tap Cancel.`
}
// Wording is written to cut returns: a clear arrival time, a reminder to answer the courier, a size/fit check, and free exchange.
export const confirmedText = (o: Doc<"orders">, preOrder: boolean) => preOrder
  ? `Thank you, ${first(o.customerName)}! ✅ Your pre-order ${invoiceLabel(o)} is confirmed.\n\nWe will message you the moment it is ready to ship. Please keep this number active so our courier can reach you.\n\nNot the right size or fit? We offer free exchange, so there is nothing to worry about.\n\n— BlackBole`
  : `Thank you, ${first(o.customerName)}! ✅ Your order ${invoiceLabel(o)} is confirmed.\n\n• Arrival: within 2–3 days\n• Please keep your phone on and pick up the call from our courier, so your parcel reaches you the first time\n• When it arrives, check the size and fit. If anything is not right, we offer free exchange, so there is nothing to worry about\n• You pay only when you receive your order\n\nWe hope you love it. — BlackBole`
type Out = { kind: "text"; body: string } | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
const txt = (body: string): Out => ({ kind: "text", body })

/** Remember the customer's answer on the order (badge in Orders) and tell the team. Confirm does NOT approve: the team decides. */
async function markWa(ctx: any, o: Doc<"orders">, result: "confirmed" | "cancelled", by: string) {
  await ctx.db.patch(o._id, { waVerify: { result, at: Date.now(), by } })
  if (result === "confirmed") await logOrder(ctx, o._id, "Customer confirmed on WhatsApp", by)
  await notify(ctx, result === "confirmed" ? "Customer confirmed on WhatsApp" : "Customer cancelled on WhatsApp", `${invoiceLabel(o)} · ${o.customerName}`, o._id, "action")
}

// ---------- what one customer message does ----------
async function findOrder(ctx: any, ref: { no?: number; code?: string }): Promise<Doc<"orders"> | null> {
  const rows: Doc<"orders">[] = ref.code
    ? await ctx.db.query("orders").withIndex("by_invoice_code", (q: any) => q.eq("invoiceCode", ref.code)).collect()
    : await ctx.db.query("orders").withIndex("by_invoice", (q: any) => q.eq("invoiceNo", ref.no)).collect()
  return rows.find((r) => !r.deletedAt) ?? null
}

export async function handleInbound(ctx: any, a: { waId: string; wamid: string; text?: string; buttonId?: string }): Promise<{ out: Out[]; result: string; orderId?: Doc<"orders">["_id"] }> {
  const BY = "WhatsApp verify"
  const seen = await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q: any) => q.eq("wamid", a.wamid)).first()
  if (seen) return { out: [], result: "ignored" }
  const record = async (result: string, out: Out[], orderId?: Doc<"orders">["_id"]) => {
    await ctx.db.insert("waVerifyEvents", { wamid: a.wamid, waId: a.waId, orderId, result, out: out.map((o) => o.body), at: Date.now() })
    return { out, result, orderId }
  }
  const mismatch = (o: Doc<"orders">) => phoneKey(a.waId) !== phoneKey(o.phone)

  // ---- a button was tapped: Confirm / Cancel ----
  const btn = a.buttonId ? /^wv:(c|x):(.+)$/.exec(a.buttonId) : null
  if (btn) {
    const id = ctx.db.normalizeId("orders", btn[2])
    const o: Doc<"orders"> | null = id ? await ctx.db.get(id) : null
    if (!o || o.deletedAt) return record("not_found", [txt("Sorry, we could not find this order. Please contact BlackBole and we will help right away.")])
    if (mismatch(o)) {
      await logOrder(ctx, o._id, "WhatsApp verify: a different WhatsApp number tried to confirm/cancel — ignored", BY)
      return record("mismatch", [txt("This WhatsApp number does not match the phone number on the order, so we cannot change it from here. Please contact BlackBole.")], o._id)
    }
    if (btn[1] === "c") {
      if (o.waVerify?.result === "confirmed" && (o.status === "pending" || o.status === "on_hold")) return record("already", [txt(`Order ${invoiceLabel(o)} is already confirmed. Thank you! — BlackBole`)], o._id)
      if (o.status === "pending" || o.status === "on_hold") {
        const bad = detailsProblem(o)
        if (bad) {
          await logOrder(ctx, o._id, `WhatsApp verify: customer pressed Confirm but ${bad} — NOT approved, please call the customer`, BY)
          await ctx.db.patch(o._id, { followUpAt: Date.now() })
          return record("address_issue", [txt(`Thank you! One more check: ${bad}. Our team will call you shortly to complete it. — BlackBole`)], o._id)
        }
        await markWa(ctx, o, "confirmed", BY)
        return record("confirmed", [txt(confirmedText(o, o.status.startsWith("pre_order")))], o._id)
      }
      if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} was cancelled. If this is a mistake, please contact BlackBole and we will help.`)], o._id)
      return record("already", [txt(`Order ${invoiceLabel(o)} is already confirmed and being prepared. — BlackBole`)], o._id)
    }
    // cancel
    if (canTransition(o.status as any, "cancelled") && !["cancelled"].includes(o.status) && ["pending", "on_hold", "approved"].includes(o.status)) {
      await applyStatus(ctx, o, "cancelled", BY, "Customer cancelled on WhatsApp")
      await markWa(ctx, o, "cancelled", BY)
      await ctx.db.patch(o._id, { followUpAt: Date.now() }) // customer care calls to check why
      return record("cancelled", [txt(`Your order ${invoiceLabel(o)} has been cancelled. Our customer care team will call you shortly. If size, price or delivery time was a worry, we would love to help. — BlackBole`)], o._id)
    }
    if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} is already cancelled.`)], o._id)
    return record("already", [txt(`Order ${invoiceLabel(o)} is already on its way, so it can no longer be cancelled here. Please contact BlackBole.`)], o._id)
  }

  // ---- a text message: "Verify BB-12345" ----
  const ref = invoiceFromText(a.text ?? "")
  if (!ref) return record("not_found", [txt("Hi! To verify your order, tap the Verify on WhatsApp button after you place it, or send your order number like: Verify BB-12345")])
  const o = await findOrder(ctx, ref)
  if (!o) return record("not_found", [txt("Sorry, we could not find that order number. Please check it and try again, or contact BlackBole.")])
  if (mismatch(o)) {
    await logOrder(ctx, o._id, "WhatsApp verify: message came from a different number than the order phone — ignored", BY)
    return record("mismatch", [txt("This WhatsApp number does not match the phone number on the order, so we cannot verify it here. Please message from the number you ordered with, or contact BlackBole.")], o._id)
  }
  if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} was cancelled. Please place a new order or contact BlackBole.`)], o._id)
  if (o.status !== "pending" && o.status !== "on_hold") return record("already", [txt(`Order ${invoiceLabel(o)} is already confirmed. ${confirmedText(o, o.status.startsWith("pre_order")).split("! ")[1] ?? ""}`)], o._id)
  const bad = detailsProblem(o)
  if (bad) {
    await logOrder(ctx, o._id, `WhatsApp verify: customer opened verification but ${bad} — please call to complete`, BY)
    await ctx.db.patch(o._id, { followUpAt: Date.now() })
    return record("address_issue", [txt(`Thank you ${first(o.customerName)}! Before we can confirm ${invoiceLabel(o)}, ${bad}. Our team will call you shortly to complete it. — BlackBole`)], o._id)
  }
  await logOrder(ctx, o._id, "WhatsApp verify: summary sent to the customer", BY)
  return record("asked", [{ kind: "buttons", body: summaryText(o), buttons: [{ id: `wv:c:${o._id}`, title: "Confirm" }, { id: `wv:x:${o._id}`, title: "Cancel" }] }], o._id)
}

export const inbound = internalMutation({
  args: { waId: v.string(), wamid: v.string(), text: v.optional(v.string()), buttonId: v.optional(v.string()) },
  handler: async (ctx, a) => await handleInbound(ctx, a),
})

// ---------- sending ----------
const graph = (c: WaConf) => `https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`
export const deliver = internalAction({
  args: { to: v.string(), out: v.array(v.any()) },
  handler: async (ctx, { to, out }) => {
    const { conf: c, sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (c.mode !== "live" || !c.enabled || !c.phoneNumberId || !sec.token) return
    for (const m of out as Out[]) {
      const payload = m.kind === "text"
        ? { messaging_product: "whatsapp", to, type: "text", text: { body: m.body } }
        : { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: m.body }, action: { buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } } }
      try {
        const r = await fetch(graph(c), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
        if (!r.ok) console.error("WhatsApp send failed", r.status, (await r.text()).slice(0, 200))
      } catch (e) { console.error("WhatsApp send error", e) }
    }
  },
})
export const liveConf = internalQuery({ args: {}, handler: async (ctx) => ({ conf: await conf(ctx), sec: await secrets(ctx) }) })

// ---------- Meta's webhook ----------
async function validSignature(secret: string | undefined, raw: string, header: string | null) {
  if (!secret) return true // not configured yet: accept (test mode); live mode requires the app secret to be saved
  if (!header?.startsWith("sha256=")) return false
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("")
  return hex === header.slice(7)
}

export const webhook = httpAction(async (ctx, req) => {
  const { conf: c, sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
  if (req.method === "GET") { // Meta checks the address once, with our verify token
    const u = new URL(req.url)
    if (u.searchParams.get("hub.mode") === "subscribe" && sec.verifyToken && u.searchParams.get("hub.verify_token") === sec.verifyToken) return new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 })
    return new Response("forbidden", { status: 403 })
  }
  const raw = await req.text()
  if (c.mode === "live" && !sec.appSecret) return new Response("app secret not set", { status: 401 })
  if (!(await validSignature(sec.appSecret, raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 })
  if (!c.enabled) return new Response("ok", { status: 200 })
  let body: any
  try { body = JSON.parse(raw) } catch { return new Response("ok", { status: 200 }) }
  for (const entry of body?.entry ?? []) for (const ch of entry?.changes ?? []) for (const m of ch?.value?.messages ?? []) {
    const text = m.type === "text" ? m.text?.body : undefined
    const buttonId = m.type === "interactive" ? m.interactive?.button_reply?.id : m.type === "button" ? m.button?.payload : undefined
    if (!m.from || !m.id || (!text && !buttonId)) continue
    try {
      const r = await ctx.runMutation(internal.whatsappVerify.inbound, { waId: String(m.from), wamid: String(m.id), text, buttonId })
      if (r.out.length) await ctx.runAction(internal.whatsappVerify.deliver, { to: String(m.from), out: r.out })
    } catch (e) { console.error("WhatsApp verify failed", e) }
  }
  return new Response("ok", { status: 200 }) // always answer fast so Meta does not resend
})

// ---------- Settings → WhatsApp verify ----------
export const settings = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) return null
    const c = await conf(ctx)
    const s = await secrets(ctx)
    const week = await ctx.db.query("waVerifyEvents").withIndex("by_at", (q) => q.gte("at", Date.now() - 7 * 86400000)).collect()
    const n = (r: string) => week.filter((e) => e.result === r).length
    const recent = (await ctx.db.query("waVerifyEvents").withIndex("by_at").order("desc").take(15)).map((e) => ({ ...e }))
    const invoices = new Map<string, string>()
    for (const e of recent) if (e.orderId && !invoices.has(e.orderId)) { const o = await ctx.db.get(e.orderId); if (o) invoices.set(e.orderId, invoiceLabel(o)) }
    return {
      conf: c, hasToken: !!s.token, hasVerifyToken: !!s.verifyToken, hasAppSecret: !!s.appSecret,
      webhookUrl: `${process.env.CONVEX_SITE_URL}/whatsapp/webhook`,
      link: c.businessNumber ? `https://wa.me/${c.businessNumber}?text=${encodeURIComponent("Verify BB-{order number}")}` : null,
      week: { asked: n("asked"), confirmed: n("confirmed"), cancelled: n("cancelled"), addressIssue: n("address_issue"), mismatch: n("mismatch") },
      recent: recent.map((e) => ({ ...e, invoice: e.orderId ? invoices.get(e.orderId) ?? "" : "" })),
    }
  },
})

export const saveSettings = mutation({
  args: { enabled: v.boolean(), mode: v.union(v.literal("test"), v.literal("live")), phoneNumberId: v.string(), businessNumber: v.string(), token: v.optional(v.string()), verifyToken: v.optional(v.string()), appSecret: v.optional(v.string()) },
  handler: async (ctx, { token, verifyToken, appSecret, ...a }) => {
    await requirePerm(ctx, "settings.manage")
    const businessNumber = a.businessNumber.replace(/\D/g, "")
    const cur = await secrets(ctx)
    const nextSec = { token: token?.trim() || cur.token, verifyToken: verifyToken?.trim() || cur.verifyToken, appSecret: appSecret?.trim() || cur.appSecret }
    if (a.enabled && a.mode === "live" && (!a.phoneNumberId.trim() || !businessNumber || !nextSec.token || !nextSec.verifyToken || !nextSec.appSecret))
      throw new ConvexError("Live needs the phone number ID, business number, access token, verify token and app secret.")
    await setSetting(ctx, "waVerify", { ...a, phoneNumberId: a.phoneNumberId.trim(), businessNumber })
    await setSetting(ctx, "waVerifySecrets", nextSec)
  },
})

/** Test mode: play the customer. "start" sends "Verify BB-…"; "confirm" / "cancel" press the buttons. Returns what we would reply. */
export const simulate = mutation({
  args: { invoice: v.string(), step: v.union(v.literal("start"), v.literal("confirm"), v.literal("cancel")) },
  handler: async (ctx, { invoice, step }) => {
    await requirePerm(ctx, "settings.manage")
    const ref = invoiceFromText(invoice) ?? invoiceFromText(`BB-${invoice.replace(/\D/g, "")}`)
    if (!ref) throw new ConvexError("Type an order number like BB-12345")
    const o = await findOrder(ctx, ref)
    if (!o) throw new ConvexError("No order with that number")
    const waId = `88${o.phone.replace(/\D/g, "").replace(/^88/, "")}`
    const wamid = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const r = await handleInbound(ctx, step === "start" ? { waId, wamid, text: `Verify ${invoiceLabel(o)}` } : { waId, wamid, buttonId: `wv:${step === "confirm" ? "c" : "x"}:${o._id}` })
    return { result: r.result, replies: r.out.map((m) => m.body) }
  },
})

/** Manual version for while there is no API number: the team reads the WhatsApp chat and records the answer here. */
export const markManual = mutation({
  args: { orderId: v.id("orders"), result: v.union(v.literal("confirmed"), v.literal("cancelled")) },
  handler: async (ctx, { orderId, result }) => {
    const me = await requirePerm(ctx, "orders.edit")
    const o = await ctx.db.get(orderId)
    if (!o || o.deletedAt) throw new ConvexError("Order not found")
    const by = (me as any)?.name ?? "Staff"
    if (result === "cancelled" && ["pending", "on_hold", "approved"].includes(o.status)) {
      await applyStatus(ctx, o, "cancelled", by, "Customer cancelled on WhatsApp")
      await ctx.db.patch(o._id, { followUpAt: Date.now() })
    }
    await markWa(ctx, o, result, by)
  },
})
