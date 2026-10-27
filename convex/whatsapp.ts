// WhatsApp Business Platform (Cloud API) inbox — a second, dedicated number so the team's existing WhatsApp
// Business app keeps working untouched. Customer care replies here like any chat app; the win-back job (see
// winback.ts) can send through here too once this is connected. Works in "test" mode with no Meta account yet —
// use "Simulate incoming" below to try the inbox before the real number is live.
//
// Connecting it for real (Settings → WhatsApp):
//   1. Meta Business Manager → WhatsApp Business Platform → get a Phone number ID + permanent access token.
//   2. Point Meta's webhook at {this site}/whatsapp/webhook, verify token = whatever you set below.
//   3. Flip mode to "live" and switch it on.
import { v, ConvexError } from "convex/values"
import { httpAction, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { currentStaff, getSetting, requirePerm, setSetting } from "./lib"

export type WaConf = { enabled: boolean; mode: "test" | "live"; phoneNumberId: string; verifyToken: string; displayNumber: string }
export const DEFAULT_CONF: WaConf = { enabled: false, mode: "test", phoneNumberId: "", verifyToken: "", displayNumber: "" }
const conf = async (ctx: any): Promise<WaConf> => ({ ...DEFAULT_CONF, ...((await getSetting<WaConf>(ctx, "whatsapp")) ?? {}) })

const toLocal = (waPhone: string) => (waPhone.startsWith("880") ? `0${waPhone.slice(3)}` : waPhone)
const toWa = (local11: string) => `88${local11}`

async function findOrCreateThread(ctx: any, phone: string, name?: string) {
  const existing = await ctx.db.query("waThreads").withIndex("by_phone", (q: any) => q.eq("phone", phone)).unique()
  if (existing) return existing
  const customer = await ctx.db.query("customers").withIndex("by_phone", (q: any) => q.eq("phone", phone)).first()
  const id = await ctx.db.insert("waThreads", {
    phone, customerId: customer?._id, name: name || customer?.name || phone, lastText: "", lastAt: Date.now(), lastDirection: "in", unread: false,
  })
  return (await ctx.db.get(id))!
}

// ---------------- settings ----------------
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const c = await conf(ctx)
    const threads = await ctx.db.query("waThreads").withIndex("by_lastAt").order("desc").take(200)
    return {
      conf: c, hasToken: !!(await getSetting<string>(ctx, "whatsappToken")),
      webhookUrl: `${process.env.CONVEX_SITE_URL}/whatsapp/webhook`,
      threadCount: threads.length, unread: threads.filter((t) => t.unread).length,
    }
  },
})

export const saveSettings = mutation({
  args: { enabled: v.boolean(), mode: v.union(v.literal("test"), v.literal("live")), phoneNumberId: v.string(), verifyToken: v.string(), displayNumber: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { token, ...a }) => {
    await requirePerm(ctx, "settings.manage")
    if (a.mode === "live" && a.enabled && (!a.phoneNumberId.trim() || !a.verifyToken.trim())) throw new ConvexError("Add the phone number ID and verify token before going live")
    await setSetting(ctx, "whatsapp", { ...a, phoneNumberId: a.phoneNumberId.trim(), verifyToken: a.verifyToken.trim(), displayNumber: a.displayNumber.trim() })
    if (token?.trim()) await setSetting(ctx, "whatsappToken", token.trim())
  },
})

export const getConf = internalQuery({ args: {}, handler: async (ctx) => ({ ...(await conf(ctx)), token: (await getSetting<string>(ctx, "whatsappToken")) ?? "" }) })

// ---------------- inbox ----------------
export const threads = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return await ctx.db.query("waThreads").withIndex("by_lastAt").order("desc").take(150)
  },
})

export const messages = query({
  args: { threadId: v.id("waThreads") },
  handler: async (ctx, { threadId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return await ctx.db.query("waMessages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()
  },
})

export const openThread = mutation({
  args: { threadId: v.id("waThreads") },
  handler: async (ctx, { threadId }) => {
    const s = await currentStaff(ctx)
    if (!s) throw new ConvexError("Not signed in")
    await ctx.db.patch(threadId, { unread: false })
  },
})

export const reply = mutation({
  args: { threadId: v.id("waThreads"), text: v.string() },
  handler: async (ctx, { threadId, text }): Promise<Id<"waMessages">> => {
    const me = await requirePerm(ctx, "orders.view")
    const t = await ctx.db.get(threadId)
    if (!t) throw new ConvexError("Conversation not found")
    const clean = text.trim()
    if (!clean) throw new ConvexError("Write a message first")
    const id = await ctx.db.insert("waMessages", { threadId, direction: "out", text: clean, by: me.staff.name, status: "queued", at: Date.now() })
    await ctx.db.patch(threadId, { lastText: clean, lastAt: Date.now(), lastDirection: "out", unread: false })
    await ctx.scheduler.runAfter(0, internal.whatsapp.sendQueued, { id, threadId })
    return id
  },
})

export const threadRaw = internalQuery({ args: { threadId: v.id("waThreads") }, handler: async (ctx, { threadId }) => await ctx.db.get(threadId) })
export const messageRaw = internalQuery({ args: { id: v.id("waMessages") }, handler: async (ctx, { id }) => await ctx.db.get(id) })

export const markSent = internalMutation({
  args: { id: v.id("waMessages"), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { id, error }) => { await ctx.db.patch(id, { status: error ? "failed" : "sent", error: error ?? undefined }) },
})

/** Test mode only: pretend a customer just texted in, so the inbox can be tried before the real number is live. */
export const simulateIncoming = mutation({
  args: { phone: v.string(), name: v.optional(v.string()), text: v.string() },
  handler: async (ctx, { phone, name, text }) => {
    await requirePerm(ctx, "settings.manage")
    const thread = await findOrCreateThread(ctx, phone, name)
    await ctx.db.insert("waMessages", { threadId: thread._id, direction: "in", text, status: "received", at: Date.now() })
    await ctx.db.patch(thread._id, { lastText: text, lastAt: Date.now(), lastDirection: "in", unread: true })
  },
})

export const receiveIncoming = internalMutation({
  args: { phone: v.string(), name: v.optional(v.string()), text: v.string() },
  handler: async (ctx, { phone, name, text }) => {
    const thread = await findOrCreateThread(ctx, phone, name)
    await ctx.db.insert("waMessages", { threadId: thread._id, direction: "in", text, status: "received", at: Date.now() })
    await ctx.db.patch(thread._id, { lastText: text, lastAt: Date.now(), lastDirection: "in", unread: true, ...(name && thread.name === thread.phone ? { name } : {}) })
  },
})

// ---------------- sending (Cloud API) ----------------
async function sendWa(c: WaConf & { token: string }, phone11: string, text: string): Promise<string | null> {
  if (c.mode === "test") return null // pretend sent — nothing goes out until a real number is connected
  if (!c.phoneNumberId || !c.token) return "WhatsApp is not connected yet (missing phone number ID or token)"
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: toWa(phone11), type: "text", text: { body: text } }),
    })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok) return body?.error?.message ? String(body.error.message).slice(0, 200) : `HTTP ${res.status}`
    return null
  } catch (e) {
    return String(e).slice(0, 200)
  }
}

export const sendQueued = internalAction({
  args: { id: v.id("waMessages"), threadId: v.id("waThreads") },
  handler: async (ctx, { id, threadId }) => {
    const [thread, msg, c] = await Promise.all([
      ctx.runQuery(internal.whatsapp.threadRaw, { threadId }),
      ctx.runQuery(internal.whatsapp.messageRaw, { id }),
      ctx.runQuery(internal.whatsapp.getConf, {}),
    ])
    if (!thread || !msg) return
    const error = await sendWa(c, thread.phone, msg.text)
    await ctx.runMutation(internal.whatsapp.markSent, { id, error })
  },
})

/** Used by other automatic jobs (e.g. win-back) once WhatsApp is live — same spacing rules as SMS: no secrets, no guessing. */
export const sendAutomatic = internalAction({
  args: { phone: v.string(), text: v.string(), by: v.string() },
  handler: async (ctx, { phone, text, by }): Promise<string | null> => {
    const c = await ctx.runQuery(internal.whatsapp.getConf, {})
    if (!c.enabled) return "WhatsApp is switched off"
    const error = await sendWa(c, phone, text)
    await ctx.runMutation(internal.whatsapp.logAutomatic, { phone, text, by, error })
    return error
  },
})

export const logAutomatic = internalMutation({
  args: { phone: v.string(), text: v.string(), by: v.string(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { phone, text, by, error }) => {
    const thread = await findOrCreateThread(ctx, phone)
    await ctx.db.insert("waMessages", { threadId: thread._id, direction: "out", text, by, status: error ? "failed" : "sent", error: error ?? undefined, at: Date.now() })
    await ctx.db.patch(thread._id, { lastText: text, lastAt: Date.now(), lastDirection: "out" })
  },
})

// ---------------- Meta webhook ----------------
export const webhookVerify = httpAction(async (ctx, req) => {
  const url = new URL(req.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  const c = await ctx.runQuery(internal.whatsapp.getConf, {})
  if (mode === "subscribe" && token && c.verifyToken && token === c.verifyToken) return new Response(challenge ?? "", { status: 200 })
  return new Response("Forbidden", { status: 403 })
})

export const webhookReceive = httpAction(async (ctx, req) => {
  const body: any = await req.json().catch(() => null)
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value
    const msgs = value?.messages ?? []
    const contacts = value?.contacts ?? []
    for (const m of msgs) {
      if (m.type !== "text") continue // media support can follow once the text flow is proven
      const waFrom: string = m.from ?? ""
      if (!waFrom) continue
      const name = contacts.find((c: any) => c.wa_id === waFrom)?.profile?.name
      await ctx.runMutation(internal.whatsapp.receiveIncoming, { phone: toLocal(waFrom), name, text: m.text?.body ?? "" })
    }
  } catch {
    // Meta retries on non-200, so always acknowledge even if one message failed to parse
  }
  return new Response("EVENT_RECEIVED", { status: 200 })
})
