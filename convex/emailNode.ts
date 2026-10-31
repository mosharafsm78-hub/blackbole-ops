"use node"
// Customer order emails, sent through the BlackBole mailbox (Hostinger SMTP, e.g. support@blackbole.com).
// Same moments and same wording as the SMS (Settings → SMS → When to send), in a simple branded email.
import { v } from "convex/values"
import nodemailer from "nodemailer"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { invoiceLabel } from "./lib"
import { orderMessage } from "./outbound"
import { SITE, abandonedEmailContent, winbackEmailContent } from "./emailTemplates"

const SUBJECT: Record<string, string> = {
  pending: "Your BlackBole order {invoice} is received 🎉",
  approved: "Your BlackBole order {invoice} is confirmed",
  ready_to_ship: "Your BlackBole order {invoice} is packed",
  in_transit: "Your BlackBole order {invoice} is on the way 🚚",
  delivered_paid: "Your BlackBole order {invoice} was delivered",
  cancelled: "Your BlackBole order {invoice} was cancelled",
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function html(text: string, hotline?: string) {
  const body = esc(text).replace(/\n/g, "<br>")
  return `<!doctype html><html><body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#1c1915">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff">
<tr><td style="background:#1c1915;color:#ffffff;padding:18px 24px;font-size:20px;letter-spacing:4px;font-weight:bold">BLACKBOLE</td></tr>
<tr><td style="padding:28px 24px;font-size:15px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#7a746b">BlackBole${hotline ? ` · Help: ${esc(hotline)}` : ""}</td></tr>
</table></td></tr></table></body></html>`
}

function transport(email: any) {
  return nodemailer.createTransport({
    host: email.host || "smtp.hostinger.com", port: Number(email.port) || 465, secure: (Number(email.port) || 465) === 465,
    auth: { user: email.address, pass: email.password },
  })
}

async function send(email: any, to: string, subject: string, text: string, hotline?: string, htmlOverride?: string): Promise<string | null> {
  if (!email?.address || !email?.password) return "Email is not set up (mailbox or password missing)"
  try {
    await transport(email).sendMail({ from: { name: email.fromName || "BlackBole", address: email.address }, to, subject, text, html: htmlOverride ?? html(text, hotline) })
    return null
  } catch (e) {
    return String(e instanceof Error ? e.message : e).slice(0, 200)
  }
}

export const sendOrderEmail = internalAction({
  args: { orderId: v.id("orders"), status: v.string() },
  handler: async (ctx, { orderId, status }) => {
    const { order, sms, contact, email } = await ctx.runQuery(internal.outbound.context, { orderId })
    if (!order || !email?.enabled || !order.email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(order.email)) return
    const text = orderMessage(order, status, sms, contact)
    if (!text) return
    const subject = (SUBJECT[status] ?? "Your BlackBole order {invoice}").replace("{invoice}", invoiceLabel(order))
    const error = await send(email, order.email, subject, text, contact?.hotline)
    await ctx.runMutation(internal.outbound.logSms, { phone: order.email, text: `${subject} — ${text}`, orderId, status: error ? "failed" : "sent", error: error ?? undefined, channel: "email" })
  },
})

/** Win-back email — same discount push as the SMS/WhatsApp channels, sent fully automatically (no WhatsApp-style
 *  ban risk for email, so no human queue needed). Called from winback.ts's hourly runEmail action. */
export const sendWinbackEmail = internalAction({
  args: { customerId: v.id("customers"), to: v.string(), subject: v.string(), text: v.string(), name: v.optional(v.string()), code: v.optional(v.string()) },
  handler: async (ctx, { customerId, to, subject, text, name, code }) => {
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    const contact = await ctx.runQuery(internal.outbound.contactRaw, {})
    // A designed email (coupon box, button, 8 products); the plain text stays as the fallback
    let htmlBody: string | undefined, subj = subject, plain = text
    if (code) {
      const picks = await ctx.runQuery(internal.abandonedEmail.picks, { exclude: [], kind: "regular", step: new Date().getUTCDate() })
      const m = winbackEmailContent({ name: name ?? "", code, amount: 150, minOrder: 1500, hotline: contact?.hotline, picks })
      htmlBody = m.html; subj = m.subject; plain = m.text
    }
    const error = await send(email, to, subj, plain, contact?.hotline, htmlBody)
    await ctx.runMutation(internal.winback.logSentEmail, { customerId, email: to, text, error })
  },
})

/** Birthday email — fully automatic, same reasoning as sendWinbackEmail above (no ban risk for email). Called
 *  from birthdays.ts's daily sendAutomatic cron, once per customer per day. */
export const sendBirthdayEmailAuto = internalAction({
  args: { customerId: v.id("customers"), to: v.string(), subject: v.string(), text: v.string() },
  handler: async (ctx, { customerId, to, subject, text }) => {
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    const contact = await ctx.runQuery(internal.outbound.contactRaw, {})
    const error = await send(email, to, subject, text, contact?.hotline)
    await ctx.runMutation(internal.birthdays.logAutoEmail, { customerId, email: to, text: `${subject} — ${text}`, error })
  },
})

/** Dashboard → Birthdays today panel: Customer Care can also compose and send this themselves (subject/body
 *  editable, so they can add a personal touch, or resend on a channel that already went out automatically).
 *  Gated the same as the panel itself (dashboard.view). */
export const sendBirthdayEmail = action({
  args: { customerId: v.id("customers"), subject: v.string(), text: v.string() },
  handler: async (ctx, { customerId, subject, text }): Promise<{ ok: boolean; error?: string }> => {
    const by = await ctx.runQuery(internal.pathao.checkPerm, { perm: "dashboard.view" })
    const customer = await ctx.runQuery(internal.birthdays.customerRaw, { customerId })
    if (!customer) return { ok: false, error: "Customer not found" }
    if (!customer.email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(customer.email)) return { ok: false, error: "No valid email on file for this customer" }
    if (!subject.trim() || !text.trim()) return { ok: false, error: "Subject and message can't be empty" }
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    const contact = await ctx.runQuery(internal.outbound.contactRaw, {})
    const error = await send(email, customer.email, subject.trim(), text.trim(), contact?.hotline)
    await ctx.runMutation(internal.birthdays.logSent, { customerId, email: customer.email, text: `${subject.trim()} — ${text.trim()}`, error, by })
    return error ? { ok: false, error } : { ok: true }
  },
})

/** Accountability flags/questions and their 2-day SLA nudges — an internal team email, not a customer one, so
 *  it doesn't touch smsLogs or any customer record. Best-effort: if the mailbox isn't configured, it just logs
 *  to the server console rather than failing the flag/escalation that triggered it. */
export const sendAccountabilityEmail = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  handler: async (ctx, { to, subject, text }) => {
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    const error = await send(email, to, subject, text)
    if (error) console.error(`Accountability email to ${to} failed: ${error}`)
    // Logged like any other outbound email so a flag's emails are auditable, not just a console line that
    // vanishes once the deploy's logs roll over.
    await ctx.runMutation(internal.outbound.logSms, { phone: to, text: `${subject} — ${text}`, status: error ? "failed" : "sent", error: error ?? undefined, channel: "email" })
  },
})

/** Settings → Email: send one test email with the saved mailbox. */
export const testEmail = action({
  args: { to: v.string() },
  handler: async (ctx, { to }): Promise<{ ok: boolean; error?: string }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "settings.manage" })
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(to.trim())) return { ok: false, error: "Email address looks wrong" }
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    const text = "Test email from BlackBole Ops.\nIf you got this, automatic order emails are working. 🎉"
    const error = await send(email, to.trim(), "Test email from BlackBole Ops", text)
    await ctx.runMutation(internal.outbound.logSms, { phone: to.trim(), text, status: error ? "failed" : "sent", error: error ?? undefined, channel: "email" })
    return error ? { ok: false, error } : { ok: true }
  },
})

/** "You left something behind" email for an abandoned cart (gift-box leads get the Tk 500 gift reminder). */
export const sendAbandonedEmail = internalAction({
  args: { checkoutId: v.id("checkouts") },
  handler: async (ctx, { checkoutId }) => {
    const c = await ctx.runQuery(internal.abandonedEmail.get, { checkoutId })
    const email = await ctx.runQuery(internal.outbound.emailSettingsRaw, {})
    if (!c || !c.email) return
    const contact = await ctx.runQuery(internal.outbound.contactRaw, {})
    const info = await ctx.runQuery(internal.abandonedEmail.context, { checkoutId })
    const kind = info?.kind ?? "preorder"
    const picks = await ctx.runQuery(internal.abandonedEmail.picks, { exclude: c.items.map((i: any) => i.name), step: (c.emailCount ?? 0) + 1, kind })
    // pre-order: back to the pre-order product page · normal: back to their cart · welcome: the shop
    const url = kind === "preorder" ? (info?.productUrl ?? c.recoveryUrl) : kind === "regular" ? (c.recoveryUrl ?? info?.productUrl) : SITE
    const m = abandonedEmailContent({ customerName: c.customerName, items: c.items, subtotal: c.subtotal, url, hotline: contact?.hotline, step: (c.emailCount ?? 0) + 1, picks, kind })
    const error = await send(email, c.email, m.subject, m.text, contact?.hotline, m.html)
    await ctx.runMutation(internal.abandonedEmail.markResult, { checkoutId, subject: m.subject, error: error ?? undefined })
  },
})
