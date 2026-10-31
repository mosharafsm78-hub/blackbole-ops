// Discount codes for the website (like Shopify Admin → Discounts). Edited on the Discounts page; the website reads
// GET /website/discounts (X-Feed-Key = MARKETING_FEED_KEY, cached ~60 s there), so changes work without a rebuild.
// Percent is stored as a whole number (10 = 10 %); the feed sends it as a fraction (0.1) — the website's format.
import { v, ConvexError } from "convex/values"
import { httpAction, internalQuery, query, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff } from "./lib"
import { hasPerm, normalizePhone } from "./rules"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")

async function requireManage(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

// ---------------- pure helpers (tested) ----------------
export const normCode = (c: string) => c.trim().replace(/\s+/g, " ").toUpperCase()

export type Scope = "all" | "collections" | "products"
/** Shopify's four discount types. Products & Buy X get Y are "product discounts" for combinations. */
export type Kind = "products" | "order" | "bxgy" | "shipping"
export type Group = "products" | "order" | "shipping"
export type Combines = { products?: boolean; order?: boolean; shipping?: boolean }

export type DiscountInput = {
  code: string; title?: string; type: "percent" | "amount"; value: number; scope: Scope; items: string[]
  minSubtotal?: number | null; onlineOnly?: boolean; startsAt?: number | null; endsAt?: number | null
  usageLimit?: number | null; oncePerCustomer?: boolean; active: boolean
  method?: "code" | "automatic"; kind?: Kind; minQty?: number | null; combines?: Combines | null
  buyQty?: number | null; buyScope?: Scope; buyItems?: string[]; getQty?: number | null; maxUses?: number | null
}

/** Older rows have no kind: "all" was an order discount, a list of collections/products a product discount (same as the website). */
export const kindOf = (d: { kind?: Kind; scope: Scope }): Kind => d.kind ?? (d.scope === "all" ? "order" : "products")
export const groupOf = (k: Kind): Group => (k === "bxgy" ? "products" : k)
export const KIND_LABEL: Record<Kind, string> = { products: "Amount off products", order: "Amount off order", bxgy: "Buy X get Y", shipping: "Free shipping" }

const cleanItems = (xs?: string[]) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))]
const needItems = (scope: Scope, items: string[], who = "") => {
  if (scope !== "all" && !items.length) throw new ConvexError(scope === "collections" ? `Choose at least one collection${who}` : `Choose at least one product${who}`)
}

/** Checks a discount before saving; returns the cleaned row (throws a plain-English error). */
export function validateDiscount(d: DiscountInput) {
  const method = d.method === "automatic" ? "automatic" : "code"
  const kind: Kind = d.kind ?? kindOf(d)
  const title = d.title?.trim() || undefined
  let code: string
  if (method === "automatic") {
    if (!title) throw new ConvexError("Enter a title for the automatic discount (shoppers see it at checkout)")
    if (title.length > 60) throw new ConvexError("The title is too long (60 characters at most)")
    code = normCode(d.code) || autoCode()
    if (!code.startsWith("AUTO-")) code = autoCode()
  } else {
    code = normCode(d.code)
    if (!code) throw new ConvexError("Enter a discount code")
    if (code.startsWith("AUTO-")) throw new ConvexError("Codes can't start with AUTO- (that's kept for automatic discounts)")
  }
  if (code.length > 40) throw new ConvexError("The code is too long (40 characters at most)")
  if (!/^[A-Z0-9 _%-]+$/.test(code)) throw new ConvexError("Codes can use letters, numbers, spaces and - _ % only")

  let type = d.type
  let value = Number(d.value)
  if (kind === "shipping") { type = "percent"; value = 100 }
  if (type === "percent" && !(value >= 1 && value <= 100)) throw new ConvexError("A percentage must be between 1 and 100")
  if (type === "amount" && !(value > 0)) throw new ConvexError("Enter an amount above ৳0")

  // what it applies to: order & free shipping = the whole order; products = a list; Buy X get Y = the "gets" list
  const scope: Scope = kind === "order" || kind === "shipping" ? "all" : d.scope
  const items = scope === "all" ? [] : cleanItems(d.items)
  needItems(scope, items, kind === "bxgy" ? " the customer gets" : "")

  const pos = (n?: number | null) => (n != null && Number(n) > 0 ? Math.round(Number(n)) : undefined)
  const minSubtotal = kind === "bxgy" ? undefined : pos(d.minSubtotal)
  const minQty = kind === "bxgy" ? undefined : pos(d.minQty)
  if (minSubtotal && minQty) throw new ConvexError("Choose either a minimum amount or a minimum number of items, not both")

  let bx: { buyQty?: number; buyScope?: Scope; buyItems?: string[]; getQty?: number; maxUses?: number } = {}
  if (kind === "bxgy") {
    const buyQty = pos(d.buyQty), getQty = pos(d.getQty)
    if (!buyQty) throw new ConvexError("Enter how many items the customer buys")
    if (!getQty) throw new ConvexError("Enter how many items the customer gets")
    if (buyQty > 50 || getQty > 50) throw new ConvexError("Use 50 items or fewer")
    const buyScope = d.buyScope ?? "all"
    const buyItems = buyScope === "all" ? [] : cleanItems(d.buyItems)
    needItems(buyScope, buyItems, " the customer buys")
    bx = { buyQty, buyScope, buyItems, getQty, maxUses: pos(d.maxUses) }
  }

  const startsAt = d.startsAt ?? undefined, endsAt = d.endsAt ?? undefined
  if (startsAt && endsAt && endsAt <= startsAt) throw new ConvexError("The end date must be after the start date")
  // combinations: only with the other two groups (one discount of each group per order)
  const g = groupOf(kind)
  const c = d.combines ?? {}
  const combines: Combines = {}
  for (const k of ["products", "order", "shipping"] as const) if (k !== g && c[k]) combines[k] = true
  return {
    code, title, type, value: type === "percent" ? Math.round(value * 100) / 100 : Math.round(value),
    scope, items, minSubtotal, onlineOnly: d.onlineOnly || undefined,
    startsAt, endsAt,
    // Shopify: automatic discounts have no usage limits (there's no code to count per customer)
    usageLimit: method === "automatic" ? undefined : pos(d.usageLimit), oncePerCustomer: method === "automatic" ? undefined : d.oncePerCustomer || undefined,
    active: d.active,
    method: method === "automatic" ? ("automatic" as const) : undefined,
    kind: d.kind || kind !== kindOf({ scope }) ? kind : undefined,
    minQty, combines: Object.keys(combines).length ? combines : undefined, ...bx,
  }
}

function autoCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return "AUTO-" + Array.from({ length: 8 }, () => a[Math.floor(Math.random() * a.length)]).join("")
}

export type DiscountStatus = "active" | "scheduled" | "expired" | "off" | "used_up"
export function statusOf(d: Pick<Doc<"discounts">, "active" | "startsAt" | "endsAt" | "usageLimit" | "usedCount">, now = Date.now()): DiscountStatus {
  if (!d.active) return "off"
  if (d.endsAt && d.endsAt <= now) return "expired"
  if (d.startsAt && d.startsAt > now) return "scheduled"
  if (d.usageLimit && (d.usedCount ?? 0) >= d.usageLimit) return "used_up"
  return "active"
}

/** The website's format (src/data/discounts.json + server/promo.js in blackbole-storefront). */
export function toFeed(d: Doc<"discounts">) {
  const kind = kindOf(d)
  return {
    code: d.code, type: d.type, value: d.type === "percent" ? d.value / 100 : d.value, scope: d.scope, items: d.items,
    ...(d.minSubtotal ? { minSubtotal: d.minSubtotal } : {}), ...(d.onlineOnly ? { onlineOnly: true } : {}),
    ...(d.usageLimit ? { usageLimit: d.usageLimit } : {}), used: d.usedCount ?? 0, ...(d.oncePerCustomer ? { oncePerCustomer: true } : {}),
    ...(kind !== kindOf({ scope: d.scope }) ? { kind } : {}),
    ...(d.method === "automatic" ? { automatic: true, title: d.title ?? "" } : {}),
    ...(d.minQty ? { minQty: d.minQty } : {}),
    ...(d.combines && Object.values(d.combines).some(Boolean) ? { combines: d.combines } : {}),
    ...(kind === "bxgy" ? { buyQty: d.buyQty, buyScope: d.buyScope ?? "all", buyItems: d.buyItems ?? [], getQty: d.getQty, ...(d.maxUses ? { maxUses: d.maxUses } : {}) } : {}),
  }
}

/** Website versions from before automatic discounts only read `codes` and would treat new kinds as plain codes,
 *  so those go in `extra` (which only the newer website reads). */
export const legacySafe = (d: Doc<"discounts">) => d.method !== "automatic" && (kindOf(d) === "products" || kindOf(d) === "order") && !d.minQty

// ---------------- queries ----------------
export const list = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const rows = await ctx.db.query("discounts").collect()
    const now = Date.now()
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map((d) => ({ ...d, status: statusOf(d, now) }))
  },
})

export const get = query({
  args: { id: v.id("discounts") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    return await ctx.db.get(id)
  },
})

// ---------------- edits ----------------
const inputV = {
  code: v.string(), title: v.optional(v.string()), type: v.union(v.literal("percent"), v.literal("amount")), value: v.number(),
  scope: v.union(v.literal("all"), v.literal("collections"), v.literal("products")), items: v.array(v.string()),
  minSubtotal: v.optional(v.union(v.number(), v.null())), onlineOnly: v.optional(v.boolean()),
  startsAt: v.optional(v.union(v.number(), v.null())), endsAt: v.optional(v.union(v.number(), v.null())),
  usageLimit: v.optional(v.union(v.number(), v.null())), oncePerCustomer: v.optional(v.boolean()), active: v.boolean(),
  method: v.optional(v.union(v.literal("code"), v.literal("automatic"))),
  kind: v.optional(v.union(v.literal("products"), v.literal("order"), v.literal("bxgy"), v.literal("shipping"))),
  minQty: v.optional(v.union(v.number(), v.null())),
  combines: v.optional(v.union(v.null(), v.object({ products: v.optional(v.boolean()), order: v.optional(v.boolean()), shipping: v.optional(v.boolean()) }))),
  buyQty: v.optional(v.union(v.number(), v.null())), buyScope: v.optional(v.union(v.literal("all"), v.literal("collections"), v.literal("products"))),
  buyItems: v.optional(v.array(v.string())), getQty: v.optional(v.union(v.number(), v.null())), maxUses: v.optional(v.union(v.number(), v.null())),
}

export const save = mutation({
  args: { id: v.optional(v.id("discounts")), ...inputV },
  handler: async (ctx, { id, ...a }) => {
    await requireManage(ctx)
    const row = validateDiscount(a)
    const clash = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", row.code)).first()
    if (clash && clash._id !== id) {
      if (row.method === "automatic") throw new ConvexError("Please try saving again")
      throw new ConvexError(`The code ${row.code} already exists`)
    }
    const now = Date.now()
    if (id) {
      const cur = await ctx.db.get(id)
      if (!cur) throw new ConvexError("Discount not found")
      await ctx.db.replace(id, { ...row, usedCount: cur.usedCount, createdAt: cur.createdAt, updatedAt: now })
      return id
    }
    return await ctx.db.insert("discounts", { ...row, usedCount: 0, createdAt: now, updatedAt: now })
  },
})

export const setActive = mutation({
  args: { id: v.id("discounts"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    await requireManage(ctx)
    await ctx.db.patch(id, { active, updatedAt: Date.now() })
  },
})

export const remove = mutation({
  args: { id: v.id("discounts") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    await ctx.db.delete(id)
  },
})

/** The codes that were live on Shopify (blackbole-storefront src/data/discounts.json; percent there is 0–1). */
const SHOPIFY_CODES: { code: string; type: "percent" | "amount"; value: number; scope: "all" | "collections" | "products"; items?: string[]; minSubtotal?: number; onlineOnly?: boolean }[] = [
  { code: "ADVANCE5", type: "percent", value: 0.05, scope: "collections", items: ["ready-to-ship-advance5"], onlineOnly: true },
  { code: "BBFAMILY5", type: "percent", value: 0.05, scope: "all" },
  { code: "BLACKBOLE150", type: "amount", value: 150, scope: "all", minSubtotal: 1500 },
  { code: "FIFA150", type: "amount", value: 150, scope: "all", minSubtotal: 2000 },
  { code: "BLACKBOLE20%WP", type: "percent", value: 0.2, scope: "all" },
  { code: "BLACKBOLERCVR", type: "percent", value: 0.1, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
  { code: "RAMADAN4U", type: "percent", value: 0.05, scope: "products", items: ["mens-leather-sandal-blackbole-edition-1016", "blackbole-bob-leather-sandal-1018-brown", "blackbole-bob-leather-sandal-1018-black", "hand-made-vinda-pakistani-style-chappal-blackbole-edition-1020"] },
  { code: "THANKS FOR 1ST ORDER", type: "percent", value: 0.1, scope: "products", items: ["chunky-loafer-black-edition"] },
  { code: "SHIMMERNEXT", type: "amount", value: 100, scope: "all" },
  { code: "RUMON", type: "percent", value: 0.05, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
  { code: "GKS5", type: "percent", value: 0.05, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
  { code: "ULTQKF1FQ8", type: "percent", value: 0.05, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
  { code: "90BG84ILQX", type: "percent", value: 0.05, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
  { code: "UP24UB91EO", type: "percent", value: 0.05, scope: "collections", items: ["watch", "sandals", "blackbole-edition", "ladies-sandal", "boot", "sneakers"] },
]

/** One-time: bring in the Shopify codes (only when there are no discounts yet). */
export const importShopifyCodes = mutation({
  args: {},
  handler: async (ctx) => {
    await requireManage(ctx)
    if (await ctx.db.query("discounts").first()) throw new ConvexError("Discounts already exist, so nothing was imported")
    const now = Date.now()
    for (const c of SHOPIFY_CODES) {
      const row = validateDiscount({ ...c, items: c.items ?? [], value: c.type === "percent" ? c.value * 100 : c.value, active: true })
      await ctx.db.insert("discounts", { ...row, usedCount: 0, createdAt: now, updatedAt: now })
    }
    return SHOPIFY_CODES.length
  },
})

// ---------------- usage (called when an order arrives) ----------------
export async function recordUse(ctx: { db: any }, rawCode: string | undefined | null) {
  if (!rawCode) return
  const code = normCode(String(rawCode))
  const d: Doc<"discounts"> | null = await ctx.db.query("discounts").withIndex("by_code", (q: any) => q.eq("code", code)).first()
  if (d) await ctx.db.patch(d._id, { usedCount: (d.usedCount ?? 0) + 1 })
}

/** Automatic discounts on a website order (body.automatic_discounts: their AUTO-… ids): counted in "Used". */
export async function recordAutomaticUses(ctx: { db: any }, raw: unknown) {
  if (!Array.isArray(raw)) return
  for (const c of [...new Set(raw.slice(0, 5).map((x) => normCode(String(x))))]) if (c.startsWith("AUTO-")) await recordUse(ctx, c)
}

// ---------------- Marketing OS (clearance ads) ----------------
/** Marketing OS's AI Brain runs a clearance ad: the same code, re-pointed at today's low-stock products, for `days`
 *  days. A product-scoped code discount, so every website version honours it. Upserts by code. */
export const upsertMarketing = internalMutation({
  args: { code: v.string(), title: v.string(), percent: v.number(), handles: v.array(v.string()), days: v.number() },
  handler: async (ctx, a) => {
    const now = Date.now()
    const row = validateDiscount({ code: a.code, title: a.title, type: "percent", value: a.percent, scope: "products", items: a.handles, active: true, endsAt: now + Math.max(1, Math.min(30, a.days)) * 86400000, kind: "products" } as DiscountInput)
    const cur = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", row.code)).first()
    if (cur) { await ctx.db.replace(cur._id, { ...row, usedCount: cur.usedCount, createdAt: cur.createdAt, updatedAt: now }); return { id: cur._id, code: row.code, endsAt: row.endsAt } }
    const id = await ctx.db.insert("discounts", { ...row, usedCount: 0, createdAt: now, updatedAt: now })
    return { id, code: row.code, endsAt: row.endsAt }
  },
})

// ---------------- website feed ----------------
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const feedOk = (req: Request) => { const key = process.env.MARKETING_FEED_KEY; return !!key && key.length >= 24 && req.headers.get("X-Feed-Key") === key }

export const feedData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query("discounts").collect()
    const live = rows.filter((d) => statusOf(d, now) === "active" || statusOf(d, now) === "used_up")
    return { codes: live.filter(legacySafe).map(toFeed), extra: live.filter((d) => !legacySafe(d)).map(toFeed), total: rows.length, at: now }
  },
})

export const feedHttp = httpAction(async (ctx, req) => {
  if (!feedOk(req)) return json({ error: "Invalid feed key" }, 401)
  return json(await ctx.runQuery(internal.discounts.feedData, {}))
})

/** One-per-customer check: has this phone already ordered with this code (cancelled orders don't count)? */
export const checkData = internalQuery({
  args: { code: v.string(), phone: v.string() },
  handler: async (ctx, { code, phone }) => {
    const c = normCode(code)
    const d = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", c)).first()
    if (!d || d.method === "automatic") return { ok: false, reason: "This code is not valid." }
    const st = statusOf(d)
    if (st === "used_up") return { ok: false, reason: "This code has been used up." }
    if (st !== "active") return { ok: false, reason: "This code is not active right now." }
    if (d.oncePerCustomer && phone) {
      const prev = await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", phone)).collect()
      if (prev.some((o) => !o.deletedAt && o.status !== "cancelled" && normCode(o.discountCode ?? "") === c)) return { ok: false, reason: "You have already used this code." }
    }
    return { ok: true, reason: null }
  },
})

export const checkHttp = httpAction(async (ctx, req) => {
  if (!feedOk(req)) return json({ error: "Invalid feed key" }, 401)
  const u = new URL(req.url)
  const phone = normalizePhone(u.searchParams.get("phone") ?? "")
  return json(await ctx.runQuery(internal.discounts.checkData, { code: u.searchParams.get("code") ?? "", phone }))
})

export type DiscountId = Id<"discounts">
