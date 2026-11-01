// Automatic "finish your order" WhatsApp message for abandoned carts — the WhatsApp twin of abandonedEmail.ts.
// Goes out through the same official WhatsApp Business Platform (Meta Cloud API) the order-confirmation and
// parcel-update messages already use: a Meta-approved template, sent automatically by the server. Nobody taps
// anything (unlike the win-back queue, which is human-tap only because it has no approved template) and nothing
// here risks the business number, because Meta's own template review is what stands between "approved" and "sent".
//
// Needs one approved Utility template in Meta before it can go live: name "cart_reminder", body
// "Hi {{1}}, you still have {{2}} waiting in your BlackBole cart 🛍️ Complete your order now — delivery in 2–3
// days, pay on delivery. Need help? Call 01805070650." createTemplate below submits exactly that for review.
import { v, ConvexError } from "convex/values"
import { action, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { currentStaff } from "./lib"
import { ABANDON_AFTER, laterOrderFor } from "./checkouts"

const BD_OFFSET = 6 * 3600000
const WAIT_AFTER = 45 * 60000 // first message 45 min after the cart goes cold — gives a slow typer time to finish
const REPEAT_EVERY = 47 * 3600000 // a reminder every 2 days, same cadence as the email
const MAX_REMINDERS = 15
const MAX_AGE = 30 * 24 * 3600000
const PER_RUN = 20
export const TEMPLATE_NAME = "cart_reminder"
const BODY = "Hi {{1}}, you still have {{2}} waiting in your BlackBole cart 🛍️ Complete your order now — delivery in 2–3 days, pay on delivery. Need help? Call 01805070650."
const WABA_ID = "1289488499618886"

const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "there"
/** What to put in {{2}}: the first item's name, "+N more" if there's a cart full. */
const itemsLabel = (items: { name: string }[]) => {
  if (items.length === 0) return "your item"
  const n = items[0].name.trim()
  return items.length > 1 ? `${n} +${items.length - 1} more` : n
}
const validPhone = (p?: string) => /^01[3-9]\d{8}$/.test((p ?? "").replace(/\D/g, "").replace(/^88/, ""))

/** Open carts with a usable phone, left 45+ minutes ago, not ordered since: first message, then one every 2 days
 *  until they order (stops after a month, same safety stop as the email). */
export const candidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(300)
    const out: Id[] = []
    for (const c of rows) {
      if (out.length >= PER_RUN) break
      if (c.isArchived || !validPhone(c.phone)) continue
      if (now - c.shopUpdatedAt < Math.max(WAIT_AFTER, ABANDON_AFTER) || now - c.shopUpdatedAt > MAX_AGE) continue
      if (c.waReminderSentAt && (c.waReminderError || (c.waReminderCount ?? 0) >= MAX_REMINDERS || now - c.waReminderSentAt < REPEAT_EVERY)) continue
      if (await laterOrderFor(ctx, c)) continue
      out.push(c._id)
    }
    return out
  },
})
type Id = import("./_generated/dataModel").Id<"checkouts">

export const markResult = internalMutation({
  args: { checkoutId: v.id("checkouts"), error: v.optional(v.string()) },
  handler: async (ctx, { checkoutId, error }) => {
    const c = await ctx.db.get(checkoutId)
    if (!c) return
    await ctx.db.patch(checkoutId, error ? { waReminderError: error, waReminderSentAt: Date.now() } : { waReminderSentAt: Date.now(), waReminderCount: (c.waReminderCount ?? 0) + 1, waReminderError: undefined })
  },
})

export const sendOne = internalAction({
  args: { checkoutId: v.id("checkouts") },
  handler: async (ctx, { checkoutId }) => {
    const c: Doc<"checkouts"> | null = await ctx.runQuery(internal.abandonedEmail.get, { checkoutId })
    if (!c || !validPhone(c.phone)) return
    const { conf: cfg, sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    const waId = `88${c.phone.replace(/\D/g, "").replace(/^88/, "")}`
    const params = [first(c.customerName), itemsLabel(c.items)]
    if (!cfg.enabled || cfg.mode !== "live" || !cfg.phoneNumberId || !sec.token) {
      // test mode / not configured: record nothing as sent, so it never silently "uses up" a real attempt
      return
    }
    const payload = { messaging_product: "whatsapp", to: waId, type: "template", template: { name: TEMPLATE_NAME, language: { code: cfg.templateLang || "en" }, components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } }
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(payload) })
      if (r.ok) await ctx.runMutation(internal.abandonedWa.markResult, { checkoutId })
      else { const t = (await r.text()).slice(0, 200); console.error("Abandoned-cart WhatsApp reminder failed", r.status, t); await ctx.runMutation(internal.abandonedWa.markResult, { checkoutId, error: `${r.status} ${t}` }) }
    } catch (e: any) { await ctx.runMutation(internal.abandonedWa.markResult, { checkoutId, error: String(e?.message ?? e).slice(0, 200) }) }
  },
})

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const bdHour = new Date(Date.now() + BD_OFFSET).getUTCHours()
    if (bdHour < 9 || bdHour >= 22) return // same quiet hours as the email run
    const { conf: cfg } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!cfg.enabled || !(cfg as any).cartReminder) return
    for (const id of await ctx.runQuery(internal.abandonedWa.candidates, {})) {
      await ctx.runAction(internal.abandonedWa.sendOne, { checkoutId: id })
    }
  },
})

/** Team button: send (or resend) the reminder for one cart right now. */
export const sendNow = internalAction({
  args: { checkoutId: v.id("checkouts") },
  handler: async (ctx, { checkoutId }) => {
    await ctx.runAction(internal.abandonedWa.sendOne, { checkoutId })
  },
})

/** How many open abandoned carts would get a message right now, if the setting were on — for the Settings page. */
export const previewCount = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) return 0
    const now = Date.now()
    const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(500)
    return rows.filter((c) => !c.isArchived && validPhone(c.phone) && now - c.shopUpdatedAt >= Math.max(WAIT_AFTER, ABANDON_AFTER) && now - c.shopUpdatedAt <= MAX_AGE).length
  },
})

/** Submit the "cart_reminder" Utility template to Meta for review. Safe to call again — Meta treats a
 *  resubmission of the same name+language+category as an update, not a duplicate. */
export const createTemplate = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; message: string }> => {
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError("Sign in first")
    const { sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!sec.token) throw new ConvexError("Save the WhatsApp access token first (Settings → WhatsApp verify)")
    const body = {
      name: TEMPLATE_NAME, language: "en", category: "UTILITY",
      components: [{ type: "BODY", text: BODY }],
    }
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${WABA_ID}/message_templates`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sec.token}` }, body: JSON.stringify(body) })
      const t = await r.text()
      if (!r.ok) return { ok: false, message: `Meta said ${r.status}: ${t.slice(0, 300)}` }
      return { ok: true, message: "Submitted. Meta usually reviews a plain Utility template within a few hours — check status below." }
    } catch (e: any) { return { ok: false, message: String(e?.message ?? e).slice(0, 200) } }
  },
})

/** Current review status of the template from Meta (APPROVED / PENDING / REJECTED / not submitted yet). */
export const templateStatus = action({
  args: {},
  handler: async (ctx): Promise<{ status: string; detail?: string }> => {
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError("Sign in first")
    const { sec } = await ctx.runQuery(internal.whatsappVerify.liveConf, {})
    if (!sec.token) return { status: "unknown", detail: "No access token saved yet" }
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${WABA_ID}/message_templates?name=${TEMPLATE_NAME}`, { headers: { Authorization: `Bearer ${sec.token}` } })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) return { status: "unknown", detail: `Meta said ${r.status}` }
      const row = (j?.data ?? [])[0]
      if (!row) return { status: "not_submitted" }
      return { status: String(row.status ?? "unknown").toLowerCase(), detail: row.rejected_reason }
    } catch (e: any) { return { status: "unknown", detail: String(e?.message ?? e).slice(0, 200) } }
  },
})
