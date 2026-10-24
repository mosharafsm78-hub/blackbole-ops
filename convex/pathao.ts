import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { getSetting, requirePerm, setSetting } from "./lib"
import { canTransition, type OrderStatus } from "./rules"

type Creds = { env: "sandbox" | "production"; clientId: string; clientSecret: string; username: string; password: string }
type Token = { accessToken: string; refreshToken?: string; expiresAt: number }

const BASE = { sandbox: "https://courier-api-sandbox.pathao.com", production: "https://api-hermes.pathao.com" }

// ---------- internal storage ----------
export const checkPerm = internalQuery({
  args: { perm: v.string() },
  handler: async (ctx, { perm }) => {
    const me = await requirePerm(ctx, perm)
    return me.staff.name
  },
})

export const config = internalQuery({
  args: { partnerId: v.optional(v.id("deliveryPartners")) },
  handler: async (ctx, { partnerId }) => {
    if (partnerId) {
      const p = await ctx.db.get(partnerId)
      if (p?.useOwnCredentials && p.credentials) {
        return { creds: p.credentials as Creds, token: ((await getSetting<Token>(ctx, `pathaoToken:${partnerId}`)) ?? null), tokenKey: `pathaoToken:${partnerId}` }
      }
    }
    return {
      creds: (await getSetting<Creds>(ctx, "pathao")) ?? null,
      token: (await getSetting<Token>(ctx, "pathaoToken")) ?? null,
      tokenKey: "pathaoToken",
    }
  },
})

export const saveToken = internalMutation({
  args: { key: v.optional(v.string()), token: v.any() },
  handler: async (ctx, { key, token }) => setSetting(ctx, key ?? "pathaoToken", token),
})

export const cachedPlaces = internalQuery({
  args: { kind: v.string(), parentId: v.number() },
  handler: async (ctx, { kind, parentId }) =>
    await ctx.db.query("pathaoPlaces").withIndex("by_kind_parent", (q) => q.eq("kind", kind).eq("parentId", parentId)).collect(),
})

export const cachePlaces = internalMutation({
  args: { kind: v.string(), parentId: v.number(), places: v.array(v.object({ placeId: v.number(), name: v.string() })) },
  handler: async (ctx, { kind, parentId, places }) => {
    const old = await ctx.db.query("pathaoPlaces").withIndex("by_kind_parent", (q) => q.eq("kind", kind).eq("parentId", parentId)).collect()
    for (const o of old) await ctx.db.delete(o._id)
    for (const p of places) await ctx.db.insert("pathaoPlaces", { kind, parentId, placeId: p.placeId, name: p.name })
  },
})

// ---------- HTTP ----------
async function http(ctx: any, url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const r: { status: number; text: string } = await ctx.runAction(internal.pathaoNode.request, { url, method: init.method, headers: init.headers, body: init.body })
  let json: any = {}
  try { json = JSON.parse(r.text) } catch { json = {} }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json }
}
async function issueToken(ctx: any, creds: Creds, key: string): Promise<Token> {
  const res = await http(ctx, `${BASE[creds.env]}/aladdin/api/v1/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: creds.clientId, client_secret: creds.clientSecret,
      username: creds.username, password: creds.password, grant_type: "password",
    }),
  })
  const json: any = res.json
  if (!res.ok || !json.access_token) {
    throw new ConvexError(`Pathao login failed: ${json.message ?? res.status}`)
  }
  const token: Token = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 5 * 60 * 1000,
  }
  await ctx.runMutation(internal.pathao.saveToken, { key, token })
  return token
}

async function pathao(
  ctx: any,
  path: string,
  init: { method?: string; body?: unknown; partnerId?: Id<"deliveryPartners"> | null } = {},
): Promise<any> {
  const { creds, token, tokenKey } = await ctx.runQuery(internal.pathao.config, { partnerId: init.partnerId ?? undefined })
  if (!creds) throw new ConvexError("Pathao is not connected. Add your credentials in Settings → Pathao.")
  let tk: Token = token && token.expiresAt > Date.now() ? token : await issueToken(ctx, creds, tokenKey)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await http(ctx, `${BASE[creds.env as "sandbox" | "production"]}/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${tk.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
    if (res.status === 401 && attempt === 0) {
      tk = await issueToken(ctx, creds, tokenKey)
      continue
    }
    const json: any = res.json
    if (!res.ok) {
      const detail = json.errors ? Object.values(json.errors).flat().join("; ") : ""
      throw new ConvexError(`${json.message ?? `Pathao error ${res.status}`}${detail ? `: ${detail}` : ""}`)
    }
    return json
  }
}

const listOf = (json: any): any[] => json?.data?.data ?? json?.data ?? []

// ---------- public actions ----------
export const testConnection = action({
  args: { partnerId: v.optional(v.id("deliveryPartners")) },
  handler: async (ctx, { partnerId }) => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "settings.manage" })
    const { creds, tokenKey } = await ctx.runQuery(internal.pathao.config, { partnerId })
    if (!creds) throw new ConvexError("Save your Pathao credentials first")
    await issueToken(ctx, creds, tokenKey)
    const stores = listOf(await pathao(ctx, "aladdin/api/v1/stores", { partnerId }))
    return stores.map((s: any) => ({ id: Number(s.store_id), name: String(s.store_name), active: !!s.is_active }))
  },
})

export const places = action({
  args: { kind: v.union(v.literal("city"), v.literal("zone"), v.literal("area")), parentId: v.number(), refresh: v.optional(v.boolean()) },
  handler: async (ctx, { kind, parentId, refresh }): Promise<{ id: number; name: string }[]> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    if (!refresh) {
      const cached = await ctx.runQuery(internal.pathao.cachedPlaces, { kind, parentId })
      if (cached.length) return cached.map((p) => ({ id: p.placeId, name: p.name })).sort((a, b) => a.name.localeCompare(b.name))
    }
    const path =
      kind === "city" ? "aladdin/api/v1/city-list"
        : kind === "zone" ? `aladdin/api/v1/cities/${parentId}/zone-list`
          : `aladdin/api/v1/zones/${parentId}/area-list`
    const rows = listOf(await pathao(ctx, path))
    const out = rows.map((r: any) => ({
      placeId: Number(r.city_id ?? r.zone_id ?? r.area_id),
      name: String(r.city_name ?? r.zone_name ?? r.area_name),
    }))
    await ctx.runMutation(internal.pathao.cachePlaces, { kind, parentId, places: out })
    return out.map((p: any) => ({ id: p.placeId, name: p.name })).sort((a: any, b: any) => a.name.localeCompare(b.name))
  },
})

export const priceCheck = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<{ price: number; codPercent: number | null; raw: any }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const data = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    if (!data) throw new ConvexError("Order not found")
    const { order, pathaoStoreId, partnerId } = data
    if (!pathaoStoreId || !order.pathaoCityId || !order.pathaoZoneId) throw new ConvexError("Set the delivery partner's store and the order's city/zone first")
    const weight = Math.min(10, Math.max(0.5, order.items.reduce((s, i) => s + i.weightKg * i.qty, 0)))
    const res = await pathao(ctx, "aladdin/api/v1/merchant/price-plan", {
      method: "POST", partnerId,
      body: { store_id: pathaoStoreId, item_type: 2, delivery_type: order.deliveryType === "express" ? 12 : 48, item_weight: weight, recipient_city: order.pathaoCityId, recipient_zone: order.pathaoZoneId },
    })
    const d = res?.data ?? {}
    return { price: Number(d.final_price ?? d.price ?? 0), codPercent: d.cod_percentage !== undefined ? Number(d.cod_percentage) : null, raw: d }
  },
})

export const retryBook = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "courier.book" })
    await ctx.runAction(internal.pathao.bookOrder, { orderId })
  },
})

export const syncNow = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; moved: number }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    return await ctx.runAction(internal.pathao.syncAll, {})
  },
})

// ---------- booking ----------
export const bookOrder = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const data = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    if (!data) return
    const { order, pathaoStoreId, partnerId } = data
    if (order.consignmentId) return
    const fail = async (msg: string) =>
      ctx.runMutation(internal.orders.setCourier, { id: orderId, courierError: msg, log: `Pathao booking failed: ${msg}` })
    if (!pathaoStoreId) return fail("Delivery partner has no Pathao store selected (Settings → Delivery partners)")
    if (!order.pathaoCityId) {
      await ctx.runAction(internal.pathao.autoPlace, { orderId })
      const again = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
      if (again) Object.assign(order, again.order)
    }

    let address = order.address.trim()
    if (address.length < 10) address = `${address}, ${order.areaName ?? ""} ${order.zoneName ?? ""} ${order.cityName ?? ""}`.trim()
    const weight = Math.min(10, Math.max(0.5, order.items.reduce((s, i) => s + i.weightKg * i.qty, 0)))
    const qty = order.items.reduce((s, i) => s + i.qty, 0)
    const description = order.items.map((i) => `${i.sku} x${i.qty}`).join(", ").slice(0, 250)
    const label = order.invoiceCode ?? `BB-${order.invoiceNo}`
    try {
      const res = await pathao(ctx, "aladdin/api/v1/orders", {
        method: "POST", partnerId,
        body: {
          store_id: pathaoStoreId,
          merchant_order_id: label,
          recipient_name: order.customerName.slice(0, 100).padEnd(3, "."),
          recipient_phone: order.phone,
          recipient_address: address.slice(0, 220),
          ...(order.pathaoCityId ? { recipient_city: order.pathaoCityId } : {}),
          ...(order.pathaoZoneId ? { recipient_zone: order.pathaoZoneId } : {}),
          ...(order.pathaoAreaId ? { recipient_area: order.pathaoAreaId } : {}),
          delivery_type: order.deliveryType === "express" ? 12 : 48,
          item_type: 2,
          special_instruction: [order.isExchange ? "EXCHANGE — collect old item" : "", order.customerNote ?? ""].filter(Boolean).join(". ").slice(0, 250) || undefined,
          item_quantity: qty,
          item_weight: Number(weight.toFixed(2)),
          item_description: description,
          amount_to_collect: Math.round(order.due),
        },
      })
      const d = res?.data?.data ?? res?.data ?? {}
      await ctx.runMutation(internal.orders.setCourier, {
        id: orderId,
        consignmentId: String(d.consignment_id),
        courierStatus: String(d.order_status ?? "Pending"),
        courierFee: d.delivery_fee !== undefined ? Number(d.delivery_fee) : undefined,
        courierError: undefined,
        log: `Booked with Pathao — consignment ${d.consignment_id}${d.delivery_fee ? `, fee ৳${d.delivery_fee}` : ""}`,
      })
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e))
    }
  },
})

// ---------- status mapping ----------
export function targetFor(pathaoStatus: string): OrderStatus | null {
  const s = pathaoStatus.toLowerCase().replace(/[\s.-]+/g, "_")
  if (s.includes("payment_invoice") || s === "paid") return "delivered_paid"
  if (s.includes("paid_return") || s.includes("return")) return "pending_returned"
  if (s === "delivered" || s.includes("partial_delivery") || s === "exchange" || s.endsWith("_delivered")) return "delivered_due"
  if (["picked", "in_transit", "at_the_sorting_hub", "received_at_last_mile_hub", "assigned_for_delivery", "delivery_failed", "on_hold", "pickup_requested"].some((k) => s.includes(k))) {
    if (s.includes("pickup_requested")) return null
    return "in_transit"
  }
  return null
}

const PATH: OrderStatus[] = ["ready_to_ship", "in_transit", "delivered_due", "delivered_paid"]

async function moveTo(ctx: any, id: Id<"orders">, current: OrderStatus, target: OrderStatus, note: string) {
  if (target === current) return false
  if (canTransition(current, target)) {
    return await ctx.runMutation(internal.orders.systemStatus, { id, to: target, note })
  }
  const from = PATH.indexOf(current), to = PATH.indexOf(target)
  if (from >= 0 && to > from) {
    for (const step of PATH.slice(from + 1, to + 1)) {
      if (!canTransition(current, step)) break
      await ctx.runMutation(internal.orders.systemStatus, { id, to: step, note })
      current = step
    }
    return true
  }
  return false
}

export const syncAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; moved: number }> => {
    const rows = await ctx.runMutation(internal.orders.shippedForSync, {})
    let moved = 0
    for (const r of rows) {
      try {
        const res = await pathao(ctx, `aladdin/api/v1/orders/${r.consignmentId}/info`)
        const d = res?.data?.data ?? res?.data ?? {}
        const ps = String(d.order_status_slug ?? d.order_status ?? "")
        if (!ps) continue
        await ctx.runMutation(internal.orders.setCourier, { id: r._id as Id<"orders">, courierStatus: ps })
        const target = targetFor(ps)
        if (target && (await moveTo(ctx, r._id as Id<"orders">, r.status as OrderStatus, target, `Pathao: ${ps}`))) moved++
      } catch {
        // skip this one; next run retries
      }
    }
    return { checked: rows.length, moved }
  },
})

// ---------- live webhook from Pathao ----------
export const webhookSecret = internalQuery({
  args: {},
  handler: async (ctx) => (await getSetting<any>(ctx, "pathaoWebhook")) ?? null,
})

export const byConsignment = internalQuery({
  args: { consignmentId: v.string() },
  handler: async (ctx, { consignmentId }) => {
    const o = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", consignmentId)).first()
    return o ? { _id: o._id, status: o.status } : null
  },
})

export const webhook = httpAction(async (ctx, req) => {
  const cfg = await ctx.runQuery(internal.pathao.webhookSecret, {})
  const headers = new Headers({ "Content-Type": "application/json" })
  if (cfg?.integrationSecret) headers.set("X-Pathao-Merchant-Webhook-Integration-Secret", cfg.integrationSecret)
  const sig = req.headers.get("X-Pathao-Signature")
  if (cfg?.signatureToken && sig && sig !== cfg.signatureToken) return new Response('{"ok":false}', { status: 401, headers })
  const body: any = await req.json().catch(() => ({}))
  const consignment = String(body.consignment_id ?? body.consignmentId ?? "")
  const status = String(body.order_status ?? body.event ?? "").replace(/^order\./, "")
  if (consignment && status) {
    const o = await ctx.runQuery(internal.pathao.byConsignment, { consignmentId: consignment })
    if (o) {
      await ctx.runMutation(internal.orders.setCourier, { id: o._id, courierStatus: status })
      const target = targetFor(status)
      if (target) await moveTo(ctx, o._id, o.status as OrderStatus, target, `Pathao: ${status}`)
    }
  }
  return new Response('{"ok":true}', { status: 202, headers })
})

// ---------- address auto-detect (same parser the Pathao merchant panel uses) ----------
type Parsed = { cityId: number; cityName: string; zoneId?: number; zoneName?: string; areaId?: number; areaName?: string }

async function parse(ctx: any, address: string): Promise<Parsed | null> {
  const { creds, token, tokenKey } = await ctx.runQuery(internal.pathao.config, {})
  if (!creds || creds.env !== "production" || address.trim().length < 6) return null
  let tk: Token = token && token.expiresAt > Date.now() ? token : await issueToken(ctx, creds, tokenKey)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await http(ctx, "https://merchant.pathao.com/api/v1/address-parser", {
      method: "POST",
      headers: { Authorization: `Bearer ${tk.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ address: address.trim().slice(0, 220) }),
    })
    if (res.status === 401 && attempt === 0) { tk = await issueToken(ctx, creds, tokenKey); continue }
    const d = res.json?.data
    if (!res.ok || !d?.district_id) return null
    return {
      cityId: Number(d.district_id), cityName: String(d.district_name ?? ""),
      zoneId: d.zone_id ? Number(d.zone_id) : undefined, zoneName: d.zone_name ?? undefined,
      areaId: d.area_id ? Number(d.area_id) : undefined, areaName: d.area_name ?? undefined,
    }
  }
  return null
}

export const parseAddress = action({
  args: { address: v.string() },
  handler: async (ctx, { address }): Promise<Parsed | null> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    try { return await parse(ctx, address) } catch { return null }
  },
})

export const autoPlace = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const data = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    if (!data || data.order.pathaoCityId) return
    const o = data.order
    const p = await parse(ctx, [o.address, o.areaName, o.zoneName, o.cityName].filter(Boolean).join(", ")).catch(() => null)
    if (p) await ctx.runMutation(internal.orders.setPlace, { id: orderId, ...p })
  },
})

export const detectOpenOrders = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; found: number }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "settings.manage" })
    const ids = await ctx.runQuery(internal.orders.needingPlace, {})
    let found = 0
    for (const id of ids) {
      await ctx.runAction(internal.pathao.autoPlace, { orderId: id })
      const d = await ctx.runMutation(internal.orders.internalGet, { id })
      if (d?.order.pathaoCityId) found++
    }
    return { checked: ids.length, found }
  },
})

// ---------- customer's delivery record across all Pathao merchants (same check the Pathao panel shows) ----------
export type CourierHistory = {
  provider: "pathao"
  processed: number
  delivered: number
  returned: number
  successRate: number | null
  rating: string | null // e.g. "Excellent", "Good", "Risky", "New"
  message: string | null
  at: number
}

const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0)

/** Reads Pathao's response whatever shape it comes in. */
function readHistory(json: any): Omit<CourierHistory, "provider" | "at" | "successRate"> | null {
  const d = json?.data ?? json
  if (!d || typeof d !== "object") return null
  const c = d.customer ?? d.data?.customer ?? d
  const processed = num(c.total_delivery ?? c.total_parcel ?? c.total ?? c.processed ?? c.total_order)
  const delivered = num(c.successful_delivery ?? c.success ?? c.delivered ?? c.total_delivered)
  let returned = num(c.returned ?? c.total_return ?? c.failed_delivery ?? c.cancelled)
  if (!returned && processed >= delivered) returned = processed - delivered
  const r = d.customer_rating ?? c.customer_rating ?? c.rating ?? d.rating
  const rating = typeof r === "string" ? r.replace(/_/g, " ").replace(/\b\w/g, (m: string) => m.toUpperCase()) : r?.label ?? r?.name ?? null
  const message = d.message_text ?? d.remarks ?? c.message ?? (typeof d.message === "string" && !/success/i.test(d.message) ? d.message : null)
  return { processed, delivered, returned, rating: rating ? String(rating) : null, message: message ? String(message) : null }
}

export const cachedHistory = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => await ctx.db.query("courierChecks").withIndex("by_phone", (q) => q.eq("phone", phone).eq("provider", "pathao")).first(),
})

export const saveHistory = internalMutation({
  args: { phone: v.string(), data: v.any() },
  handler: async (ctx, { phone, data }) => {
    const old = await ctx.db.query("courierChecks").withIndex("by_phone", (q) => q.eq("phone", phone).eq("provider", "pathao")).first()
    if (old) await ctx.db.patch(old._id, { data, at: Date.now() })
    else await ctx.db.insert("courierChecks", { phone, provider: "pathao", data, at: Date.now() })
  },
})

/** Customer's delivery record on Pathao (all merchants). Cached for 12 hours unless `fresh`. */
export const customerHistory = action({
  args: { phone: v.string(), fresh: v.optional(v.boolean()) },
  handler: async (ctx, { phone, fresh }): Promise<CourierHistory | { error: string }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const p = phone.replace(/\D/g, "").replace(/^88/, "")
    if (!/^01\d{9}$/.test(p)) return { error: "Phone number looks wrong" }
    const cached = await ctx.runQuery(internal.pathao.cachedHistory, { phone: p })
    if (cached && !fresh && Date.now() - cached.at < 12 * 3600000) return { ...(cached.data as CourierHistory), at: cached.at }

    const { creds, token, tokenKey } = await ctx.runQuery(internal.pathao.config, {})
    if (!creds || creds.env !== "production") return { error: "Connect Pathao (live) in Settings to see courier history" }
    let tk: Token = token && token.expiresAt > Date.now() ? token : await issueToken(ctx, creds, tokenKey)
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await http(ctx, "https://merchant.pathao.com/api/v1/user/success", {
        method: "POST",
        headers: { Authorization: `Bearer ${tk.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: p }),
      })
      if (res.status === 401 && attempt === 0) { tk = await issueToken(ctx, creds, tokenKey); continue }
      if (!res.ok) {
        console.log("pathao user/success", res.status, JSON.stringify(res.json).slice(0, 500))
        return { error: `Pathao didn't answer (${res.status})` }
      }
      const h = readHistory(res.json)
      if (!h) {
        console.log("pathao user/success unknown shape", JSON.stringify(res.json).slice(0, 800))
        return { error: "Couldn't read Pathao's answer" }
      }
      const done = h.delivered + h.returned
      const data: CourierHistory = { provider: "pathao", ...h, successRate: done ? Math.round((h.delivered / done) * 100) : null, at: Date.now() }
      console.log("pathao user/success shape", JSON.stringify(res.json).slice(0, 800))
      await ctx.runMutation(internal.pathao.saveHistory, { phone: p, data })
      return data
    }
    return { error: "Pathao login failed" }
  },
})
