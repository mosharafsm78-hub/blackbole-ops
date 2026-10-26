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

export type DiscountInput = {
  code: string; title?: string; type: "percent" | "amount"; value: number; scope: "all" | "collections" | "products"; items: string[]
  minSubtotal?: number | null; onlineOnly?: boolean; startsAt?: number | null; endsAt?: number | null
  usageLimit?: number | null; oncePerCustomer?: boolean; active: boolean
}

/** Checks a discount before saving; returns the cleaned row (throws a plain-English error). */
export function validateDiscount(d: DiscountInput) {
  const code = normCode(d.code)
  if (!code) throw new ConvexError("Enter a discount code")
  if (code.length > 40) throw new ConvexError("The code is too long (40 characters at most)")
  if (!/^[A-Z0-9 _%-]+$/.test(code)) throw new ConvexError("Codes can use letters, numbers, spaces and - _ % only")
  const value = Number(d.value)
  if (d.type === "percent" && !(value >= 1 && value <= 100)) throw new ConvexError("A percentage must be between 1 and 100")
  if (d.type === "amount" && !(value > 0)) throw new ConvexError("Enter an amount above ৳0")
  const items = [...new Set((d.items ?? []).map((x) => x.trim()).filter(Boolean))]
  if (d.scope !== "all" && !items.length) throw new ConvexError(d.scope === "collections" ? "Choose at least one collection" : "Choose at least one product")
  const pos = (n?: number | null) => (n != null && Number(n) > 0 ? Math.round(Number(n)) : undefined)
  const startsAt = d.startsAt ?? undefined, endsAt = d.endsAt ?? undefined
  if (startsAt && endsAt && endsAt <= startsAt) throw new ConvexError("The end date must be after the start date")
  return {
    code, title: d.title?.trim() || undefined, type: d.type, value: d.type === "percent" ? Math.round(value * 100) / 100 : Math.round(value),
    scope: d.scope, items: d.scope === "all" ? [] : items, minSubtotal: pos(d.minSubtotal), onlineOnly: d.onlineOnly || undefined,
    startsAt, endsAt, usageLimit: pos(d.usageLimit), oncePerCustomer: d.oncePerCustomer || undefined, active: d.active,
  }
}

export type DiscountStatus = "active" | "scheduled" | "expired" | "off" | "used_up"
export function statusOf(d: Pick<Doc<"discounts">, "active" | "startsAt" | "endsAt" | "usageLimit" | "usedCount">, now = Date.now()): DiscountStatus {
  if (!d.active) return "off"
  if (d.endsAt && d.endsAt <= now) return "expired"
  if (d.startsAt && d.startsAt > now) return "scheduled"
  if (d.usageLimit && (d.usedCount ?? 0) >= d.usageLimit) return "used_up"
  return "active"
}

/** The website's format (src/data/discounts.json in blackbole-storefront). */
export function toFeed(d: Doc<"discounts">) {
  return {
    code: d.code, type: d.type, value: d.type === "percent" ? d.value / 100 : d.value, scope: d.scope, items: d.items,
    ...(d.minSubtotal ? { minSubtotal: d.minSubtotal } : {}), ...(d.onlineOnly ? { onlineOnly: true } : {}),
    ...(d.usageLimit ? { usageLimit: d.usageLimit } : {}), used: d.usedCount ?? 0, ...(d.oncePerCustomer ? { oncePerCustomer: true } : {}),
  }
}

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
}

export const save = mutation({
  args: { id: v.optional(v.id("discounts")), ...inputV },
  handler: async (ctx, { id, ...a }) => {
    await requireManage(ctx)
    const row = validateDiscount(a)
    const clash = await ctx.db.query("discounts").withIndex("by_code", (q) => q.eq("code", row.code)).first()
    if (clash && clash._id !== id) throw new ConvexError(`The code ${row.code} already exists`)
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

// ---------------- website feed ----------------
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const feedOk = (req: Request) => { const key = process.env.MARKETING_FEED_KEY; return !!key && key.length >= 24 && req.headers.get("X-Feed-Key") === key }

export const feedData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query("discounts").collect()
    return { codes: rows.filter((d) => statusOf(d, now) === "active" || statusOf(d, now) === "used_up").map(toFeed), total: rows.length, at: now }
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
    if (!d) return { ok: false, reason: "This code is not valid." }
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
