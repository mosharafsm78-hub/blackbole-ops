// Automatic order confirmation calls.
// A new Pending order gets a phone call: press 1 = confirm (→ Approved), 2 = wants to cancel (team decides),
// 3 = talk to customer care. No answer → tried again, then left for the team.
//
// Ops does not dial by itself: it asks our call server (Asterisk/FreeSWITCH + a licensed SIP line) to call,
// and the call server reports the key press back. Contract:
//   Ops → POST {serverUrl}/calls   Authorization: Bearer <secret>
//         { ref, to: "8801XXXXXXXXX", vars: { invoice, amount, product, customer }, callbackUrl }
//   Call server → POST {callbackUrl} (/auto-call/result)   Authorization: Bearer <secret>
//         { ref, callRef?, result: "answered" | "no_answer" | "busy" | "failed", digit?: "1"|"2"|"3", durationSec?, cost? }
// "test" mode places no real calls: the Settings page lets you press 1 / 2 / 3 / no answer by hand.
import { v, ConvexError } from "convex/values"
import { httpAction, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { currentStaff, getSetting, logOrder, requirePerm, setSetting } from "./lib"
import { applyStatus } from "./orders"

export type AutoCallConf = {
  enabled: boolean
  mode: "test" | "live"
  serverUrl: string
  sources: string[] // empty = every source
  delayMin: number // wait after the order arrives
  retries: number // extra tries after no answer
  retryGapMin: number
  quietFrom: number // no calls from this hour (Dhaka)…
  quietTo: number // …until this hour
  maxTotal: number // orders above this go to a person (0 = no limit)
  pressTwo: "flag" | "cancel" // flag = team confirms the cancel
}
export const DEFAULT_CONF: AutoCallConf = {
  enabled: false, mode: "test", serverUrl: "", sources: [], delayMin: 3, retries: 2, retryGapMin: 30,
  quietFrom: 23, quietTo: 8, maxTotal: 0, pressTwo: "flag",
}
const conf = async (ctx: any): Promise<AutoCallConf> => ({ ...DEFAULT_CONF, ...((await getSetting<AutoCallConf>(ctx, "autoCall")) ?? {}) })

const BD = 6 * 3600000
const hourBD = (t: number) => new Date(t + BD).getUTCHours()
/** Move a time out of quiet hours (e.g. 11 pm–8 am) to the next allowed minute. */
export function outOfQuiet(t: number, from: number, to: number) {
  const h = hourBD(t)
  const quiet = from > to ? h >= from || h < to : h >= from && h < to
  if (!quiet) return t
  const d = new Date(t + BD)
  d.setUTCHours(to, 0, 0, 0)
  let at = d.getTime() - BD
  if (at <= t) at += 86400000
  return at
}

// ---------- queue a call for a new order (scheduled from emitOrderEvent when an order becomes Pending) ----------
export const queue = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => { await queueAutoCall(ctx, orderId) },
})
async function queueAutoCall(ctx: any, orderId: Id<"orders">) {
  const c = await conf(ctx)
  if (!c.enabled) return
  const o: Doc<"orders"> | null = await ctx.db.get(orderId)
  if (!o || o.status !== "pending" || o.deletedAt || o.isExchange) return
  if (c.sources.length && !c.sources.includes(o.source)) return
  if (c.maxTotal > 0 && o.total > c.maxTotal) return
  if (!/^01[3-9]\d{8}$/.test(o.phone)) return
  if (await ctx.db.query("autoCalls").withIndex("by_order", (q: any) => q.eq("orderId", orderId)).first()) return // one per order
  const now = Date.now()
  await ctx.db.insert("autoCalls", {
    orderId, phone: o.phone, status: "queued", attempt: 0,
    nextAt: outOfQuiet(now + c.delayMin * 60000, c.quietFrom, c.quietTo), createdAt: now, updatedAt: now,
  })
}

// ---------- the minute tick: start due calls ----------
export const due = internalMutation({
  args: {},
  handler: async (ctx) => {
    const c = await conf(ctx)
    if (!c.enabled) return []
    const now = Date.now()
    const rows = await ctx.db.query("autoCalls").withIndex("by_status_next", (q) => q.eq("status", "queued").lte("nextAt", now)).take(10)
    const out: { ref: string; to: string; vars: Record<string, string> }[] = []
    for (const r of rows) {
      const o = await ctx.db.get(r.orderId)
      if (!o || o.deletedAt || o.status !== "pending") { // already handled by the team
        await ctx.db.patch(r._id, { status: "done", result: "skipped", note: `Order is ${o?.status ?? "gone"}`, updatedAt: now })
        continue
      }
      const at = outOfQuiet(now, c.quietFrom, c.quietTo)
      if (at > now) { await ctx.db.patch(r._id, { nextAt: at, updatedAt: now }); continue }
      await ctx.db.patch(r._id, { status: "calling", attempt: r.attempt + 1, updatedAt: now })
      const label = o.invoiceCode ?? `BB-${o.invoiceNo}`
      await logOrder(ctx, o._id, `Auto call ${r.attempt + 1} started${c.mode === "test" ? " (test mode — no real call)" : ""}`, "Auto call")
      out.push({
        ref: r._id, to: `88${o.phone}`,
        vars: { invoice: label, amount: String(Math.round(o.due)), product: o.items.map((i) => `${i.name}${i.attrs ? ` ${i.attrs}` : ""}`).join(", ").slice(0, 120), customer: o.customerName.slice(0, 60) },
      })
    }
    return c.mode === "live" ? out : []
  },
})

export const liveConf = internalQuery({
  args: {},
  handler: async (ctx) => ({ conf: await conf(ctx), secret: (await getSetting<string>(ctx, "autoCallSecret")) ?? null }),
})

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const calls = await ctx.runMutation(internal.autoCalls.due, {})
    if (!calls.length) return
    const { conf: c, secret } = await ctx.runQuery(internal.autoCalls.liveConf, {})
    const callbackUrl = `${process.env.CONVEX_SITE_URL}/auto-call/result`
    for (const call of calls) {
      try {
        const r = await fetch(`${c.serverUrl.replace(/\/$/, "")}/calls`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret ?? ""}` },
          body: JSON.stringify({ ...call, callbackUrl }),
        })
        if (!r.ok) throw new Error(`call server ${r.status}`)
      } catch (e: any) {
        await ctx.runMutation(internal.autoCalls.record, { ref: call.ref as Id<"autoCalls">, result: "failed", note: String(e?.message ?? e).slice(0, 200) })
      }
    }
  },
})

// ---------- result of a call ----------
const recordArgs = {
  ref: v.id("autoCalls"), result: v.string(), digit: v.optional(v.string()), callRef: v.optional(v.string()),
  durationSec: v.optional(v.number()), cost: v.optional(v.number()), note: v.optional(v.string()), by: v.optional(v.string()),
}
export const record = internalMutation({
  args: recordArgs,
  handler: async (ctx, a) => recordCall(ctx, a),
})

async function recordCall(ctx: any, a: { ref: Id<"autoCalls">; result: string; digit?: string; callRef?: string; durationSec?: number; cost?: number; note?: string; by?: string }) {
  {
    const row = await ctx.db.get(a.ref)
    if (!row || row.status === "done") return
    const c = await conf(ctx)
    const now = Date.now()
    const o = await ctx.db.get(row.orderId)
    const extra = { callRef: a.callRef, durationSec: a.durationSec, cost: (row.cost ?? 0) + (a.cost ?? 0), updatedAt: now }
    const by = a.by ?? "Auto call"
    const answered = a.result === "answered" && ["1", "2", "3"].includes(a.digit ?? "")
    if (!answered) {
      // no answer / busy / failed / answered without pressing: try again, then hand over to the team
      const why = a.result === "answered" ? "answered but pressed nothing" : a.result.replace(/_/g, " ")
      if (row.attempt <= c.retries) {
        await ctx.db.patch(row._id, { ...extra, status: "queued", nextAt: outOfQuiet(now + c.retryGapMin * 60000, c.quietFrom, c.quietTo), note: a.note })
        if (o) await logOrder(ctx, o._id, `Auto call ${row.attempt}: ${why} — will try again in ${c.retryGapMin} min`, by)
      } else {
        await ctx.db.patch(row._id, { ...extra, status: "done", result: "no_answer", note: a.note })
        if (o) {
          await ctx.db.patch(o._id, { autoCall: { result: "no_answer", at: now, attempts: row.attempt } })
          await logOrder(ctx, o._id, `Auto call: ${why} after ${row.attempt} tries — please call the customer`, by)
        }
      }
      return
    }
    const result = a.digit === "1" ? "confirmed" : a.digit === "2" ? "cancel" : "agent"
    await ctx.db.patch(row._id, { ...extra, status: "done", result, digit: a.digit, note: a.note })
    if (!o || o.deletedAt) return
    await ctx.db.patch(o._id, { autoCall: { result, at: now, attempts: row.attempt } })
    if (o.status !== "pending") {
      await logOrder(ctx, o._id, `Auto call: customer pressed ${a.digit}, but the order was already ${o.status.replace(/_/g, " ")} — nothing changed`, by)
      return
    }
    if (result === "confirmed") {
      await applyStatus(ctx, o, "approved", by, "Customer confirmed by pressing 1 on the auto call")
    } else if (result === "cancel") {
      if (c.pressTwo === "cancel") await applyStatus(ctx, o, "cancelled", by, "Customer pressed 2 on the auto call (cancel)")
      else await logOrder(ctx, o._id, "Auto call: customer pressed 2 — WANTS TO CANCEL. Please check and cancel (or call them).", by)
    } else {
      await ctx.db.patch(o._id, { followUpAt: now })
      await logOrder(ctx, o._id, "Auto call: customer pressed 3 — wants to talk to us. Please call now.", by)
    }
  }
}

export const resultHttp = httpAction(async (ctx, req) => {
  const { secret } = await ctx.runQuery(internal.autoCalls.liveConf, {})
  const auth = req.headers.get("Authorization") ?? ""
  if (!secret || auth !== `Bearer ${secret}`) return new Response('{"ok":false}', { status: 401 })
  const b: any = await req.json().catch(() => ({}))
  if (!b.ref || !b.result) return new Response('{"ok":false,"error":"ref and result needed"}', { status: 400 })
  try {
    await ctx.runMutation(internal.autoCalls.record, {
      ref: b.ref, result: String(b.result), digit: b.digit != null ? String(b.digit) : undefined, callRef: b.callRef ? String(b.callRef) : undefined,
      durationSec: Number.isFinite(+b.durationSec) ? +b.durationSec : undefined, cost: Number.isFinite(+b.cost) ? +b.cost : undefined,
    })
  } catch { return new Response('{"ok":false}', { status: 400 }) }
  return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } })
})

// ---------- settings page ----------
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const recent = await ctx.db.query("autoCalls").withIndex("by_created").order("desc").take(40)
    const rows = await Promise.all(recent.map(async (r) => {
      const o = await ctx.db.get(r.orderId)
      return { ...r, invoice: o ? o.invoiceCode ?? `BB-${o.invoiceNo}` : "?", customer: o?.customerName ?? "", orderStatus: o?.status ?? "" }
    }))
    const since = Date.now() - 7 * 86400000
    const week = (await ctx.db.query("autoCalls").withIndex("by_created", (q) => q.gte("createdAt", since)).collect())
    const count = (r: string) => week.filter((x) => x.result === r).length
    return {
      conf: await conf(ctx), hasSecret: !!(await getSetting<string>(ctx, "autoCallSecret")),
      resultUrl: `${process.env.CONVEX_SITE_URL}/auto-call/result`,
      week: { total: week.length, confirmed: count("confirmed"), cancel: count("cancel"), agent: count("agent"), noAnswer: count("no_answer"), waiting: week.filter((x) => x.status !== "done").length, cost: week.reduce((t, x) => t + (x.cost ?? 0), 0) },
      rows,
    }
  },
})

export const saveSettings = mutation({
  args: {
    enabled: v.boolean(), mode: v.union(v.literal("test"), v.literal("live")), serverUrl: v.string(), sources: v.array(v.string()),
    delayMin: v.number(), retries: v.number(), retryGapMin: v.number(), quietFrom: v.number(), quietTo: v.number(),
    maxTotal: v.number(), pressTwo: v.union(v.literal("flag"), v.literal("cancel")), secret: v.optional(v.string()),
  },
  handler: async (ctx, { secret, ...a }) => {
    await requirePerm(ctx, "settings.manage")
    if (a.mode === "live" && a.enabled && !/^https:\/\//.test(a.serverUrl.trim())) throw new ConvexError("Enter the call server address (https://…) before going live")
    await setSetting(ctx, "autoCall", {
      ...a, serverUrl: a.serverUrl.trim(),
      delayMin: Math.max(0, Math.min(120, a.delayMin)), retries: Math.max(0, Math.min(5, a.retries)), retryGapMin: Math.max(5, Math.min(240, a.retryGapMin)),
      quietFrom: Math.max(0, Math.min(23, a.quietFrom)), quietTo: Math.max(0, Math.min(23, a.quietTo)), maxTotal: Math.max(0, a.maxTotal),
    })
    if (secret?.trim()) await setSetting(ctx, "autoCallSecret", secret.trim())
  },
})

/** Test mode: act as the customer (press 1 / 2 / 3 / no answer) to try the whole flow without a phone line. */
export const simulate = mutation({
  args: { id: v.id("autoCalls"), result: v.string(), digit: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const me = await requirePerm(ctx, "settings.manage")
    const row = await ctx.db.get(a.id)
    if (!row || row.status !== "calling") throw new ConvexError("This call is not ringing (start it first, or wait for its turn)")
    await recordCall(ctx, { ref: a.id, result: a.result, digit: a.digit, note: "Simulated in test mode", by: `Auto call (test by ${me.staff.name})` })
  },
})

/** Start a waiting call now instead of at its time (handy for testing). */
export const callNow = mutation({
  args: { id: v.id("autoCalls") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "settings.manage")
    const r = await ctx.db.get(id)
    if (!r || r.status !== "queued") throw new ConvexError("Not waiting")
    await ctx.db.patch(id, { nextAt: Date.now() - 1 })
    await ctx.scheduler.runAfter(0, internal.autoCalls.tick, {})
  },
})

/** Queue a call for one order by hand (e.g. an order that came in before the switch was on). */
export const queueOrder = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    await requirePerm(ctx, "orders.edit")
    const c = await conf(ctx)
    if (!c.enabled) throw new ConvexError("Auto calls are switched off (Settings → Auto calls)")
    const old = await ctx.db.query("autoCalls").withIndex("by_order", (q) => q.eq("orderId", orderId)).first()
    if (old && old.status !== "done") throw new ConvexError("A call is already waiting for this order")
    if (old) await ctx.db.delete(old._id)
    const o = await ctx.db.get(orderId)
    if (!o || o.status !== "pending") throw new ConvexError("Only Pending orders get a confirmation call")
    const now = Date.now()
    await ctx.db.insert("autoCalls", { orderId, phone: o.phone, status: "queued", attempt: 0, nextAt: outOfQuiet(now, c.quietFrom, c.quietTo), createdAt: now, updatedAt: now })
    await ctx.scheduler.runAfter(0, internal.autoCalls.tick, {})
  },
})
