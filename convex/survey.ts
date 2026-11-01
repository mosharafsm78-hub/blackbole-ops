// Customer satisfaction survey on WhatsApp.
//   1. 2 days after a parcel is delivered (and once for past customers, on the owner's click) we send the approved
//      template "rate_experience_v2" with a "Rate now" button.
//   2. Tapping it opens a 1–10 list. The answer is saved here (Ops → Satisfaction) and the customer gets a thank-you
//      with a one-time Shopify discount code: 1–5 → Tk 100, 6–8 → Tk 200, 9–10 → Tk 300.
// Off until switched on in Settings → WhatsApp verify. Test mode records what would be sent and creates no real code.
import { v, ConvexError } from "convex/values"
import { action, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { getSetting, invoiceLabel, notify, logOrder, requirePerm, setSetting } from "./lib"
import { shopifyGql } from "./shopifyStock"

export const TEMPLATE = "rate_experience_v2"
const DAY = 86400000
const AGAIN_DAYS = 60 // one survey per phone number in this time
const MIN_ORDER = 1500 // discount codes work on orders from this amount (a Tk 200 pre-order booking must never become free)
const CODE_DAYS = 30

export const discountFor = (rating: number) => (rating <= 5 ? 100 : rating <= 8 ? 200 : 300)
const LABEL: Record<number, string> = { 1: "1 - Very bad", 2: "2 - Bad", 3: "3 - Poor", 4: "4 - Below average", 5: "5 - Average", 6: "6 - Okay", 7: "7 - Good", 8: "8 - Very good", 9: "9 - Great", 10: "10 - Excellent" }
export const ratingRows = (surveyId: string) => Array.from({ length: 10 }, (_, i) => ({ id: `wv:v:${surveyId}:${i + 1}`, title: LABEL[i + 1] }))

type Cfg = { enabled?: boolean; since?: number; past?: { active: boolean; from: number; cursor: number; startedAt: number; pausedUntil?: number; sent: number; scanned: number } }
const cfgOf = async (ctx: any): Promise<Cfg> => (await getSetting<Cfg>(ctx, "waSurvey")) ?? {}
export const getCfg = internalQuery({ args: {}, handler: async (ctx) => await cfgOf(ctx) })
export const putCfg = internalMutation({ args: { c: v.any() }, handler: async (ctx, { c }) => { await setSetting(ctx, "waSurvey", c) } })

const DELIVERED = ["delivered_due", "delivered_paid"]
const waIdOf = (phone: string) => {
  const d = (phone ?? "").replace(/\D/g, "").replace(/^88/, "")
  return /^01[3-9]\d{8}$/.test(d) ? `88${d}` : null
}
const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "there"

/** Can this order be asked for a rating right now? (Pure rule, used by claim.) */
async function eligible(ctx: any, o: Doc<"orders"> | null): Promise<{ waId: string } | null> {
  if (!o || o.deletedAt || o.isExchange || !DELIVERED.includes(o.status)) return null
  const waId = waIdOf(o.phone)
  if (!waId) return null
  if (await ctx.db.query("surveys").withIndex("by_order", (q: any) => q.eq("orderId", o._id)).first()) return null
  const recent = await ctx.db.query("surveys").withIndex("by_phone", (q: any) => q.eq("waId", waId)).order("desc").first()
  if (recent && recent.result !== "skipped" && recent.result !== "failed" && Date.now() - recent.askedAt < AGAIN_DAYS * DAY) return null
  return { waId }
}

export const claim = internalMutation({
  args: { orderId: v.id("orders"), batch: v.string() },
  handler: async (ctx, { orderId, batch }) => {
    const o = await ctx.db.get(orderId)
    const ok = await eligible(ctx, o)
    if (!ok || !o) return null
    const id = await ctx.db.insert("surveys", { orderId, waId: ok.waId, customerName: o.customerName, askedAt: Date.now(), batch, result: "pending" })
    return { surveyId: id, waId: ok.waId, first: first(o.customerName) }
  },
})

export const finish = internalMutation({
  args: { surveyId: v.id("surveys"), result: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { surveyId, result, note }) => {
    const s = await ctx.db.get(surveyId)
    if (!s || s.result === "rated") return
    await ctx.db.patch(surveyId, { result, ...(note ? { note } : {}) })
  },
})

/** Send the rating invitation for one delivered order. Returns whether Meta said the account is rate-limited. */
export const send = internalAction({
  args: { orderId: v.id("orders"), batch: v.string() },
  handler: async (ctx, { orderId, batch }): Promise<{ sent: boolean; rateLimited?: boolean }> => {
    const m = await ctx.runMutation(internal.survey.claim, { orderId, batch })
    if (!m) return { sent: false }
    const { conf: c, sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!c.enabled || c.mode !== "live" || !c.phoneNumberId || !sec.token) {
      await ctx.runMutation(internal.survey.finish, { surveyId: m.surveyId, result: "test", note: `Would send ${TEMPLATE} to ${m.waId} (${m.first})` })
      return { sent: false }
    }
    const payload = {
      messaging_product: "whatsapp", to: m.waId, type: "template",
      template: { name: TEMPLATE, language: { code: c.templateLang || "en" }, components: [
        { type: "body", parameters: [{ type: "text", text: m.first }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `wv:q:${m.surveyId}` }] },
      ] },
    }
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
      if (r.ok) { await ctx.runMutation(internal.survey.finish, { surveyId: m.surveyId, result: "sent" }); return { sent: true } }
      const body = (await r.text()).slice(0, 240)
      console.error("Survey send failed", r.status, body)
      await ctx.runMutation(internal.survey.finish, { surveyId: m.surveyId, result: "failed", note: `${r.status} ${body}` })
      return { sent: false, rateLimited: /130429|131049|131056|80007/.test(body) }
    } catch (e: any) {
      await ctx.runMutation(internal.survey.finish, { surveyId: m.surveyId, result: "failed", note: String(e?.message ?? e).slice(0, 200) })
      return { sent: false }
    }
  },
})

// ---------- what the customer does ----------
/** "Rate now" tapped: the 1–10 list. Only the number the survey was sent to may answer. */
export async function askList(ctx: any, surveyId: string, waId: string) {
  const id = ctx.db.normalizeId("surveys", surveyId)
  const s: Doc<"surveys"> | null = id ? await ctx.db.get(id) : null
  if (!s || s.waId !== waId) return null
  if (s.result === "rated") return { done: true as const, s }
  return { done: false as const, s }
}

/** A number was chosen: save it once, then issue the code. */
export async function saveRating(ctx: any, surveyId: string, waId: string, n: number): Promise<"saved" | "already" | "invalid"> {
  const id = ctx.db.normalizeId("surveys", surveyId)
  const s: Doc<"surveys"> | null = id ? await ctx.db.get(id) : null
  if (!s || s.waId !== waId || !Number.isInteger(n) || n < 1 || n > 10) return "invalid"
  if (s.result === "rated") return "already"
  await ctx.db.patch(s._id, { result: "rated", rating: n, ratedAt: Date.now(), discount: discountFor(n) })
  const o = await ctx.db.get(s.orderId)
  if (o) await logOrder(ctx, o._id, `Customer rated us ${n}/10 on WhatsApp`, "WhatsApp survey")
  if (n <= 5) await notify(ctx, `Low rating: ${n}/10`, `${o ? invoiceLabel(o) : ""} · ${s.customerName} · ${s.waId} — please call and listen`, s.orderId, "action")
  await ctx.scheduler.runAfter(0, internal.survey.issueCode, { surveyId: s._id })
  return "saved"
}

const thanks = (name: string, n: number, amount: number, code: string | null) =>
  code
    ? `Thank you ${first(name)}! 🙏 You rated us ${n}/10.\n\nWelcome to the BlackBole family! 💛 As a thank-you, here is your Tk ${amount} discount code for your next order:\n\n*${code}*\n\nValid for ${CODE_DAYS} days on orders of Tk ${MIN_ORDER.toLocaleString("en-IN")} or more at blackbole.top. — BlackBole`
    : `Thank you ${first(name)}! 🙏 You rated us ${n}/10.\n\nWelcome to the BlackBole family! 💛 Our team will send your Tk ${amount} discount code for your next order very soon. — BlackBole`

const randomCode = () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")

export const surveyById = internalQuery({ args: { id: v.id("surveys") }, handler: async (ctx, { id }) => await ctx.db.get(id) })
export const saveCode = internalMutation({
  args: { id: v.id("surveys"), code: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, { id, code, note }) => {
    const s = await ctx.db.get(id)
    if (!s) return
    await ctx.db.patch(id, { ...(code ? { code } : {}), ...(note ? { note } : {}) })
    if (!code) await notify(ctx, "Survey discount code needs a hand", `${s.customerName} · ${s.waId} rated ${s.rating}/10 — create a Tk ${s.discount} code and send it`, s.orderId, "action")
  },
})

/** Make the one-time Shopify code and send the thank-you. Test mode sends nothing and makes no real code. */
export const issueCode = internalAction({
  args: { surveyId: v.id("surveys") },
  handler: async (ctx, { surveyId }) => {
    const s = await ctx.runQuery(internal.survey.surveyById, { id: surveyId })
    if (!s || s.rating == null || s.code) return
    const amount = s.discount ?? discountFor(s.rating)
    const { conf: c } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    const live = c.mode === "live"
    let code: string | null = `TEST-${amount}-${randomCode()}`
    if (live) {
      code = `BB${amount}-${randomCode()}`
      try {
        const r: any = await shopifyGql(ctx, `mutation($input: DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$input){ codeDiscountNode { id } userErrors { field message } } }`, {
          input: {
            title: `Survey thank-you Tk ${amount} (${code})`, code, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + CODE_DAYS * DAY).toISOString(),
            context: { all: "ALL" }, usageLimit: 1, appliesOncePerCustomer: true,
            customerGets: { value: { discountAmount: { amount: String(amount), appliesOnEachItem: false } }, items: { all: true } },
            minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(MIN_ORDER) } },
            combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true },
          },
        })
        const errs = r.discountCodeBasicCreate?.userErrors ?? []
        if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "))
      } catch (e: any) {
        console.error("Survey code failed", e)
        await ctx.runMutation(internal.survey.saveCode, { id: surveyId, note: `code failed: ${String(e?.message ?? e).slice(0, 200)}` })
        code = null
      }
    }
    if (code) await ctx.runMutation(internal.survey.saveCode, { id: surveyId, code })
    await ctx.runAction(internal.whatsappVerify.deliver, { to: s.waId, out: [{ kind: "text", body: thanks(s.customerName, s.rating, amount, code) }] })
  },
})

// ---------- who gets asked ----------
/** Orders delivered 2+ days ago since the switch was turned on, not asked yet. */
export const dueAuto = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await cfgOf(ctx)
    if (!c.enabled || !c.since) return []
    const rows = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", c.since!).lte("deliveredAt", Date.now() - 2 * DAY)).order("asc").take(300)
    const out: Id<"orders">[] = []
    for (const o of rows) {
      if (out.length >= 30) break
      if (await eligible(ctx, o)) out.push(o._id)
    }
    return out
  },
})

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const orderId of await ctx.runQuery(internal.survey.dueAuto, {})) {
      const r = await ctx.runAction(internal.survey.send, { orderId, batch: "auto" })
      if (r.rateLimited) break
    }
  },
})

/** The next slice of the past-90-days blast. */
export const nextPast = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await cfgOf(ctx)
    const p = c.past
    if (!c.enabled || !p?.active || (p.pausedUntil && p.pausedUntil > Date.now())) return null
    const rows = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", p.from).lt("deliveredAt", p.cursor)).order("desc").take(120)
    const ids: Id<"orders">[] = []
    let cursor = p.cursor
    let scanned = 0
    for (const o of rows) {
      if (ids.length >= 20) break
      scanned++
      cursor = o.deliveredAt ?? cursor
      if (await eligible(ctx, o)) ids.push(o._id)
    }
    return { ids, cursor, scanned, done: rows.length < 120 && scanned === rows.length }
  },
})

export const dripPast = internalAction({
  args: {},
  handler: async (ctx) => {
    const n = await ctx.runQuery(internal.survey.nextPast, {})
    if (!n) return
    let sent = 0
    let paused = false
    for (const orderId of n.ids) {
      const r = await ctx.runAction(internal.survey.send, { orderId, batch: "past90" })
      if (r.sent) sent++
      if (r.rateLimited) { paused = true; break }
    }
    await ctx.runMutation(internal.survey.advancePast, { cursor: n.cursor, scanned: n.scanned, sent, done: n.done && !paused, pauseHour: paused })
  },
})

export const advancePast = internalMutation({
  args: { cursor: v.number(), scanned: v.number(), sent: v.number(), done: v.boolean(), pauseHour: v.boolean() },
  handler: async (ctx, a) => {
    const c = await cfgOf(ctx)
    if (!c.past?.active) return
    // a paused slice was not fully processed: keep the old cursor so nothing is skipped
    const past = { ...c.past, sent: c.past.sent + a.sent, scanned: c.past.scanned + a.scanned, ...(a.pauseHour ? { pausedUntil: Date.now() + 3600_000 } : { cursor: a.cursor }) }
    if (a.done) past.active = false
    await setSetting(ctx, "waSurvey", { ...c, past })
  },
})

// ---------- settings (Settings → WhatsApp verify) ----------
export const status = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "settings.manage")
    const c = await cfgOf(ctx)
    return { enabled: !!c.enabled, since: c.since ?? null, past: c.past ?? null }
  },
})

export const saveConfig = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    await requirePerm(ctx, "settings.manage")
    const c = await cfgOf(ctx)
    // only parcels delivered after the switch was turned on are asked automatically; the old ones go through the past-90-days button
    await setSetting(ctx, "waSurvey", { ...c, enabled, since: enabled ? (c.enabled && c.since ? c.since : Date.now()) : undefined, past: enabled ? c.past : c.past ? { ...c.past, active: false } : undefined })
  },
})

export const pageDelivered = internalQuery({
  args: { from: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, cursor }) => {
    const r = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", from)).paginate({ numItems: 300, cursor })
    const phones: string[] = []
    for (const o of r.page) if (!o.deletedAt && !o.isExchange && DELIVERED.includes(o.status)) { const w = waIdOf(o.phone); if (w) phones.push(w) }
    return { phones, isDone: r.isDone, continueCursor: r.continueCursor }
  },
})

/** How many different customers the past-90-days message would reach (nothing is sent). */
export const previewPast = action({
  args: {},
  handler: async (ctx): Promise<{ customers: number; orders: number }> => {
    await ctx.runQuery(internal.survey.requireSettings, {})
    const from = Date.now() - 90 * DAY
    const seen = new Set<string>()
    let orders = 0
    let cursor: string | null = null
    for (let i = 0; i < 60; i++) {
      const r: { phones: string[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.survey.pageDelivered, { from, cursor })
      for (const p of r.phones) { orders++; seen.add(p) }
      if (r.isDone) break
      cursor = r.continueCursor
    }
    return { customers: seen.size, orders }
  },
})
export const requireSettings = internalQuery({ args: {}, handler: async (ctx) => { await requirePerm(ctx, "settings.manage") } })

export const startPast = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "settings.manage")
    const c = await cfgOf(ctx)
    if (!c.enabled) throw new ConvexError("Switch on “Ask customers to rate us” first")
    const now = Date.now()
    await setSetting(ctx, "waSurvey", { ...c, past: { active: true, from: now - 90 * DAY, cursor: now + 1, startedAt: now, sent: 0, scanned: 0 } })
  },
})
export const stopPast = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "settings.manage")
    const c = await cfgOf(ctx)
    if (c.past) await setSetting(ctx, "waSurvey", { ...c, past: { ...c.past, active: false } })
  },
})

// ---------- the Satisfaction page ----------
export const summary = query({
  args: { days: v.number() },
  handler: async (ctx, { days }) => {
    await requirePerm(ctx, "reports.view")
    const from = Date.now() - days * DAY
    const rows = await ctx.db.query("surveys").withIndex("by_asked", (q) => q.gte("askedAt", from)).order("desc").take(5000)
    const asked = rows.filter((r) => r.result === "sent" || r.result === "rated")
    const rated = rows.filter((r) => r.result === "rated" && r.rating != null)
    const dist = Array.from({ length: 10 }, (_, i) => rated.filter((r) => r.rating === i + 1).length)
    const avg = rated.length ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length : null
    const promoters = rated.filter((r) => (r.rating ?? 0) >= 9).length
    const detractors = rated.filter((r) => (r.rating ?? 0) <= 6).length
    const detail = async (r: Doc<"surveys">) => {
      const o = await ctx.db.get(r.orderId)
      return { id: r._id, rating: r.rating ?? 0, name: r.customerName, phone: o?.phone ?? r.waId, invoice: o ? invoiceLabel(o) : "", orderId: r.orderId, at: r.ratedAt ?? r.askedAt, code: r.code ?? null }
    }
    const byRated = [...rated].sort((a, b) => (b.ratedAt ?? 0) - (a.ratedAt ?? 0))
    return {
      asked: asked.length, rated: rated.length,
      responseRate: asked.length ? rated.length / asked.length : null,
      avg, dist,
      nps: rated.length ? Math.round(((promoters - detractors) / rated.length) * 100) : null,
      failed: rows.filter((r) => r.result === "failed").length,
      low: await Promise.all(byRated.filter((r) => (r.rating ?? 0) <= 6).slice(0, 25).map(detail)),
      recent: await Promise.all(byRated.slice(0, 25).map(detail)),
    }
  },
})
