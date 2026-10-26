"use node"
// Customer order emails, sent through the BlackBole mailbox (Hostinger SMTP, e.g. support@blackbole.com).
// Same moments and same wording as the SMS (Settings → SMS → When to send), in a simple branded email.
import { v } from "convex/values"
import nodemailer from "nodemailer"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { invoiceLabel } from "./lib"
import { orderMessage } from "./outbound"

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
<tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#7a746b">BlackBole · blackbole.com${hotline ? ` · Help: ${esc(hotline)}` : ""}</td></tr>
</table></td></tr></table></body></html>`
}

function transport(email: any) {
  return nodemailer.createTransport({
    host: email.host || "smtp.hostinger.com", port: Number(email.port) || 465, secure: (Number(email.port) || 465) === 465,
    auth: { user: email.address, pass: email.password },
  })
}

async function send(email: any, to: string, subject: string, text: string, hotline?: string): Promise<string | null> {
  if (!email?.address || !email?.password) return "Email is not set up (mailbox or password missing)"
  try {
    await transport(email).sendMail({ from: { name: email.fromName || "BlackBole", address: email.address }, to, subject, text, html: html(text, hotline) })
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
