import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import { currentStaff, getSetting, requirePerm, setSetting } from "./lib"
import { normalizePhone, ORDER_SOURCES, PAYMENT_METHODS, SMS_STATUSES } from "./rules"

// ---------------- Block list ----------------
export const listBlocks = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return (await ctx.db.query("blocks").collect()).sort((a, b) => b.createdAt - a.createdAt)
  },
})

export const addBlock = mutation({
  args: { kind: v.union(v.literal("phone"), v.literal("ip")), value: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "settings.manage")
    const value = a.kind === "phone" ? normalizePhone(a.value) : a.value.trim()
    if (a.kind === "phone" && !/^01\d{9}$/.test(value)) throw new ConvexError("Enter an 11-digit phone number")
    if (!value) throw new ConvexError("Enter a value")
    const existing = await ctx.db.query("blocks").withIndex("by_value", (q) => q.eq("kind", a.kind).eq("value", value)).first()
    if (existing) { await ctx.db.patch(existing._id, { active: true, reason: a.reason }); return existing._id }
    return await ctx.db.insert("blocks", { kind: a.kind, value, reason: a.reason, active: true, createdBy: me.staff.name, createdAt: Date.now() })
  },
})

export const setBlocksActive = mutation({
  args: { ids: v.array(v.id("blocks")), active: v.boolean() },
  handler: async (ctx, { ids, active }) => {
    await requirePerm(ctx, "settings.manage")
    for (const id of ids) await ctx.db.patch(id, { active })
  },
})

// ---------------- Notifications ----------------
export const notifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = await ctx.db.query("notifications").withIndex("by_at").order("desc").take(limit ?? 40)
    const me = s.staff._id as string
    return { rows: rows.map((r) => ({ ...r, read: r.readBy.includes(me) })), unread: rows.filter((r) => !r.readBy.includes(me)).length }
  },
})

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const s = await requirePerm(ctx)
    const me = s.staff._id as string
    const rows = await ctx.db.query("notifications").withIndex("by_at").order("desc").take(200)
    for (const r of rows) if (!r.readBy.includes(me)) await ctx.db.patch(r._id, { readBy: [...r.readBy, me] })
  },
})

// ---------------- Order settings ----------------
export const orderSettings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const cfg = (await getSetting<any>(ctx, "orderSettings")) ?? {}
    return {
      paymentMethods: cfg.paymentMethods ?? PAYMENT_METHODS,
      customPaymentMethods: cfg.customPaymentMethods ?? [],
      sources: cfg.sources ?? ORDER_SOURCES,
      invoiceEnabled: cfg.invoiceEnabled ?? true,
      invoiceFooter: cfg.invoiceFooter ?? "Thank you for shopping with BlackBole. For exchange or help, contact us on Facebook or blackbole.com.",
      codRate: (await getSetting<number>(ctx, "codRate")) ?? 1,
    }
  },
})

export const saveOrderSettings = mutation({
  args: {
    paymentMethods: v.array(v.string()),
    customPaymentMethods: v.array(v.string()),
    sources: v.array(v.string()),
    invoiceEnabled: v.boolean(),
    invoiceFooter: v.string(),
    codRate: v.number(),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    if (a.customPaymentMethods.length > 10) throw new ConvexError("Up to 10 custom payment methods")
    if (a.sources.length === 0) throw new ConvexError("Keep at least one order source")
    const { codRate, ...rest } = a
    await setSetting(ctx, "orderSettings", rest)
    await setSetting(ctx, "codRate", codRate)
  },
})

// ---------------- Customer communication ----------------
export const commSettings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const sms = (await getSetting<any>(ctx, "sms")) ?? {}
    const contact = (await getSetting<any>(ctx, "contactPoints")) ?? {}
    return {
      sms: {
        enabled: !!sms.enabled, statuses: sms.statuses ?? SMS_STATUSES, templates: sms.templates ?? {},
        urlTemplate: sms.urlTemplate ?? "", method: sms.method ?? "GET", valuePreference: sms.valuePreference ?? "total",
        lowBalanceAlert: !!sms.lowBalanceAlert,
      },
      contact: { hotline: contact.hotline ?? "", hotlineEnabled: !!contact.hotlineEnabled, whatsapp: contact.whatsapp ?? "", whatsappEnabled: !!contact.whatsappEnabled },
      recent: (await ctx.db.query("smsLogs").withIndex("by_at").order("desc").take(30)),
    }
  },
})

export const saveCommSettings = mutation({
  args: {
    sms: v.object({
      enabled: v.boolean(), statuses: v.array(v.string()), templates: v.any(), urlTemplate: v.string(),
      method: v.string(), valuePreference: v.string(), lowBalanceAlert: v.boolean(),
    }),
    contact: v.object({ hotline: v.string(), hotlineEnabled: v.boolean(), whatsapp: v.string(), whatsappEnabled: v.boolean() }),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    if (a.sms.enabled && !a.sms.urlTemplate.includes("{message}")) throw new ConvexError("The SMS gateway URL must contain {message} and {phone}")
    await setSetting(ctx, "sms", a.sms)
    await setSetting(ctx, "contactPoints", a.contact)
  },
})

// ---------------- Webhooks & API ----------------
function randomKey(len = 40) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const arr = new Uint32Array(len)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join("")
}

export const integrationSettings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const hook = (await getSetting<any>(ctx, "webhook")) ?? {}
    const api = await getSetting<string>(ctx, "apiKey")
    const pw = (await getSetting<any>(ctx, "pathaoWebhook")) ?? {}
    return {
      siteUrl: process.env.CONVEX_SITE_URL ?? "",
      webhook: { url: hook.url ?? "", hasSecret: !!hook.secret, events: hook.events ?? [], sources: hook.sources ?? [] },
      apiKeyHint: api ? `${api.slice(0, 6)}••••••••${api.slice(-4)}` : null,
      pathaoWebhook: { hasIntegrationSecret: !!pw.integrationSecret, hasSignatureToken: !!pw.signatureToken },
      recentWebhooks: await ctx.db.query("webhookLogs").withIndex("by_at").order("desc").take(20),
    }
  },
})

export const saveWebhook = mutation({
  args: { url: v.string(), secret: v.optional(v.string()), events: v.array(v.string()), sources: v.array(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const old = (await getSetting<any>(ctx, "webhook")) ?? {}
    if (a.url && !/^https:\/\//.test(a.url)) throw new ConvexError("Webhook URL must start with https://")
    await setSetting(ctx, "webhook", { url: a.url.trim(), secret: a.secret?.trim() || old.secret, events: a.events, sources: a.sources })
  },
})

export const rotateApiKey = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "settings.manage")
    const key = `bbk_${randomKey()}`
    await setSetting(ctx, "apiKey", key)
    return key // shown once
  },
})

export const savePathaoWebhook = mutation({
  args: { integrationSecret: v.string(), signatureToken: v.string() },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const old = (await getSetting<any>(ctx, "pathaoWebhook")) ?? {}
    await setSetting(ctx, "pathaoWebhook", {
      integrationSecret: a.integrationSecret.trim() || old.integrationSecret,
      signatureToken: a.signatureToken.trim() || old.signatureToken,
    })
  },
})

// ---------------- Meta ads ----------------
export const adsSettings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const m = (await getSetting<any>(ctx, "metaAds")) ?? {}
    return { accounts: (m.accounts ?? []) as { id: string; name: string; locationId?: string }[], hasToken: !!m.token }
  },
})

export const saveAdsSettings = mutation({
  args: { token: v.optional(v.string()), accounts: v.array(v.object({ id: v.string(), name: v.string(), locationId: v.optional(v.string()) })) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const old = (await getSetting<any>(ctx, "metaAds")) ?? {}
    await setSetting(ctx, "metaAds", { token: a.token?.trim() || old.token, accounts: a.accounts.map((x) => ({ ...x, id: x.id.replace(/^act_/, "") })) })
  },
})
