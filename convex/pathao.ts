import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
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
  handler: async (ctx): Promise<{ checked: number; moved: number; failed: number; changes: string[]; errors: string[] }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    return await ctx.runAction(internal.pathao.syncAll, {})
  },
})

/** "Push to Pathao" for one or many orders (order page button or bulk action in the list). */
export const pushMany = action({
  args: { ids: v.array(v.id("orders")) },
  handler: async (ctx, { ids }): Promise<{ booked: string[]; failed: string[]; skipped: string[] }> => {
    const by = await ctx.runQuery(internal.pathao.checkPerm, { perm: "courier.book" })
    const booked: string[] = [], failed: string[] = [], skipped: string[] = []
    const one = async (id: Id<"orders">) => {
      const before = await ctx.runMutation(internal.orders.internalGet, { id })
      if (!before) return
      const o = before.order
      const label = o.invoiceCode ?? `BB-${o.invoiceNo}`
      if (o.consignmentId) { skipped.push(`${label} (already sent)`); return }
      if (before.noCourier) { skipped.push(`${label} (exchange warehouse — never sent to Pathao)`); return }
      if (o.courier !== "pathao") { skipped.push(`${label} (not a Pathao order)`); return }
      if (["pending", "on_hold", "cancelled", "returned", "delivered_paid", "delivered_due"].includes(o.status)) { skipped.push(`${label} (${o.status.replace(/_/g, " ")})`); return }
      await ctx.runAction(internal.pathao.bookOrder, { orderId: id })
      const after = await ctx.runMutation(internal.orders.internalGet, { id })
      if (after?.order.consignmentId) {
        booked.push(`${label} → ${after.order.consignmentId}`)
        // handed to Pathao = In Transit (same as Scan), so stock and the dispatch report follow
        if (after.order.status !== "in_transit") await ctx.runMutation(internal.orders.systemStatus, { id, to: "in_transit", note: "Pushed to Pathao", byName: typeof by === "string" ? by : undefined })
      }
      else failed.push(`${label}: ${after?.order.courierError ?? "not booked"}`)
    }
    for (let i = 0; i < ids.length; i += 5) await Promise.all(ids.slice(i, i + 5).map(one))
    return { booked, failed, skipped }
  },
})

/** Cancel the parcel on Pathao (only possible before the rider picks it up), then clear it from the order. */
export const cancelParcel = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<{ ok: true }> => {
    const by = await ctx.runQuery(internal.pathao.checkPerm, { perm: "courier.book" })
    const g = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    const cid = g?.order.consignmentId
    if (!g || !cid) throw new ConvexError("This order has no Pathao parcel")
    // same call Pathao's own merchant panel makes for "Cancel order"
    const res = await merchantGet(ctx, `${MB}/orders/${encodeURIComponent(cid)}/cancel`, g.partnerId, { method: "PUT" })
    const msg = String(res.json?.message ?? "")
    if (!res.ok) throw new ConvexError(`Pathao did not cancel it: ${msg || `error ${res.status}`}. Parcels can only be cancelled before pickup.`)
    await ctx.runMutation(internal.orders.clearParcel, { id: orderId, cid, by })
    return { ok: true }
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
    // Exchange warehouse orders are never sent to Pathao, whatever path called this
    if (data.noCourier) {
      await ctx.runMutation(internal.orders.setCourier, { id: orderId, log: `Not sent to Pathao — ${data.locationName} is an exchange warehouse` })
      return
    }
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
  handler: async (ctx): Promise<{ checked: number; moved: number; failed: number; changes: string[]; errors: string[] }> => {
    const rows = await ctx.runMutation(internal.orders.shippedForSync, {})
    let moved = 0, failed = 0
    const changes: string[] = []
    const errors: string[] = []
    const one = async (r: (typeof rows)[number]) => {
      try {
        const res = await pathao(ctx, `aladdin/api/v1/orders/${r.consignmentId}/info`)
        const d = res?.data?.data ?? res?.data ?? {}
        const ps = String(d.order_status_slug ?? d.order_status ?? "")
        if (!ps) { failed++; errors.push(`${r.invoice} (${r.consignmentId}): no status`); return }
        await ctx.runMutation(internal.orders.setCourier, { id: r._id as Id<"orders">, courierStatus: ps })
        const target = targetFor(ps)
        if (target && (await moveTo(ctx, r._id as Id<"orders">, r.status as OrderStatus, target, `Pathao: ${ps}`))) {
          moved++
          changes.push(`${r.invoice}: ${ps.replace(/[_-]+/g, " ")}`)
        }
      } catch (e) {
        failed++ // next run retries
        errors.push(`${r.invoice} (${r.consignmentId}, ${r.status}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 160))
      }
    }
    // 8 parcels at a time — about 6× faster than one by one
    if (rows.length) await one(rows[0]) // first call alone so a fresh Pathao login is shared by the rest
    for (let i = 1; i < rows.length; i += 8) await Promise.all(rows.slice(i, i + 8).map(one))
    if (errors.length) console.log(`Pathao status sync: ${errors.length} failed`, errors.slice(0, 10))
    return { checked: rows.length, moved, failed, changes, errors: errors.slice(0, 20) }
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

// ---------- parcel tracking: the same timeline and costs the Pathao merchant panel shows ----------
export type TrackEvent = { stage: string | null; text: string; at: number | null }
export type Tracking = {
  consignmentId: string
  status: string | null
  paymentStatus: string | null
  events: TrackEvent[]
  costs: { label: string; amount: number }[]
  info: { label: string; value: string }[]
  trackingUrl: string | null
  at: number
}

const STAGE_WORDS = ["accepted", "picked", "in-transit", "in transit", "ready for delivery", "delivered", "returned", "return", "hold", "cancel", "paid"]
const TEXT_KEYS = ["message", "description", "log", "text", "remarks", "note", "title", "event", "status_text", "activity"]
const TIME_KEYS = ["created_at", "time", "date", "updated_at", "timestamp", "event_time", "createdAt"]
const STAGE_KEYS = ["stage", "group", "status", "order_status", "type", "label", "name"]

const toTime = (x: any): number | null => {
  if (x == null || x === "") return null
  if (typeof x === "number") return x < 1e12 ? x * 1000 : x
  // Pathao panel format: "Oct 24, 2026 2:59 PM" (Dhaka time)
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M$/.test(String(x))) { const t = Date.parse(`${x} GMT+0600`); return Number.isFinite(t) ? t : null }
  const t = Date.parse(String(x).includes("T") || /[+Z]/.test(String(x)) ? String(x) : `${String(x).replace(" ", "T")}+06:00`)
  return Number.isFinite(t) ? t : null
}
const pick = (o: any, keys: string[]) => { for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k]; return undefined }

/** Finds timeline entries in Pathao's answer whatever shape it has (flat list or grouped by stage). */
function readEvents(json: any): TrackEvent[] {
  // Known shape: { data: { state: { name }, log: [{ desc, created_at, grouped_status: [stage, ...], notes }] } }
  const log = json?.data?.log
  if (Array.isArray(log)) {
    return log.map((l: any) => ({
      stage: Array.isArray(l.grouped_status) && l.grouped_status[0] ? String(l.grouped_status[0]) : null,
      text: `${String(l.desc ?? "").trim()}${l.notes ? ` — ${String(l.notes).trim()}` : ""}`,
      at: toTime(l.created_at),
    })).filter((e: TrackEvent) => e.text).sort((a: TrackEvent, b: TrackEvent) => (a.at ?? 0) - (b.at ?? 0))
  }
  const out: TrackEvent[] = []
  const walk = (node: any, stage: string | null, depth: number) => {
    if (depth > 6 || node == null) return
    if (Array.isArray(node)) { for (const n of node) walk(n, stage, depth + 1); return }
    if (typeof node !== "object") return
    const text = pick(node, TEXT_KEYS)
    const time = pick(node, TIME_KEYS)
    const ownStage = pick(node, STAGE_KEYS)
    const childArrays = Object.entries(node).filter(([, v]) => Array.isArray(v) && (v as any[]).some((x) => x && typeof x === "object"))
    if (typeof text === "string" && time != null && childArrays.length === 0) {
      out.push({ stage: typeof ownStage === "string" && ownStage !== text ? ownStage : stage, text: text.replace(/^\s*-\s*/, "").trim(), at: toTime(time) })
      return
    }
    const nextStage = typeof ownStage === "string" && ownStage.length < 40 ? ownStage : stage
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v, STAGE_WORDS.some((w) => k.toLowerCase().includes(w)) ? k : nextStage, depth + 1)
    }
  }
  walk(json?.data ?? json, null, 0)
  const seen = new Set<string>()
  return out.filter((e) => { const k = `${e.text}|${e.at}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

function readDetails(json: any) {
  const d = json?.data?.data ?? json?.data ?? json ?? {}
  const n = (x: any) => (x == null || x === "" ? null : Number(x))
  const costs: { label: string; amount: number }[] = []
  const addCost = (label: string, keys: string[], negative = false) => {
    const v = n(pick(d, keys) ?? pick(d.cost ?? d.charges ?? d.invoice ?? {}, keys))
    if (v !== null && Number.isFinite(v)) costs.push({ label, amount: negative ? -Math.abs(v) : v })
  }
  addCost("Delivery fee", ["delivery_fee", "delivery_charge"])
  addCost("COD fee", ["cod_fee", "cod_charge"])
  addCost("Discount", ["discount", "merchant_discount"], true)
  addCost("Promo discount", ["promo_discount"], true)
  addCost("Additional charge", ["additional_charge"])
  addCost("Compensation", ["compensation_cost"])
  addCost("Total cost", ["total_fee", "total_cost", "total_charge"])
  const info: { label: string; value: string }[] = []
  const addInfo = (label: string, keys: string[], fmt?: (v: any) => string) => { const v = pick(d, keys); if (v != null && v !== "" && v !== "-" && typeof v !== "object") info.push({ label, value: fmt ? fmt(v) : String(v) }) }
  addInfo("Amount to collect", ["amount_to_collect", "collectable_amount", "order_amount", "cod_amount"], (v) => (Number.isFinite(Number(v)) ? `৳${Number(v).toLocaleString("en-IN")}` : String(v)))
  addInfo("Collected", ["collected_amount"])
  addInfo("Delivery type", ["delivery_type_name", "delivery_type"], (v) => (String(v) === "48" ? "Normal (48 hours)" : String(v) === "12" ? "On demand (12 hours)" : String(v)))
  addInfo("Weight", ["item_weight", "total_weight", "weight"], (v) => `${v} kg`)
  addInfo("Area (Pathao)", ["zone_name"], (v) => [d.area_name, v, d.city_name].filter((x: any) => x && x !== "N/A").join(", "))
  addInfo("Delivery agent", ["delivery_agent_name", "rider_name", "delivery_man_name"])
  addInfo("Agent phone", ["delivery_agent_phone", "rider_phone", "delivery_man_phone"])
  addInfo("Hub", ["hub_name", "current_hub"])
  addInfo("Failed / hold reason", ["failed_reason", "return_reason", "hold_reason"])
  addInfo("Modification notes", ["modification_notes"])
  addInfo("Product description", ["item_description", "order_description"])
  addInfo("Special instruction", ["special_instruction", "delivery_instruction"])
  const status = pick(d, ["order_status", "order_status_slug", "status"])
  const pay = pick(d, ["billing_status", "payment_status", "invoice_status"])
  const link = pick(d, ["short_link", "tracking_link", "tracking_url", "public_tracking_url", "share_link"])
  return { costs, info, status: status != null && typeof status !== "object" ? String(status) : null, paymentStatus: pay != null && typeof pay !== "object" ? String(pay) : null, trackingUrl: link ? String(link) : null }
}

export const cachedTracking = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => await ctx.db.query("courierTracking").withIndex("by_order", (q) => q.eq("orderId", orderId)).first(),
})

export const saveTracking = internalMutation({
  args: { orderId: v.id("orders"), data: v.any() },
  handler: async (ctx, { orderId, data }) => {
    const old = await ctx.db.query("courierTracking").withIndex("by_order", (q) => q.eq("orderId", orderId)).first()
    if (old) await ctx.db.patch(old._id, { data, at: Date.now() })
    else await ctx.db.insert("courierTracking", { orderId, data, at: Date.now() })
  },
})

async function merchantGet(ctx: any, url: string, partnerId?: Id<"deliveryPartners"> | null, send?: { method: string; body?: unknown }) {
  const { creds, token, tokenKey } = await ctx.runQuery(internal.pathao.config, { partnerId: partnerId ?? undefined })
  if (!creds || creds.env !== "production") throw new ConvexError("Connect Pathao (live) in Settings")
  let tk: Token = token && token.expiresAt > Date.now() ? token : await issueToken(ctx, creds, tokenKey)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await http(ctx, url, {
      method: send?.method ?? "GET",
      headers: { Authorization: `Bearer ${tk.accessToken}`, Accept: "application/json", ...(send?.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: send?.body !== undefined ? JSON.stringify(send.body) : undefined,
    })
    if (res.status === 401 && attempt === 0) { tk = await issueToken(ctx, creds, tokenKey); continue }
    return res
  }
  throw new ConvexError("Pathao login failed")
}

/** Pathao timeline + costs for a booked order. Cached 10 minutes unless `fresh`. */
export const tracking = action({
  args: { orderId: v.id("orders"), fresh: v.optional(v.boolean()) },
  handler: async (ctx, { orderId, fresh }): Promise<Tracking | { error: string }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const g = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    const cid = g?.order.consignmentId
    if (!g || !cid) return { error: "Not booked with Pathao yet" }
    const cached = await ctx.runQuery(internal.pathao.cachedTracking, { orderId })
    if (cached && !fresh && Date.now() - cached.at < 10 * 60000 && cached.data?.consignmentId === cid && cached.data?.v === 2) return { ...(cached.data as Tracking), at: cached.at }

    const base = `https://merchant.pathao.com/api/v1/orders/${encodeURIComponent(cid)}`
    const phone = g.order.phone
    const [det, act] = await Promise.all([
      merchantGet(ctx, `${base}?archive=0`, g.partnerId),
      merchantGet(ctx, `${base}/${encodeURIComponent(phone)}/activity?archive=0`, g.partnerId),
    ])
    console.log("pathao tracking shapes", det.status, JSON.stringify(det.json).slice(0, 1500), "|||", act.status, JSON.stringify(act.json).slice(0, 2500))
    if (!det.ok && !act.ok) return { error: `Pathao didn't answer (${act.status})` }
    const dd = readDetails(det.json)
    const data: Tracking & { v: number } = {
      v: 2,
      consignmentId: cid,
      status: dd.status, paymentStatus: dd.paymentStatus,
      events: act.ok ? readEvents(act.json) : [],
      costs: dd.costs, info: dd.info,
      trackingUrl: dd.trackingUrl,
      at: Date.now(),
    }
    await ctx.runMutation(internal.pathao.saveTracking, { orderId, data })
    return data
  },
})

/** Admin check from the Convex dashboard: how a consignment's tracking reads (parsed + raw sample). */
export const debugTracking = internalAction({
  args: { consignmentId: v.string(), phone: v.string() },
  handler: async (ctx, { consignmentId, phone }) => {
    const base = `https://merchant.pathao.com/api/v1/orders/${encodeURIComponent(consignmentId)}`
    const [det, act] = await Promise.all([merchantGet(ctx, `${base}?archive=0`), merchantGet(ctx, `${base}/${encodeURIComponent(phone)}/activity?archive=0`)])
    return {
      detailsStatus: det.status, activityStatus: act.status,
      parsed: { ...readDetails(det.json), events: readEvents(act.json) },
      rawActivity: JSON.stringify(act.json).slice(0, 3000),
      rawDetailsKeys: Object.keys(det.json?.data ?? det.json ?? {}),
    }
  },
})

/** Admin check from the Convex dashboard: raw shapes of Pathao's parcel list and invoices. */
export const debugMoney = internalAction({
  args: { phone: v.optional(v.string()), invoiceId: v.optional(v.string()) },
  handler: async (ctx, { phone, invoiceId }) => {
    const B = "https://merchant.pathao.com/api/v1"
    const list = await merchantGet(ctx, `${B}/orders/all?${phone ? `receiver_phone=${phone}&` : ""}transfer_status=4&archive=0&page=1&limit=3`)
    const stats = await merchantGet(ctx, `${B}/monetary/stats/invoice?type=all`)
    const inv = await merchantGet(ctx, `${B}/monetary/invoices/receivable?page=1&limit=2`)
    const br = invoiceId ? await merchantGet(ctx, `${B}/monetary/invoices/${invoiceId}/breakdown`) : null
    return {
      listKeys: Object.keys(list.json?.data?.data?.[0] ?? {}),
      listFirst: Object.fromEntries(Object.entries(list.json?.data?.data?.[0] ?? {}).filter(([k]) => !/address|description|instruction|name/.test(k))),
      listPaging: Object.fromEntries(Object.entries(list.json?.data ?? {}).filter(([k]) => k !== "data")),
      stats: JSON.stringify(stats.json).slice(0, 600),
      invoices: JSON.stringify(inv.json).slice(0, 1500),
      breakdown: br ? JSON.stringify(br.json).slice(0, 2000) : null,
    }
  },
})

// =====================================================================================
// Pathao money sync: link parcels to our orders, and record what Pathao collected & paid us
// =====================================================================================
const MB = "https://merchant.pathao.com/api/v1"
const utc = (s: any): number | undefined => { if (!s) return undefined; const t = Date.parse(`${String(s).replace(" ", "T")}Z`); return Number.isFinite(t) ? t : undefined }
const orderNo = (mid: any): number | null => { const m = String(mid ?? "").trim().match(/^BB-?(\d+)$/i); return m ? Number(m[1]) : null }

const parcelRow = v.object({
  cid: v.string(), mid: v.optional(v.string()), billing: v.optional(v.string()), invoiceId: v.optional(v.string()),
  billingAt: v.optional(v.number()), fee: v.optional(v.number()), amount: v.optional(v.number()), type: v.optional(v.string()),
  phone: v.optional(v.string()),
})
const last10 = (p?: string | null) => String(p ?? "").replace(/\D/g, "").slice(-10)

/** Links Pathao parcels to our orders (by consignment, then by our order number) and stores billing status. */
export const applyParcels = internalMutation({
  args: { rows: v.array(parcelRow) },
  handler: async (ctx, { rows }) => {
    let linked = 0, updated = 0
    for (const r of rows) {
      let o = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", r.cid)).first()
      if (!o && r.type !== "Return") {
        const n = orderNo(r.mid)
        const cand = n ? await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", n)).first() : null
        // the order number alone is not enough (numbers can differ between systems) — the customer's phone must match too
        const phoneOk = !!r.phone && !!cand && last10(cand.phone) === last10(r.phone)
        const candLoc = cand ? await ctx.db.get(cand.locationId) : null
        if (cand && phoneOk && !candLoc?.noCourier && !cand.consignmentId && !cand.deletedAt && !["pending", "on_hold", "cancelled"].includes(cand.status)) {
          await ctx.db.patch(cand._id, { consignmentId: r.cid, courier: "pathao", courierLinkedBy: "order no", courierError: undefined, updatedAt: Date.now() })
          await ctx.db.insert("orderEvents", { orderId: cand._id, type: "log", text: `Linked to Pathao parcel ${r.cid} (same order number on Pathao)`, byName: "Pathao sync", at: Date.now() })
          o = (await ctx.db.get(cand._id))!
          linked++
        }
      }
      if (!o) continue
      const paid = r.billing?.toLowerCase() === "paid"
      const patch: Partial<Doc<"orders">> = {}
      if (r.fee !== undefined && o.courierCost !== r.fee) patch.courierCost = r.fee
      if (paid && !o.courierPaid) { patch.courierPaid = true; patch.courierPaidAt = r.billingAt ?? Date.now() }
      if (r.invoiceId && o.courierInvoiceId !== r.invoiceId) patch.courierInvoiceId = r.invoiceId
      if (Object.keys(patch).length) { await ctx.db.patch(o._id, patch); updated++ }
    }
    return { linked, updated }
  },
})

const invoiceLine = v.object({ cid: v.string(), mid: v.optional(v.string()), type: v.string(), collected: v.number(), payout: v.number(), fee: v.number() })

/** Stores one Pathao invoice and marks its parcels as paid by Pathao. Returns orders that should now be Delivered · Paid. */
export const applyInvoice = internalMutation({
  args: {
    inv: v.object({ invoiceId: v.string(), createdAt: v.number(), collected: v.number(), deliveryFee: v.number(), codFee: v.number(), discount: v.number(), totalFee: v.number(), receivable: v.number(), status: v.string() }),
    lines: v.array(invoiceLine),
  },
  handler: async (ctx, { inv, lines }) => {
    const toPaid: { id: Id<"orders">; status: string }[] = []
    let matched = 0
    const paid = inv.status.toLowerCase() === "paid"
    for (const l of lines) {
      const o = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", l.cid)).first()
      if (!o) continue
      matched++
      if (l.type !== "delivery") { if (l.fee && o.courierCost === undefined) await ctx.db.patch(o._id, { courierCost: l.fee }); continue }
      const patch: Partial<Doc<"orders">> = { courierInvoiceId: inv.invoiceId, courierCollected: l.collected, courierPayout: l.payout, courierCost: l.fee }
      if (paid) { patch.courierPaid = true; patch.courierPaidAt = o.courierPaidAt ?? inv.createdAt }
      const changed = Object.entries(patch).some(([k, val]) => (o as any)[k] !== val)
      if (changed) {
        await ctx.db.patch(o._id, patch)
        if (paid && !o.courierPaid) await ctx.db.insert("orderEvents", { orderId: o._id, type: "log", text: `Pathao paid us ৳${l.payout} for this parcel (collected ৳${l.collected}, fee ৳${l.fee}) — invoice ${inv.invoiceId}`, byName: "Pathao sync", at: Date.now() })
      }
      if (paid && l.collected > 0 && ["ready_to_ship", "in_transit", "delivered_due"].includes(o.status)) toPaid.push({ id: o._id, status: o.status })
    }
    const old = await ctx.db.query("pathaoInvoices").withIndex("by_invoice", (q) => q.eq("invoiceId", inv.invoiceId)).first()
    const row = { ...inv, parcels: lines.length, matched, syncedAt: Date.now() }
    if (old) await ctx.db.patch(old._id, row)
    else await ctx.db.insert("pathaoInvoices", row)
    return toPaid
  },
})

export const knownInvoices = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const out: Record<string, string> = {}
    for (const id of ids) {
      const r = await ctx.db.query("pathaoInvoices").withIndex("by_invoice", (q) => q.eq("invoiceId", id)).first()
      if (r) out[id] = r.status
    }
    return out
  },
})

export const saveMoneySync = internalMutation({
  args: { result: v.any() },
  handler: async (ctx, { result }) => { await setSetting(ctx, "pathaoMoneySync", { ...result, at: Date.now() }) },
})

/** Runs the whole money sync. `days` = how far back to look at parcels and invoices. */
export const syncMoney = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 20 }): Promise<any> => {
    const since = Date.now() - days * 86400000
    let parcels = 0, linked = 0, updated = 0, invoices = 0, paidMoved = 0
    // 1) parcels: link to orders, billing status
    for (let page = 1; page <= 60; page++) {
      const res = await merchantGet(ctx, `${MB}/orders/all?transfer_status=4&archive=0&page=${page}&limit=100`)
      const d = res.json?.data
      const list: any[] = d?.data ?? []
      if (!res.ok || list.length === 0) break
      const rows = list.map((p) => ({
        cid: String(p.order_consignment_id), mid: p.merchant_order_id ? String(p.merchant_order_id) : undefined,
        billing: p.billing_status ? String(p.billing_status) : undefined, invoiceId: p.order_invoice_id ? String(p.order_invoice_id) : undefined,
        billingAt: utc(p.billing_date), fee: Number.isFinite(Number(p.total_fee)) ? Number(p.total_fee) : undefined,
        amount: Number.isFinite(Number(p.order_amount)) ? Number(p.order_amount) : undefined, type: p.order_type ? String(p.order_type) : undefined,
        phone: (p.recipient_phone ?? p.receiver_phone ?? p.customer_phone) ? String(p.recipient_phone ?? p.receiver_phone ?? p.customer_phone) : undefined,
      })).filter((r) => r.cid && r.cid !== "undefined")
      const r = await ctx.runMutation(internal.pathao.applyParcels, { rows })
      parcels += rows.length; linked += r.linked; updated += r.updated
      const oldest = Math.min(...list.map((p) => utc(p.order_created_at) ?? Date.now()))
      if (oldest < since || page >= Number(d?.last_page ?? page)) break
    }
    // 2) invoices: what Pathao collected and paid us, per parcel
    let knownStreak = 0
    // quick runs stop after a long run of invoices we already have; deep runs (more than 20 days) read everything in range
    const stopAfterKnown = days > 20 ? Infinity : 25
    for (let page = 1; page <= 60 && knownStreak < stopAfterKnown; page++) {
      const res = await merchantGet(ctx, `${MB}/monetary/invoices/receivable?page=${page}&limit=20`)
      const list: any[] = res.json?.data?.data ?? []
      if (!res.ok || list.length === 0) break
      const known = await ctx.runQuery(internal.pathao.knownInvoices, { ids: list.map((i) => String(i.order_invoice_id)) })
      let tooOld = false
      for (const i of list) {
        const id = String(i.order_invoice_id)
        const createdAt = utc(i.invoice_created_at) ?? Date.now()
        if (createdAt < since) { tooOld = true; break }
        const status = String(i.status ?? "")
        if (known[id] && known[id] === status && status.toLowerCase() === "paid") { knownStreak++; continue }
        knownStreak = 0
        const br = await merchantGet(ctx, `${MB}/monetary/invoices/${encodeURIComponent(id)}/breakdown`)
        const lines = (br.json?.data ?? []).map((l: any) => ({
          cid: String(l.consignment_id), mid: l.merchant_order_id ? String(l.merchant_order_id) : undefined, type: String(l.invoice_type ?? ""),
          collected: Number(l.collected_amount) || 0, payout: Number(l.payout) || 0, fee: Number(l.final_fee) || 0,
        }))
        const toPaid: { id: Id<"orders">; status: string }[] = await ctx.runMutation(internal.pathao.applyInvoice, {
          inv: {
            invoiceId: id, createdAt, collected: Number(i.collected_amount) || 0, deliveryFee: Number(i.delivery_fee) || 0, codFee: Number(i.cod_fee) || 0,
            discount: Number(i.discount) || 0, totalFee: Number(i.total_fee) || 0, receivable: Number(i.receivable_amount) || 0, status,
          },
          lines,
        })
        invoices++
        for (const o of toPaid) if (await moveTo(ctx, o.id, o.status as OrderStatus, "delivered_paid", `Pathao paid (invoice ${id})`)) paidMoved++
      }
      if (tooOld) break
    }
    const result = { parcels, linked, updated, invoices, paidMoved, days }
    await ctx.runMutation(internal.pathao.saveMoneySync, { result })
    return result
  },
})

export const syncMoneyNow = action({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }): Promise<any> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    return await ctx.runAction(internal.pathao.syncMoney, { days: days ?? 20 })
  },
})

/** Live totals from Pathao (collected, receivable, received, fees). */
export const moneyStats = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const res = await merchantGet(ctx, `${MB}/monetary/stats/invoice?type=all`)
    const d = res.json?.data ?? {}
    return { raw: d }
  },
})

/** Pathao parcels for this customer's phone — to link an order that was booked under another number. */
export const parcelsForOrder = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<any[]> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const g = await ctx.runMutation(internal.orders.internalGet, { id: orderId })
    if (!g) return []
    const res = await merchantGet(ctx, `${MB}/orders/all?receiver_phone=${encodeURIComponent(g.order.phone)}&transfer_status=4&archive=0&page=1&limit=20`)
    const list: any[] = res.json?.data?.data ?? []
    const used = await ctx.runQuery(internal.pathao.usedConsignments, { ids: list.map((p) => String(p.order_consignment_id)) })
    return list.map((p) => ({
      cid: String(p.order_consignment_id), mid: p.merchant_order_id ?? null, status: p.order_status ?? null, type: p.order_type ?? null,
      amount: Number(p.order_amount) || 0, createdAt: utc(p.order_created_at) ?? null, billing: p.billing_status ?? null,
      usedBy: used[String(p.order_consignment_id)] ?? null,
    }))
  },
})

/** The orders that belong together: this order, the order it exchanges, and its exchange orders. */
export const orderFamily = internalQuery({
  args: { id: v.id("orders") },
  handler: async (ctx, { id }) => {
    const o = await ctx.db.get(id)
    if (!o) return null
    const lbl = (x: Doc<"orders">) => x.invoiceCode ?? `BB-${x.invoiceNo}`
    const original = o.exchangeOfId ? await ctx.db.get(o.exchangeOfId) : o
    if (!original) return null
    const exchanges = (await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", original.phone)).collect())
      .filter((x) => x.exchangeOfId === original._id && !x.deletedAt)
    const all = [original, ...exchanges]
    const candidates = o.exchangeOfId || exchanges.length ? [] : (await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", o.phone)).collect())
      .filter((x) => x._id !== o._id && !x.deletedAt && x.createdAt < o.createdAt && x.status !== "cancelled")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => ({ id: x._id, label: lbl(x) }))
    return {
      candidates,
      labels: [...new Set(all.map(lbl))],
      original: { id: original._id, label: lbl(original) },
      exchanges: exchanges.map((x) => ({ id: x._id, label: lbl(x), cid: x.consignmentId ?? null, rcid: x.returnConsignmentId ?? null, status: x.status })),
    }
  },
})

/** Mark an order as the exchange of an earlier order (for exchanges copied from Nuport without that link). */
export const setExchangeOf = mutation({
  args: { id: v.id("orders"), originalId: v.id("orders") },
  handler: async (ctx, { id, originalId }) => {
    const me = await requirePerm(ctx, "orders.edit")
    const o = await ctx.db.get(id)
    const orig = await ctx.db.get(originalId)
    if (!o || !orig || id === originalId) throw new ConvexError("Order not found")
    if (orig.phone !== o.phone) throw new ConvexError("The original order is for another customer")
    await ctx.db.patch(id, { isExchange: true, exchangeOfId: originalId, updatedAt: Date.now() })
    await ctx.db.insert("orderEvents", { orderId: id, type: "log", text: `Marked as exchange of ${orig.invoiceCode ?? `BB-${orig.invoiceNo}`}`, byName: me.staff.name, at: Date.now() })
  },
})

export const setExchangeOfInternal = internalMutation({
  args: { id: v.id("orders"), originalId: v.id("orders") },
  handler: async (ctx, { id, originalId }) => {
    const orig = await ctx.db.get(originalId)
    if (!orig) return
    await ctx.db.patch(id, { isExchange: true, exchangeOfId: originalId, updatedAt: Date.now() })
    await ctx.db.insert("orderEvents", { orderId: id, type: "log", text: `Found on Pathao: exchange of ${orig.invoiceCode ?? `BB-${orig.invoiceNo}`}`, byName: "Pathao", at: Date.now() })
  },
})

/** Exchange orders with no Pathao parcel (e.g. copied from Nuport): find the earlier order Pathao booked the
 *  exchange under (it has an EB… or RE… parcel), connect them, and link the parcels. */
export const exchangesWithoutParcel = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("orders").withIndex("by_exchange", (q) => q.eq("isExchange", true)).order("desc").take(600)
    return rows.filter((o) => !o.deletedAt && !o.consignmentId && !["cancelled", "returned", "damaged", "delivered_paid"].includes(o.status)).map((o) => o._id)
  },
})

export const findExchangeParcels = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; linked: string[]; notFound: string[] }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    const ids: Id<"orders">[] = await ctx.runQuery(internal.pathao.exchangesWithoutParcel, {})
    const linked: string[] = [], notFound: string[] = []
    for (const id of ids.slice(0, 40)) {
      try {
        const fam = await ctx.runQuery(internal.pathao.orderFamily, { id })
        if (!fam) continue
        const me = fam.exchanges.find((x: any) => x.id === id)?.label ?? fam.original.label
        let done = false
        if (fam.original.id !== id) { // already connected to its original order
          const r = await parcelGroupInner(ctx, id)
          done = r.linked
        } else {
          for (const c of fam.candidates.slice(0, 4)) {
            const res = await merchantGet(ctx, `${MB}/orders/all?merchant_order_id=${encodeURIComponent(c.label)}&transfer_status=4&archive=0&page=1&limit=20`)
            const list: any[] = res.json?.data?.data ?? []
            const ex = list.map((p) => String(p.order_consignment_id ?? "")).filter((cid) => /^(EB|RE)/.test(cid))
            if (!ex.length) continue
            const used = await ctx.runQuery(internal.pathao.usedConsignments, { ids: ex })
            if (ex.every((cid) => used[cid])) continue
            await ctx.runMutation(internal.pathao.setExchangeOfInternal, { id, originalId: c.id })
            const r = await parcelGroupInner(ctx, id)
            done = r.linked
            break
          }
        }
        ;(done ? linked : notFound).push(me)
      } catch { notFound.push(String(id)) }
    }
    return { checked: Math.min(ids.length, 40), linked, notFound }
  },
})

export const linkExchangeParcels = internalMutation({
  args: { id: v.id("orders"), eb: v.optional(v.string()), re: v.optional(v.string()), replace: v.optional(v.string()) },
  handler: async (ctx, { id, eb, re, replace }) => {
    const o = await ctx.db.get(id)
    if (!o) return
    const patch: Record<string, unknown> = { updatedAt: Date.now() }
    const notes: string[] = []
    if (eb && (!o.consignmentId || o.consignmentId === replace) && !(await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", eb)).first())) {
      Object.assign(patch, { consignmentId: eb, courier: "pathao", courierLinkedBy: "auto", courierError: undefined })
      notes.push(`exchange parcel ${eb}${o.consignmentId ? ` (instead of cancelled ${o.consignmentId})` : ""}`)
    }
    if (re && o.returnConsignmentId !== re) { patch.returnConsignmentId = re; notes.push(`return parcel ${re} (old item coming back)`) }
    if (!notes.length) return
    await ctx.db.patch(id, patch)
    await ctx.db.insert("orderEvents", { orderId: id, type: "log", text: `Linked to Pathao ${notes.join(" and ")} automatically`, byName: "Pathao", at: Date.now() })
  },
})

const parcelKind = (cid: string) => cid.startsWith("EB") ? "Exchange delivery" : cid.startsWith("RE") ? "Return to you (old item)" : cid.startsWith("DB") ? "Delivery" : "Parcel"

/** Every Pathao parcel for this order and its exchange orders (Delivery DB…, Exchange EB…, Return RE…).
 *  Also links an exchange order to its EB/RE parcels when Pathao booked the exchange under the original order number. */
export const parcelGroup = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<{ parcels: any[]; linked: boolean; candidates: { id: Id<"orders">; label: string }[] }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    try { return await parcelGroupInner(ctx, orderId) } catch (e) {
      if (e instanceof ConvexError) throw e
      throw new ConvexError(`Pathao parcels: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
})

async function parcelGroupInner(ctx: any, orderId: Id<"orders">): Promise<{ parcels: any[]; linked: boolean; candidates: { id: Id<"orders">; label: string }[] }> {
  {
    const fam = await ctx.runQuery(internal.pathao.orderFamily, { id: orderId })
    if (!fam) return { parcels: [], linked: false, candidates: [] }
    const seen = new Map<string, any>()
    for (const label of fam.labels) {
      for (const archive of [0, 1]) {
        const res = await merchantGet(ctx, `${MB}/orders/all?merchant_order_id=${encodeURIComponent(label)}&transfer_status=4&archive=${archive}&page=1&limit=20`)
        for (const p of res.json?.data?.data ?? []) {
          const cid = String(p.order_consignment_id ?? "")
          if (!cid || seen.has(cid) || (p.merchant_order_id && p.merchant_order_id !== label)) continue
          seen.set(cid, {
            cid, kind: parcelKind(cid), mid: p.merchant_order_id ?? label, status: p.order_status ?? null,
            cod: Number(p.order_amount) || 0, charge: Number(p.delivery_fee ?? p.order_delivery_fee ?? p.total_fee) || null,
            billing: p.billing_status ?? null, createdAt: utc(p.order_created_at) ?? null, updatedAt: utc(p.updated_at ?? p.order_updated_at) ?? null,
          })
        }
      }
    }
    const parcels = [...seen.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    // Exchange booked on Pathao under the original number: give the EB / RE parcels to our exchange order
    let linked = false
    const used = await ctx.runQuery(internal.pathao.usedConsignments, { ids: parcels.map((p) => p.cid) })
    const freeEB = parcels.filter((p) => p.cid.startsWith("EB") && !used[p.cid] && p.mid === fam.original.label)
    const RE = parcels.filter((p) => p.cid.startsWith("RE") && p.mid === fam.original.label)
    const cancelled = (cid: string | null) => !!cid && /cancel/i.test(String(seen.get(cid)?.status ?? ""))
    const open = fam.exchanges.filter((x) => !x.cid || cancelled(x.cid))
    if (open.length === 1 && freeEB.length <= 1 && RE.length <= 1 && (freeEB.length || (RE.length && !open[0].rcid))) {
      await ctx.runMutation(internal.pathao.linkExchangeParcels, { id: open[0].id, eb: freeEB[0]?.cid, re: RE[0]?.cid, replace: open[0].cid ?? undefined })
      linked = true
    } else if (fam.exchanges.length === 1 && RE.length === 1 && !fam.exchanges[0].rcid) {
      await ctx.runMutation(internal.pathao.linkExchangeParcels, { id: fam.exchanges[0].id, re: RE[0].cid })
      linked = true
    }
    const used2 = linked ? await ctx.runQuery(internal.pathao.usedConsignments, { ids: parcels.map((p) => p.cid) }) : used
    // bring Ops up to date right away for the parcels that belong to our orders (forward moves only)
    for (const p of parcels) {
      const o = await ctx.runQuery(internal.pathao.byConsignment, { consignmentId: p.cid })
      if (!o || !p.status) continue
      await ctx.runMutation(internal.orders.setCourier, { id: o._id, courierStatus: String(p.status) })
      let target = targetFor(String(p.status))
      if (target === "delivered_due" && /paid/i.test(String(p.billing ?? ""))) target = "delivered_paid"
      if (target && PATH.indexOf(target) > PATH.indexOf(o.status as OrderStatus)) await moveTo(ctx, o._id, o.status as OrderStatus, target, `Pathao: ${p.status}`)
    }
    const fam2 = linked ? await ctx.runQuery(internal.pathao.orderFamily, { id: orderId }) : fam
    const reOwner = Object.fromEntries((fam2?.exchanges ?? []).filter((x: any) => x.rcid).map((x: any) => [x.rcid, x.label]))
    return { parcels: parcels.map((p) => ({ ...p, usedBy: used2[p.cid] ?? reOwner[p.cid] ?? null })), linked, candidates: fam.candidates }
  }
}

export const usedConsignments = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const out: Record<string, string> = {}
    for (const id of ids) {
      const o = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", id)).first()
      if (o) out[id] = o.invoiceCode ?? `BB-${o.invoiceNo}`
    }
    return out
  },
})

/** Link an order to a Pathao parcel by hand (when it was booked on Pathao under another order number). */
export const linkParcel = mutation({
  args: { orderId: v.id("orders"), consignmentId: v.string() },
  handler: async (ctx, { orderId, consignmentId }) => {
    const me = await requirePerm(ctx, "courier.book")
    const cid = consignmentId.trim().toUpperCase()
    if (!/^[A-Z]{2}\d{6}[A-Z0-9]{4,}$/.test(cid)) throw new ConvexError("That doesn't look like a Pathao consignment ID")
    const other = await ctx.db.query("orders").withIndex("by_consignment", (q) => q.eq("consignmentId", cid)).first()
    if (other && other._id !== orderId) throw new ConvexError(`Already linked to ${other.invoiceCode ?? `BB-${other.invoiceNo}`}`)
    const o = await ctx.db.get(orderId)
    if (!o) throw new ConvexError("Order not found")
    await ctx.db.patch(orderId, { consignmentId: cid, courier: "pathao", courierLinkedBy: "manual", courierError: undefined, updatedAt: Date.now() })
    await ctx.db.insert("orderEvents", { orderId, type: "log", text: `Linked to Pathao parcel ${cid}${o.consignmentId ? ` (was ${o.consignmentId})` : ""}`, byName: me.staff.name, at: Date.now() })
  },
})

/** Courier payments page: Pathao invoices we've synced, and the sync status. */
export const moneyOverview = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requirePerm(ctx, "orders.view")
    const invoices = await ctx.db.query("pathaoInvoices").withIndex("by_created").order("desc").take(limit ?? 60)
    const sync = await getSetting<any>(ctx, "pathaoMoneySync")
    return { invoices, sync: sync ?? null }
  },
})

export const invoiceOrders = query({
  args: { invoiceId: v.string() },
  handler: async (ctx, { invoiceId }) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("orders").withIndex("by_courier_invoice", (q) => q.eq("courierInvoiceId", invoiceId)).collect()
    return rows.map((o) => ({ _id: o._id, invoice: o.invoiceCode ?? `BB-${o.invoiceNo}`, customer: o.customerName, status: o.status, total: o.total, collected: o.courierCollected ?? null, payout: o.courierPayout ?? null, fee: o.courierCost ?? null, consignmentId: o.consignmentId ?? null }))
  },
})

/** Admin check from the Convex dashboard: raw answer of any Pathao merchant-panel GET path (e.g. "oms/orders/stats?type=dashboard"). */
export const debugGet = internalAction({
  args: { path: v.string() },
  handler: async (ctx, { path }) => {
    const res = await merchantGet(ctx, `${MB}/${path.replace(/^\//, "")}`)
    return { status: res.status, body: JSON.stringify(res.json).slice(0, 6000) }
  },
})

/** Pathao's own delivery outcome for a date range (same numbers as the Pathao merchant dashboard). Cached 15 minutes. */
export const dashboardStats = internalAction({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => {
    const d = (t: number) => new Date(t + 6 * 3600000).toISOString().slice(0, 10)
    const key = `pathaoDash:${d(from)}:${d(to)}`
    const cached = await ctx.runQuery(internal.pathao.getCache, { key })
    if (cached && Date.now() - cached.at < 15 * 60000) return cached.data
    const res = await merchantGet(ctx, `${MB}/oms/orders/stats?type=dashboard&from_date=${d(from)}&to_date=${d(to)}`)
    const x = res.json?.data
    if (!res.ok || !x) return null
    const c = (k: any) => ({ count: Number(k?.count) || 0, amount: Number(k?.amount) || 0, pct: Number(String(k?.percentage ?? "0").replace("%", "")) || 0 })
    const rb = x.return_breakdown ?? {}
    const data = {
      total: c(x.total_orders),
      delivered: c(x.delivered),
      returned: c(x.returned),
      returns: { regular: c(rb.return), paid: c(rb.paid_return), partial: c(rb.partial_delivery), exchange: c(rb.exchange) },
      moving: {
        atDeliveryHub: c(x.at_delivery_hub), assigned: c(x.delivery_assigned), inTransit: c(x.delivery_in_transit), onHold: c(x.delivery_on_hold),
        returnInTransit: c(x.return_in_transit), returnAssigned: c(x.return_assigned), atReturnHub: c(x.at_return_hub),
      },
      cachedAt: x.cached_at ? Date.parse(x.cached_at) : Date.now(),
    }
    await ctx.runMutation(internal.pathao.setCache, { key, data })
    return data
  },
})

export const getCache = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => (await getSetting<any>(ctx, key)) ?? null,
})
export const setCache = internalMutation({
  args: { key: v.string(), data: v.any() },
  handler: async (ctx, { key, data }) => { await setSetting(ctx, key, { data, at: Date.now() }) },
})

// =====================================================================================
// Payment Due check: ask Pathao about every "Delivered · Payment Due" order, one by one
// =====================================================================================
export const dueOrders = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "delivered_due")).take(500)
    return rows
      .filter((o) => !o.deletedAt && o.courier === "pathao" && o.consignmentId && /^D/i.test(o.consignmentId))
      .map((o) => ({ _id: o._id, cid: o.consignmentId!, partnerId: o.deliveryPartnerId ?? null, invoice: o.invoiceCode ?? `BB-${o.invoiceNo}` }))
  },
})

export const markPaidByPathao = internalMutation({
  args: { id: v.id("orders"), invoiceId: v.optional(v.string()) },
  handler: async (ctx, { id, invoiceId }) => {
    const o = await ctx.db.get(id)
    if (!o) return
    const patch: Partial<Doc<"orders">> = {}
    if (!o.courierPaid) { patch.courierPaid = true; patch.courierPaidAt = Date.now() }
    if (invoiceId && o.courierInvoiceId !== invoiceId) patch.courierInvoiceId = invoiceId
    if (Object.keys(patch).length) await ctx.db.patch(id, patch)
  },
})

export const checkDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; paid: string[]; returned: string[]; failed: number }> => {
    const rows: { _id: Id<"orders">; cid: string; partnerId: Id<"deliveryPartners"> | null; invoice: string }[] = await ctx.runQuery(internal.pathao.dueOrders, {})
    const paid: string[] = [], returned: string[] = []
    let failed = 0
    const one = async (r: (typeof rows)[number]) => {
      try {
        let res = await merchantGet(ctx, `${MB}/orders/${encodeURIComponent(r.cid)}?archive=0`, r.partnerId)
        let d = res.json?.data?.data ?? res.json?.data
        if (!res.ok || !d || typeof d !== "object") {
          res = await merchantGet(ctx, `${MB}/orders/${encodeURIComponent(r.cid)}?archive=1`, r.partnerId)
          d = res.json?.data?.data ?? res.json?.data
        }
        if (!res.ok || !d || typeof d !== "object") { failed++; return }
        const billing = String(d.billing_status ?? d.payment_status ?? d.invoice_status ?? "")
        const status = String(d.order_status_slug ?? d.order_status ?? "")
        const invoiceId = d.order_invoice_id ?? d.invoice_id
        if (/^paid$/i.test(billing)) {
          await ctx.runMutation(internal.pathao.markPaidByPathao, { id: r._id, invoiceId: invoiceId ? String(invoiceId) : undefined })
          if (await moveTo(ctx, r._id, "delivered_due", "delivered_paid", `Pathao: payment ${billing}${invoiceId ? ` (invoice ${invoiceId})` : ""}`)) paid.push(r.invoice)
        } else if (status && targetFor(status) === "pending_returned") {
          await ctx.runMutation(internal.orders.setCourier, { id: r._id, courierStatus: status })
          if (await moveTo(ctx, r._id, "delivered_due", "pending_returned", `Pathao: ${status}`)) returned.push(r.invoice)
        }
      } catch {
        failed++
      }
    }
    for (let i = 0; i < rows.length; i += 6) await Promise.all(rows.slice(i, i + 6).map(one))
    if (paid.length || returned.length) console.log("Payment Due check", { paid, returned })
    return { checked: rows.length, paid, returned, failed }
  },
})

/** Button on Delivered → Payment Due: check them all with Pathao now. */
export const checkDueNow = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; paid: string[]; returned: string[]; failed: number }> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "orders.view" })
    return await ctx.runAction(internal.pathao.checkDue, {})
  },
})

/** Timer entry for the Pathao checks. Paused 11 pm – 8 am Bangladesh time: Pathao does no work then. */
export const cronTick = internalAction({
  args: { job: v.union(v.literal("status"), v.literal("money"), v.literal("due")) },
  handler: async (ctx, { job }): Promise<void> => {
    const hourBD = new Date(Date.now() + 6 * 3600000).getUTCHours()
    if (hourBD >= 23 || hourBD < 8) return
    if (job === "status") await ctx.runAction(internal.pathao.syncAll, {})
    else if (job === "money") await ctx.runAction(internal.pathao.syncMoney, {})
    else await ctx.runAction(internal.pathao.checkDue, {})
  },
})
