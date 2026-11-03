// WhatsApp order verification. After the COD form, the customer taps "Verify on WhatsApp": WhatsApp opens to our
// business number with "Verify BB-12345" already typed. They press Send; we reply at once with a short message (no
// order details) and two buttons: Confirm / Cancel.
//   Confirm → auto-approved (a held order stays held): the order shows "Confirmed on WhatsApp" + a notification in ops; a short message tells them when it arrives, to pick up the
//             courier's call, and that exchange is free.
//   Cancel  → the order is NOT cancelled: it is flagged "pressed Cancel", the team calls, and a still-undecided Pending / On Hold order cancels after 24 hours.
// The customer's own WhatsApp number must match the order's phone: that proves the number is real and stops anyone
// from confirming or cancelling someone else's order. An order whose address or phone looks incomplete gets no
// buttons: the team is asked to call instead, so a wrong address is never "confirmed".
//
// Test mode places nothing on WhatsApp: Settings → WhatsApp verify lets you play the customer and shows the replies.
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { currentStaff, getSetting, invoiceLabel, logOrder, notify, requirePerm, setSetting } from "./lib"
import { applyStatus, insertOrder } from "./orders"
import { canTransition } from "./rules"
import { askList, ratingRows, saveRating } from "./survey"

export type WaConf = { enabled: boolean; mode: "test" | "live"; phoneNumberId: string; businessNumber: string; autoSend?: boolean; templateName?: string; templateLang?: string; lifecycle?: boolean; lifecycleSince?: number; cartReminder?: boolean }
export const DEFAULT_CONF: WaConf = { enabled: false, mode: "test", phoneNumberId: "", businessNumber: "", autoSend: false, templateName: "order_confirmation", templateLang: "en" }
type Secrets = { token?: string; verifyToken?: string; appSecret?: string }
const conf = async (ctx: any): Promise<WaConf> => ({ ...DEFAULT_CONF, ...((await getSetting<WaConf>(ctx, "waVerify")) ?? {}) })
const secrets = async (ctx: any): Promise<Secrets> => (await getSetting<Secrets>(ctx, "waVerifySecrets")) ?? {}

// ---------- small pure helpers ----------
/** The last 10 digits of a phone number, so 8801712345678, +8801712345678 and 01712345678 all compare equal. */
export const phoneKey = (s: string) => (s ?? "").replace(/\D/g, "").slice(-10)
/** The order number in a customer's message: "Verify BB-12345" → { no: 12345 }; legacy codes like SO-0005 → { code }. */
export function invoiceFromText(text: string): { no?: number; code?: string; ext?: string } | null {
  const bb = /\bBB-?\s?(\d{1,9})\b/i.exec(text)
  if (bb) return { no: Number(bb[1]) }
  const legacy = /\b([A-Z]{2,4}-\d{2,9})\b/i.exec(text)
  if (legacy) return { code: legacy[1].toUpperCase() }
  const ext = /#\s?(\d{3,9})\b/.exec(text) // COD Lion's WhatsApp button sends the Shopify order number, e.g. "#29482"
  return ext ? { ext: `#${ext[1]}` } : null
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
// Pre-orders take much longer, so they get their own wording with the pre-order days from Website settings (default "15–20").
export const confirmedText = (o: Doc<"orders">, preOrder: boolean, preOrderDays = "15–20") => preOrder
  ? `Thank you, ${first(o.customerName)}! ✅ Your pre-order ${invoiceLabel(o)} is confirmed.\n\n• Arrival: about ${preOrderDays} days, because your pair is made for you\n• We will message you as soon as it is ready to ship\n• Please keep your phone on and pick up the call from our courier\n• When it arrives, check the size and fit. If anything is not right, we offer free exchange, so there is nothing to worry about\n• You pay the remaining amount only when you receive your order\n\nThank you for waiting for something special.\n\n💬 From now on, every update about your order will come to you right here on WhatsApp from BlackBole. Please keep an eye on our messages. — BlackBole`
  : `Thank you, ${first(o.customerName)}! ✅ Your order ${invoiceLabel(o)} is confirmed.\n\n• Arrival: within 2–3 days\n• Please keep your phone on and pick up the call from our courier, so your parcel reaches you the first time\n• When it arrives, check the size and fit. If anything is not right, we offer free exchange, so there is nothing to worry about\n• You pay only when you receive your order\n\nWe hope you love it.\n\n💬 From now on, every update about your order will come to you right here on WhatsApp from BlackBole. Please keep an eye on our messages. — BlackBole`
/** Short product video(s) for the items in this order (set on the product), sent right after the confirmation text. At most 3. */
async function confirmVideos(ctx: any, o: Doc<"orders">): Promise<Out[]> {
  const out: Out[] = []
  const seen = new Set<string>()
  for (const i of o.items as any[]) {
    if (!i.variantId) continue
    const vr = await ctx.db.get(i.variantId)
    const pr: any = vr ? await ctx.db.get(vr.productId) : null
    const url = String(pr?.waVideoUrl ?? "").trim()
    if (!url || !/^https:\/\//.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ kind: "video", link: url, body: `${pr.name}${vr?.title ? ` · size ${vr.title}` : ""}`.slice(0, 900) })
    if (out.length >= 3) break
  }
  return out
}
const isPre = (o: Doc<"orders">) => !!o.preOrder || o.status.startsWith("pre_order")
const preDays = async (ctx: any) => String(((await getSetting<any>(ctx, "websiteSettings"))?.preOrderDays ?? "15–20")).trim() || "15–20"

type Out = { kind: "text"; body: string } | { kind: "video"; body: string; link: string } | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] } | { kind: "list"; body: string; button: string; rows: { id: string; title: string }[] }
const txt = (body: string): Out => ({ kind: "text", body })

/** Remember the customer's answer on the order (badge in Orders) and tell the team. Confirm does NOT approve: the team decides. */
async function markWa(ctx: any, o: Doc<"orders">, result: "confirmed" | "cancelled" | "cancel_requested", by: string) {
  await ctx.db.patch(o._id, { waVerify: { result, at: Date.now(), by } })
  if (result === "confirmed") await logOrder(ctx, o._id, "Customer confirmed on WhatsApp", by)
  const title = result === "confirmed" ? "Customer confirmed on WhatsApp" : result === "cancel_requested" ? "Customer pressed Cancel on WhatsApp — please call" : "Customer cancelled on WhatsApp"
  await notify(ctx, title, `${invoiceLabel(o)} · ${o.customerName}`, o._id, "action")
}

/** Words that suggest a customer is trying to verify an order (English, Bangla, and the Banglish spellings). */
const VERIFY_WORDS = /verif|confirm|order|কনফার্ম|ভেরিফাই|অর্ডার/i
/** The how-to-verify hint is sent to one customer at most once in this time. */
const HINT_EVERY_MS = 24 * 3600 * 1000

/** A cancel tap does not cancel the order: the team calls first. If nobody decides within this time, a Pending / On Hold order is cancelled. */
export const CANCEL_GRACE_MS = 24 * 3600 * 1000

// ---------- what one customer message does ----------
async function findOrder(ctx: any, ref: { no?: number; code?: string; ext?: string }): Promise<Doc<"orders"> | null> {
  if (ref.ext) {
    const recent: Doc<"orders">[] = await ctx.db.query("orders").withIndex("by_created").order("desc").take(3000)
    return recent.find((r) => !r.deletedAt && r.externalName === ref.ext) ?? null
  }
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

  // ---- rating survey: "Rate now" → 1–10 list → saved + discount code ----
  const sv = a.buttonId ? /^wv:(q|v):([^:]+)(?::(\d+))?$/.exec(a.buttonId) : null
  if (sv) {
    if (sv[1] === "q") {
      const r = await askList(ctx, sv[2], a.waId)
      if (!r) return record("survey_unknown", [txt("Sorry, we could not find this survey. Thank you for being with BlackBole! — BlackBole")])
      if (r.done) return record("survey_done", [txt("Thank you, we already have your rating. — BlackBole")])
      return record("survey_asked", [{ kind: "list", body: "How was your experience with BlackBole, and how is the quality of your shoes? Please choose from 1 (very bad) to 10 (excellent).", button: "Choose rating", rows: ratingRows(sv[2]) }])
    }
    const res = await saveRating(ctx, sv[2], a.waId, Number(sv[3]))
    if (res === "already") return record("survey_done", [txt("Thank you, we already have your rating. — BlackBole")])
    if (res === "invalid") return record("survey_unknown", [txt("Sorry, we could not save that rating. Thank you for being with BlackBole! — BlackBole")])
    return record("survey_rated", [])
  }

  // ---- returned parcel: "Yes, order again" → same product or a different one ----
  const again = a.buttonId ? /^wv:(r|n|s|d):(.+)$/.exec(a.buttonId) : null
  if (again) {
    const id = ctx.db.normalizeId("orders", again[2])
    const o: Doc<"orders"> | null = id ? await ctx.db.get(id) : null
    if (!o || o.deletedAt || mismatch(o)) return record("not_found", [txt("Sorry, we could not find this order. Please contact BlackBole and we will help right away.")])
    const kind = again[1]
    if (kind === "n") return record("reorder_no", [txt("No problem, thank you for letting us know. We hope to see you again. — BlackBole")], o._id)
    if (kind === "r") {
      await logOrder(ctx, o._id, "Customer said Yes on WhatsApp to ordering again after the return — asked same or different product", BY)
      await ctx.db.patch(o._id, { recoveryFollowUpAt: Date.now() })
      await notify(ctx, "Returned customer wants to order again", `${invoiceLabel(o)} · ${o.customerName} · ${o.phone}`, o._id, "action")
      return record("reorder_yes", [{ kind: "buttons", body: `Thank you ${first(o.customerName)}! 🙏 Would you like the same product as before, or a different one?`, buttons: [{ id: `wv:s:${o._id}`, title: "Same product" }, { id: `wv:d:${o._id}`, title: "Different product" }] }], o._id)
    }
    if (kind === "d") {
      await logOrder(ctx, o._id, "Returned customer wants a DIFFERENT product (WhatsApp) — message them to help choose", BY)
      await ctx.db.patch(o._id, { recoveryFollowUpAt: Date.now() })
      await notify(ctx, "Returned customer wants a different product", `${invoiceLabel(o)} · ${o.customerName} · ${o.phone}`, o._id, "action")
      return record("reorder_different", [txt("Sure! Our customer team will message you shortly to help you choose. — BlackBole")], o._id)
    }
    // same product: place a fresh pending order with the same items, once per returned order
    const key = `reorder-same-${o._id}`
    if (await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q: any) => q.eq("wamid", key)).first()) return record("reorder_dup", [txt("Your new order is already placed — our team will call you to confirm it. — BlackBole")], o._id)
    try {
      const res = await insertOrder(ctx, {
        source: o.source, customerName: o.customerName, phone: o.phone, email: o.email, address: o.address, cityName: o.cityName,
        pathaoCityId: o.pathaoCityId, pathaoZoneId: o.pathaoZoneId, pathaoAreaId: o.pathaoAreaId, zoneName: o.zoneName, areaName: o.areaName,
        locationId: o.locationId, deliveryType: o.deliveryType, items: o.items, discount: 0, deliveryFee: o.deliveryFee ?? 0,
        additionalInfo: `REORDER of returned ${invoiceLabel(o)} — customer asked on WhatsApp for the same product. Please call to confirm.`, followUpAt: Date.now(),
      }, BY)
      await ctx.db.insert("waVerifyEvents", { wamid: key, waId: a.waId, orderId: o._id, result: "reorder_marker", out: [], at: Date.now() })
      await logOrder(ctx, o._id, `Customer asked for the same product again on WhatsApp — new order BB-${res.invoiceNo} created`, BY)
      await notify(ctx, "Returned customer re-ordered the same product", `New BB-${res.invoiceNo} · ${o.customerName} · ${o.phone} — please call to confirm`, res.orderId, "action")
      return record("reorder_same", [txt(`Done! We have placed a new order BB-${res.invoiceNo} with the same product. Our team will call you shortly to confirm it. — BlackBole`)], res.orderId)
    } catch (e) {
      await logOrder(ctx, o._id, "Customer wants the same product again (WhatsApp) but the new order could not be created automatically — call them", BY)
      await notify(ctx, "Returned customer wants the same product", `${invoiceLabel(o)} · ${o.customerName} · ${o.phone} — create the order`, o._id, "action")
      return record("reorder_same_manual", [txt("Thank you! Our team will call you shortly to place your new order. — BlackBole")], o._id)
    }
  }

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
        // Confirm = approved. A held order stays held (the team put it there on purpose); if approving fails (e.g. stock), it stays Pending for the team.
        if (o.status === "pending") {
          try { await applyStatus(ctx, o, "approved", BY, "Customer confirmed on WhatsApp") } catch (e) { await logOrder(ctx, o._id, "Customer confirmed on WhatsApp but auto-approve failed — please approve manually", BY) }
        }
        return record("confirmed", [txt(confirmedText(o, isPre(o), await preDays(ctx))), ...(await confirmVideos(ctx, o))], o._id)
      }
      if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} was cancelled. If this is a mistake, please contact BlackBole and we will help.`)], o._id)
      if (o.waVerify?.result === "cancel_requested" && o.status === "approved") {
        await markWa(ctx, o, "confirmed", BY)
        return record("confirmed", [txt(`Thank you! Your order ${invoiceLabel(o)} stays confirmed. — BlackBole`)], o._id)
      }
      return record("already", [txt(`Order ${invoiceLabel(o)} is already confirmed and being prepared. — BlackBole`)], o._id)
    }
    // cancel: do NOT cancel; flag the order and let the team call first (24 hours later a still-undecided Pending / On Hold order is cancelled)
    if (["pending", "on_hold", "approved"].includes(o.status)) {
      if (o.waVerify?.result === "cancel_requested") return record("already", [txt(`We have noted your request for ${invoiceLabel(o)}. Our team will call you shortly. If you change your mind, just tap Confirm. — BlackBole`)], o._id)
      await markWa(ctx, o, "cancel_requested", BY)
      await logOrder(ctx, o._id, "Customer pressed Cancel on WhatsApp — order NOT cancelled, please call the customer (auto-cancels in 24 hours if undecided)", BY)
      await ctx.db.patch(o._id, { followUpAt: Date.now() })
      return record("cancel_requested", [txt(`We have noted your request for order ${invoiceLabel(o)}. Our customer care team will call you shortly. If size, price or delivery time was a worry, we would love to help. If you change your mind, just tap Confirm. — BlackBole`)], o._id)
    }
    if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} is already cancelled.`)], o._id)
    return record("already", [txt(`Order ${invoiceLabel(o)} is already on its way, so it can no longer be cancelled here. Please contact BlackBole.`)], o._id)
  }

  // ---- a text message: "Verify BB-12345" ----
  const ref = invoiceFromText(a.text ?? "")
  if (!ref) {
    // Ordinary chat ("I like the shoe", a size question…) is for the Customer Care team, not the bot. The how-to-verify
    // hint goes out ONLY when the message looks like a verification attempt, and at most once a day per customer —
    // before this it was sent after every message and annoyed customers.
    if (!VERIFY_WORDS.test(a.text ?? "")) return record("chat_ignored", [])
    const since = Date.now() - HINT_EVERY_MS
    const recent = await ctx.db.query("waVerifyEvents").withIndex("by_at", (q: any) => q.gt("at", since)).collect()
    if (recent.some((e: any) => e.waId === a.waId && e.result === "not_found" && (e.out?.length ?? 0) > 0)) return record("chat_ignored", [])
    return record("not_found", [txt("Hi! To verify your order, tap the Verify on WhatsApp button after you place it, or send your order number like: Verify BB-12345")])
  }
  const o = await findOrder(ctx, ref)
  if (!o) return record("not_found", [txt("Sorry, we could not find that order number. Please check it and try again, or contact BlackBole.")])
  if (mismatch(o)) {
    await logOrder(ctx, o._id, "WhatsApp verify: message came from a different number than the order phone — ignored", BY)
    return record("mismatch", [txt("This WhatsApp number does not match the phone number on the order, so we cannot verify it here. Please message from the number you ordered with, or contact BlackBole.")], o._id)
  }
  if (o.status === "cancelled") return record("already", [txt(`Order ${invoiceLabel(o)} was cancelled. Please place a new order or contact BlackBole.`)], o._id)
  if (o.status !== "pending" && o.status !== "on_hold") return record("already", [txt(`Order ${invoiceLabel(o)} is already confirmed. Thank you! — BlackBole`)], o._id)
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
        : m.kind === "video"
          ? { messaging_product: "whatsapp", to, type: "video", video: { link: m.link, caption: m.body } }
        : m.kind === "list"
          ? { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "list", body: { text: m.body }, action: { button: m.button, sections: [{ title: "Rating", rows: m.rows }] } } }
          : { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: m.body }, action: { buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } } }
      try {
        const r = await fetch(graph(c), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
        if (!r.ok) console.error("WhatsApp send failed", r.status, (await r.text()).slice(0, 200))
      } catch (e) { console.error("WhatsApp send error", e) }
    }
  },
})
/** Automatic confirmation: when a new order arrives, send the approved template (order summary + Confirm / Cancel buttons).
 *  Once per order. Test mode only records what would be sent. An order with a weak phone/address gets no buttons: the team calls. */
export const claimAuto = internalMutation({
  args: { orderId: v.id("orders"), preview: v.string() },
  handler: async (ctx, { orderId, preview }) => {
    const o = await ctx.db.get(orderId)
    if (!o || o.deletedAt || o.status !== "pending" || o.waVerify) return null
    const wamid = `auto-${orderId}`
    if (await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", wamid)).first()) return null
    const waId = `88${(o.phone ?? "").replace(/\D/g, "").replace(/^88/, "")}`
    const bad = detailsProblem(o)
    if (bad) {
      await ctx.db.insert("waVerifyEvents", { wamid, waId, orderId, result: "auto_skipped", out: [`not sent: ${bad}`], at: Date.now() })
      return null
    }
    await ctx.db.insert("waVerifyEvents", { wamid, waId, orderId, result: "auto_pending", out: [preview], at: Date.now() })
    return { waId, first: first(o.customerName), invoice: invoiceLabel(o), amount: tk(o.due > 0 ? o.due : o.total), id: o._id }
  },
})
export const finishAuto = internalMutation({
  args: { orderId: v.id("orders"), result: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { orderId, result, note }) => {
    const ev = await ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", `auto-${orderId}`)).first()
    if (ev) await ctx.db.patch(ev._id, { result, ...(note ? { out: [...(ev.out ?? []), note] } : {}) })
    if (result === "auto_sent") await logOrder(ctx, orderId, "WhatsApp confirmation message sent to the customer", "WhatsApp verify")
  },
})
export const sendConfirmation = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const { conf: c, sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!c.enabled || !c.autoSend) return
    const name = (c.templateName || "order_confirmation").trim()
    const m = await ctx.runMutation(internal.whatsappVerify.claimAuto, { orderId, preview: `Template “${name}”` })
    if (!m) return
    if (c.mode !== "live" || !c.phoneNumberId || !sec.token) { await ctx.runMutation(internal.whatsappVerify.finishAuto, { orderId, result: "auto_test", note: `Would send to ${m.waId}: ${m.first}, ${m.invoice}, ${m.amount}` }); return }
    const payload = {
      messaging_product: "whatsapp", to: m.waId, type: "template",
      template: { name, language: { code: c.templateLang || "en" }, components: [
        { type: "body", parameters: [m.first, m.invoice, m.amount].map((text) => ({ type: "text", text })) },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `wv:c:${m.id}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `wv:x:${m.id}` }] },
      ] },
    }
    try {
      const r = await fetch(graph(c), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
      if (r.ok) await ctx.runMutation(internal.whatsappVerify.finishAuto, { orderId, result: "auto_sent" })
      else { const t = (await r.text()).slice(0, 200); console.error("WhatsApp template send failed", r.status, t); await ctx.runMutation(internal.whatsappVerify.finishAuto, { orderId, result: "auto_failed", note: `${r.status} ${t}` }) }
    } catch (e: any) { await ctx.runMutation(internal.whatsappVerify.finishAuto, { orderId, result: "auto_failed", note: String(e?.message ?? e).slice(0, 200) }) }
  },
})
export const liveConf = internalQuery({ args: {}, handler: async (ctx) => ({ conf: await conf(ctx), sec: await secrets(ctx) }) })

/** One-tap fix when customer replies never arrive: subscribes our Meta app to the WhatsApp Business Account so Meta
 *  forwards incoming messages (and button taps) to our webhook. Returns which apps are subscribed afterwards. */
export const connectWebhook = action({
  args: { wabaId: v.string() },
  handler: async (ctx, { wabaId }): Promise<{ ok: boolean; message: string }> => {
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError("Sign in first")
    const id = wabaId.replace(/\D/g, "")
    if (!id) throw new ConvexError("Enter the WhatsApp Business Account ID")
    const { sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!sec.token) throw new ConvexError("Save the access token first")
    const url = `https://graph.facebook.com/v21.0/${id}/subscribed_apps`
    const headers = { Authorization: `Bearer ${sec.token}` }
    try {
      const post = await fetch(url, { method: "POST", headers })
      const postTxt = (await post.text()).slice(0, 300)
      if (!post.ok) return { ok: false, message: `Meta said ${post.status}: ${postTxt}` }
      const get = await fetch(url, { headers })
      const apps = ((await get.json().catch(() => ({})))?.data ?? []).map((a: any) => a?.whatsapp_business_api_data?.name ?? a?.name ?? a?.id).filter(Boolean)
      return { ok: true, message: apps.length ? `Connected. Apps receiving messages: ${apps.join(", ")}` : "Connected." }
    } catch (e: any) { return { ok: false, message: String(e?.message ?? e).slice(0, 200) } }
  },
})

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
    const buttonId = m.type === "interactive" ? (m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id) : m.type === "button" ? m.button?.payload : undefined
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
    const autoSent = n("auto_sent")
    const recent = (await ctx.db.query("waVerifyEvents").withIndex("by_at").order("desc").take(15)).map((e) => ({ ...e }))
    const invoices = new Map<string, string>()
    for (const e of recent) if (e.orderId && !invoices.has(e.orderId)) { const o = await ctx.db.get(e.orderId); if (o) invoices.set(e.orderId, invoiceLabel(o)) }
    return {
      conf: c, hasToken: !!s.token, hasVerifyToken: !!s.verifyToken, hasAppSecret: !!s.appSecret,
      webhookUrl: `${process.env.CONVEX_SITE_URL}/whatsapp/webhook`,
      link: c.businessNumber ? `https://wa.me/${c.businessNumber}?text=${encodeURIComponent("Verify BB-{order number}")}` : null,
      week: { asked: n("asked"), confirmed: n("confirmed"), cancelled: n("cancelled"), addressIssue: n("address_issue"), mismatch: n("mismatch"), autoSent, autoFailed: n("auto_failed") },
      recent: recent.map((e) => ({ ...e, invoice: e.orderId ? invoices.get(e.orderId) ?? "" : "" })),
    }
  },
})

export const saveSettings = mutation({
  args: { enabled: v.boolean(), mode: v.union(v.literal("test"), v.literal("live")), phoneNumberId: v.string(), businessNumber: v.string(), autoSend: v.optional(v.boolean()), lifecycle: v.optional(v.boolean()), lifecycleSince: v.optional(v.number()), cartReminder: v.optional(v.boolean()), templateName: v.optional(v.string()), templateLang: v.optional(v.string()), token: v.optional(v.string()), verifyToken: v.optional(v.string()), appSecret: v.optional(v.string()) },
  handler: async (ctx, { token, verifyToken, appSecret, ...a }) => {
    await requirePerm(ctx, "settings.manage")
    const businessNumber = a.businessNumber.replace(/\D/g, "")
    const cur = await secrets(ctx)
    const nextSec = { token: token?.trim() || cur.token, verifyToken: verifyToken?.trim() || cur.verifyToken, appSecret: appSecret?.trim() || cur.appSecret }
    if (a.enabled && a.mode === "live" && (!a.phoneNumberId.trim() || !businessNumber || !nextSec.token || !nextSec.verifyToken || !nextSec.appSecret))
      throw new ConvexError("Live needs the phone number ID, business number, access token, verify token and app secret.")
    const before = await conf(ctx)
    // parcel updates only ever go to orders placed after they were switched on
    const lifecycleSince = a.lifecycle ? (before.lifecycle && before.lifecycleSince ? before.lifecycleSince : Date.now()) : undefined
    await setSetting(ctx, "waVerify", { ...a, lifecycleSince, phoneNumberId: a.phoneNumberId.trim(), businessNumber, templateName: (a.templateName ?? "order_confirmation").trim() || "order_confirmation", templateLang: (a.templateLang ?? "en").trim() || "en" })
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

/** Cancel requests nobody acted on for 24 hours: a still Pending / On Hold order is cancelled (an Approved one is left for the team). */
export const sweepCancelRequests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const recent: Doc<"orders">[] = await ctx.db.query("orders").withIndex("by_created").order("desc").take(2000)
    const now = Date.now()
    let n = 0
    for (const o of recent) {
      if (o.deletedAt || o.waVerify?.result !== "cancel_requested") continue
      if (now - (o.waVerify.at ?? now) < CANCEL_GRACE_MS) continue
      if (o.status !== "pending" && o.status !== "on_hold") continue
      await applyStatus(ctx, o, "cancelled", "WhatsApp verify", "Customer pressed Cancel on WhatsApp and nobody changed it in 24 hours")
      await ctx.db.patch(o._id, { waVerify: { ...o.waVerify, result: "cancelled", at: now } })
      n++
    }
    return n
  },
})
