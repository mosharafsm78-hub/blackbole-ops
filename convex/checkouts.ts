import { v, ConvexError } from "convex/values"
import { httpAction, internalQuery, query } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation, mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { orderItem } from "./schema"
import { computePurchaseCost, currentStaff, logOrder, moveOrderStock, requirePerm } from "./lib"
import { STATUS_BUCKET, normalizePhone, type OrderStatus } from "./rules"
import { insertOrder } from "./orders"
import { awardPoints } from "./kpi"

/** A checkout counts as abandoned once nothing has happened on it for this long. */
export const ABANDON_AFTER = 15 * 60000

// ---------- from Shopify ----------
export const upsertFromShopify = internalMutation({
  args: {
    checkoutId: v.string(), kind: v.optional(v.string()), shopName: v.optional(v.string()), token: v.optional(v.string()), customerName: v.string(), phone: v.string(), email: v.optional(v.string()),
    address: v.string(), cityName: v.optional(v.string()), items: v.array(orderItem), subtotal: v.number(), discount: v.number(),
    deliveryFee: v.number(), total: v.number(), recoveryUrl: v.optional(v.string()), shopCreatedAt: v.number(), shopUpdatedAt: v.number(),
    completed: v.boolean(),
  },
  handler: async (ctx, args) => upsertCart(ctx, args),
})

async function upsertCart(ctx: any, { completed, ...a }: any) {
    const phone = /^01\d{9}$/.test(normalizePhone(a.phone)) ? normalizePhone(a.phone) : ""
    const old = await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", a.checkoutId)).first()
    if (old) {
      if (old.status === "converted" || old.status === "ordered") return
      // An archived cart stays archived: a later Shopify sync must not silently resurrect a record the team
      // deliberately hid (duplicate / invalid entry). Restoring is an explicit action in the queue.
      if (old.isArchived) return
      await ctx.db.patch(old._id, { ...a, phone: phone || old.phone, items: a.items.length ? a.items : old.items, ...(completed ? { status: "ordered", closedAt: Date.now() } : {}) })
      return
    }
    if (completed) return
    await ctx.db.insert("checkouts", { ...a, phone, status: "open", callCount: 0 })
}

const cartRow = v.object({
  checkoutId: v.string(), kind: v.optional(v.string()), shopName: v.optional(v.string()), token: v.optional(v.string()), customerName: v.string(),
  phone: v.string(), email: v.optional(v.string()), address: v.string(), cityName: v.optional(v.string()),
  items: v.array(v.object({ sku: v.string(), name: v.string(), attrs: v.optional(v.string()), price: v.number(), qty: v.number(), discount: v.number() })),
  subtotal: v.number(), discount: v.number(), deliveryFee: v.number(), total: v.number(), recoveryUrl: v.optional(v.string()),
  shopCreatedAt: v.number(), shopUpdatedAt: v.number(), completed: v.boolean(),
})

/** Admin: bring in older abandoned checkouts / draft orders read from Shopify (skips ones already here). */
export const importMany = mutation({
  args: { rows: v.array(cartRow) },
  handler: async (ctx, { rows }) => {
    await requirePerm(ctx, "team.manage")
    let added = 0, skipped = 0
    for (const r of rows) {
      const old = await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", r.checkoutId)).first()
      if (old) { skipped++; continue }
      const items: Doc<"checkouts">["items"] = []
      for (const i of r.items) {
        const vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", i.sku.toUpperCase())).first()
        const p = vr ? await ctx.db.get(vr.productId) : null
        items.push({ variantId: vr?._id, sku: i.sku.toUpperCase(), name: p?.name ?? i.name, attrs: vr?.title ?? i.attrs, imageUrl: p?.imageUrl, price: i.price, qty: i.qty, discount: i.discount, weightKg: vr?.weightKg ?? 0.5 })
      }
      await upsertCart(ctx, { ...r, items })
      added++
    }
    return { added, skipped }
  },
})

/** A real order came in from the website: its checkout is no longer abandoned. */
export const markOrdered = internalMutation({
  args: { token: v.optional(v.string()), checkoutId: v.optional(v.string()), externalId: v.string() },
  handler: async (ctx, { token, checkoutId, externalId }) => {
    const c = (checkoutId ? await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", checkoutId)).first() : null)
      ?? (token ? await ctx.db.query("checkouts").withIndex("by_token", (q) => q.eq("token", token)).first() : null)
    if (!c || c.status === "converted") return
    const order = await ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", externalId)).first()
    await ctx.db.patch(c._id, { status: "ordered", orderId: order?._id ?? c.orderId, closedAt: Date.now() })
  },
})

// ---------- list ----------
// ---------- COD form leads (website "Cash on delivery" popup) ----------
// The popup sends the customer's number as soon as a valid one is typed, so people who leave without
// pressing "Confirm order" still show up in Abandoned carts. One lead per phone; a real order closes it.
const leadItem = v.object({ id: v.optional(v.number()), sku: v.optional(v.string()), qty: v.number(), price: v.number(), title: v.string(), variant: v.optional(v.string()) })

/** Old products were kept with "-DELETED" SKUs; never link to those. */
const liveVariant = (v: Doc<"variants">) => v.active !== false && !/-DELETED$/i.test(v.sku)
// name matching (Shopify orders, website import) never picks a WEB-… placeholder size made by the website import
const nameMatchable = (v: Doc<"variants">) => liveVariant(v) && !/^WEB-/i.test(v.sku)

const norm = (t: string) => t.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()

/** Find our product size from a name + size text (e.g. "BlackBole Harbor Shore Sandal For Men - Black", "EU 43").
 *  Many products have near-identical names (Brown / Black / Combo…), so look through enough search hits
 *  and accept only an exact name match (ignoring case, spaces and punctuation), or name + colour in the size. */
export async function matchByName(ctx: { db: any }, title: string, variant?: string): Promise<Doc<"variants"> | null> {
  const want = norm(title)
  const size = norm((variant ?? "").replace(/eu\s*/gi, ""))
  if (!want) return null
  const hits: Doc<"products">[] = await ctx.db.query("products").withSearchIndex("search_name", (q: any) => q.search("name", title)).take(25)
  // First and most exact: product name + size name together use the same words as the order line
  // (e.g. Shopify "Brinkley Breeze Sandal for Men" + "Khaki Green / 39" = our "Brinkley Breeze Sandal for Men - Khaki Green" + "39")
  const all = norm(`${title} ${variant ?? ""}`.replace(/\beu\b/gi, "")).split(" ").filter(Boolean).sort().join(" ")
  for (const p of hits) {
    if (p.deletedAt || p.active === false) continue
    const vars: Doc<"variants">[] = (await ctx.db.query("variants").withIndex("by_product", (q: any) => q.eq("productId", p._id)).collect()).filter(nameMatchable)
    const hit = vars.find((x) => norm(`${p.name} ${x.title}`).split(" ").filter(Boolean).sort().join(" ") === all)
    if (hit) return hit
  }
  for (const exact of [true, false]) {
    for (const p of hits) {
      if (p.deletedAt || p.active === false) continue
      const pn = norm(p.name)
      // second pass: product named without the colour, colour sits in the size ("Black / 43")
      const extra = exact ? "" : want.startsWith(pn + " ") ? want.slice(pn.length + 1) : null
      if (exact ? pn !== want : extra === null) continue
      const vars: Doc<"variants">[] = (await ctx.db.query("variants").withIndex("by_product", (q: any) => q.eq("productId", p._id)).collect()).filter(nameMatchable)
      const target = norm(`${extra ?? ""} ${size}`)
      const tw = target.split(" ").filter(Boolean)
      const found = vars.find((x) => norm(x.title) === target)
        ?? (exact
          ? vars.find((x) => tw.length && norm(x.title).split(" ").every((w) => tw.includes(w)))
          : vars.find((x) => tw.length && tw.every((w) => norm(x.title).split(" ").includes(w)))) // colour must be in the size name
        ?? (exact && vars.length === 1 && !size ? vars[0] : null)
      if (found) return found
    }
  }
  return null
}

/** Shopify order lines without a SKU: find our product by name + size. */
export const variantsByName = internalQuery({
  args: { lines: v.array(v.object({ key: v.string(), title: v.string(), variant: v.optional(v.string()) })) },
  handler: async (ctx, { lines }) => {
    const out: Record<string, { variantId: string; sku: string; weightKg: number; imageUrl?: string; name: string; title: string }> = {}
    for (const l of lines) {
      const vr = await matchByName(ctx, l.title, l.variant)
      if (!vr) continue
      const p = await ctx.db.get(vr.productId)
      out[l.key] = { variantId: vr._id, sku: vr.sku, weightKg: vr.weightKg, imageUrl: p?.imageUrl, name: p?.name ?? vr.sku, title: vr.title }
    }
    return out
  },
})

/** Link order/cart lines that have no product yet (by name + size). */
export async function linkItems<T extends { variantId?: any; sku: string; name: string; attrs?: string; weightKg: number; imageUrl?: string }>(ctx: { db: any }, items: T[]): Promise<{ items: T[]; linked: number }> {
  let linked = 0
  const out: T[] = []
  for (const i of items) {
    if (i.variantId) {
      const cur = await ctx.db.get(i.variantId)
      if (cur && liveVariant(cur)) { out.push(i); continue }
    }
    const vr = await matchByName(ctx, i.name.split(" · ")[0], i.attrs)
    if (!vr) { out.push(i); continue }
    const p = await ctx.db.get(vr.productId)
    linked++
    out.push({ ...i, variantId: vr._id, sku: vr.sku, name: p?.name ?? i.name, attrs: vr.title, weightKg: vr.weightKg, imageUrl: i.imageUrl ?? p?.imageUrl })
  }
  return { items: out, linked }
}

/** One-time / repair: link unlinked lines on open orders and carts, moving reserved stock where needed. */
export const relinkOpen = internalMutation({
  args: {},
  handler: async (ctx) => {
    const fixed: string[] = []
    for (const st of ["pending", "on_hold", "approved", "processing", "ready_to_ship", "pre_order", "pre_order_bd"] as const) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()) {
        if (o.deletedAt || o.consignmentId) continue
        const { items, linked } = await linkItems(ctx, o.items)
        if (!linked) continue
        const reserved = STATUS_BUCKET[o.status as OrderStatus] !== "available"
        if (reserved) await moveOrderStock(ctx, o, o.status as OrderStatus, "pending", "System")
        await ctx.db.patch(o._id, { items, itemCount: items.reduce((t, i) => t + i.qty, 0), purchaseCost: await computePurchaseCost(ctx, items) })
        const fresh = (await ctx.db.get(o._id))!
        if (reserved) await moveOrderStock(ctx, fresh, "pending", o.status as OrderStatus, "System")
        await logOrder(ctx, o._id, `Product linked automatically (${linked} line${linked > 1 ? "s" : ""}) — stock now tracked`, "System")
        fixed.push(o.invoiceCode ?? `BB-${o.invoiceNo}`)
      }
    }
    for (const c of await ctx.db.query("checkouts").collect()) {
      const { items, linked } = await linkItems(ctx, c.items)
      if (linked) await ctx.db.patch(c._id, { items })
    }
    return fixed
  },
})

/** Recovery link for a website lead, like Shopify's abandoned-checkout link: opens the website bag on any phone with
 *  the same products and quantities (/cart?add=VARIANT:QTY,...). null when the lead has no website variant ids. */
export function cartLink(url: string | undefined, items: { id?: number; qty: number }[]): string | null {
  let origin: string
  try { const u = new URL(url ?? ""); if (!/^https?:$/.test(u.protocol)) return null; origin = u.origin } catch { return null }
  if (!items.length || !items.every((i) => i.id && Number.isSafeInteger(i.id) && i.id > 0)) return null
  return `${origin}/cart?add=${items.map((i) => `${i.id}:${Math.max(1, Math.min(10, Math.round(i.qty)))}`).join(",")}`
}

export const codLead = internalMutation({
  // source "checkout" = the website's own checkout page (shown as "Website checkout"); default = COD popup
  args: { phone: v.string(), name: v.string(), email: v.optional(v.string()), address: v.string(), zone: v.optional(v.string()), items: v.array(leadItem), url: v.optional(v.string()), source: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const kind = a.source === "checkout" ? "webcheckout" : "codform"
    const phone = normalizePhone(a.phone)
    if (!/^01[3-9]\d{8}$/.test(phone)) return "bad phone"
    const now = Date.now()
    // already ordered in the last 2 hours (the form also sends while the order is being placed)
    const recent = await ctx.db.query("orders").withIndex("by_phone", (q) => q.eq("phone", phone)).order("desc").first()
    if (recent && !recent.deletedAt && now - recent.createdAt < 2 * 3600000) return "already ordered"
    const items: Doc<"checkouts">["items"] = []
    for (const i of a.items.slice(0, 10)) {
      const sku = (i.sku ?? "").trim().toUpperCase()
      let vr = sku ? await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first() : null
      if (!vr && i.title) vr = await matchByName(ctx, i.title, i.variant)
      const p = vr ? await ctx.db.get(vr.productId) : null
      const qty = Math.max(1, Math.min(10, Math.round(i.qty)))
      const price = Math.max(0, Math.round(i.price))
      items.push({ variantId: vr?._id, sku: vr?.sku ?? (sku || `SHOPIFY-${i.id ?? "?"}`), name: (p?.name ?? i.title).slice(0, 160), attrs: (vr?.title ?? i.variant ?? "").slice(0, 80) || undefined, imageUrl: p?.imageUrl, price, qty, discount: 0, weightKg: vr?.weightKg ?? 0.5 })
    }
    const subtotal = items.reduce((t, i) => t + i.price * i.qty, 0)
    const deliveryFee = a.zone === "outside" ? 130 : 90
    const recoveryUrl = cartLink(a.url, a.items) ?? a.url?.slice(0, 300)
    const data = {
      customerName: a.name.trim().slice(0, 80) || "Customer", phone, email: a.email?.trim().slice(0, 120) || undefined,
      address: a.address.trim().slice(0, 300), cityName: a.zone === "inside" ? "Dhaka" : undefined,
      items, subtotal, discount: 0, deliveryFee, total: subtotal + deliveryFee, recoveryUrl, shopUpdatedAt: now,
    }
    // one lead per phone, shared by the COD popup and the checkout page, so any order for the number closes it
    const checkoutId = `codform:${phone}`
    const old = await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", checkoutId)).first()
    if (!old) {
      await ctx.db.insert("checkouts", { checkoutId, kind, ...data, shopCreatedAt: now, status: "open", callCount: 0 })
      return "added"
    }
    if (now - old.shopUpdatedAt < 5000) return "too fast"
    if (old.isArchived) return "archived" // hidden by the team — do not reopen it behind their back
    if (old.status === "open") {
      await ctx.db.patch(old._id, { ...data, kind, email: data.email ?? old.email, customerName: data.customerName === "Customer" ? old.customerName : data.customerName, address: data.address || old.address, items: items.length ? items : old.items })
      return "updated"
    }
    // came back another time (older lead was ordered / lost / converted): start a fresh lead
    if (now - (old.closedAt ?? old.shopUpdatedAt) < 6 * 3600000) return "recently closed"
    await ctx.db.patch(old._id, { ...data, kind, shopCreatedAt: now, status: "open", callCount: 0, orderId: undefined, closedAt: undefined, followUpAt: undefined, lastOutcome: undefined, lastNote: undefined, lastCallBy: undefined, lastCallAt: undefined })
    return "reopened"
  },
})

/** A real order for this phone closes its COD-form lead (called from insertOrder). */
export async function closeCodLead(ctx: any, phone: string, orderId: Id<"orders">) {
  const old = await ctx.db.query("checkouts").withIndex("by_checkout", (q: any) => q.eq("checkoutId", `codform:${phone}`)).first()
  if (old && old.status === "open") await ctx.db.patch(old._id, { status: "ordered", orderId, closedAt: Date.now() })
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
export const codLeadHttp = httpAction(async (ctx, req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  try {
    const text = await req.text()
    if (text.length > 20000) return new Response("too big", { status: 413, headers: CORS })
    const b = JSON.parse(text)
    const str = (x: unknown, n: number) => (typeof x === "string" ? x : "").slice(0, n)
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 10).map((i: any) => ({
      id: Number.isFinite(+i?.id) ? +i.id : undefined, sku: str(i?.sku, 60), qty: Number(i?.qty) || 1, price: Number(i?.price) || 0,
      title: str(i?.title, 160) || "Product", variant: str(i?.variant, 80),
    }))
    const res = await ctx.runMutation(internal.checkouts.codLead, {
      phone: str(b.phone, 20), name: str(b.name, 80), email: str(b.email, 120), address: str(b.address, 300), zone: str(b.zone, 10), items, url: str(b.url, 300),
      source: b.source === "checkout" ? "checkout" : undefined,
    })
    return new Response(JSON.stringify({ ok: true, res }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } })
  } catch {
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } })
  }
})

type Row = Doc<"checkouts"> & { laterOrder: { id: Id<"orders">; invoice: string } | null; orderInvoice: string | null }

async function laterOrderFor(ctx: any, c: Doc<"checkouts">) {
  if (!c.phone) return null
  const orders: Doc<"orders">[] = await ctx.db.query("orders").withIndex("by_phone", (q: any) => q.eq("phone", c.phone)).collect()
  const o = orders.filter((x) => !x.deletedAt && x.createdAt >= c.shopCreatedAt - 3600000).sort((a, b) => a.createdAt - b.createdAt)[0]
  return o ? { id: o._id, invoice: o.invoiceCode ?? `BB-${o.invoiceNo}` } : null
}

export const list = query({
  args: { tab: v.string() }, // new | followup | converted | ordered | lost | archived
  handler: async (ctx, { tab }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const now = Date.now()

    // Archived is its own list: soft-deleted carts are hidden from every working tab, so a duplicate or
    // invalid entry stops cluttering the call queue without the record being lost.
    if (tab === "archived") {
      const rows = await ctx.db.query("checkouts").withIndex("by_archived", (q) => q.eq("isArchived", true)).order("desc").take(400)
      const out: Row[] = []
      for (const c of rows) {
        const orderInvoice = c.orderId ? await ctx.db.get(c.orderId).then((o) => (o ? o.invoiceCode ?? `BB-${o.invoiceNo}` : null)) : null
        out.push({ ...c, laterOrder: null, orderInvoice })
      }
      return out
    }

    const status = tab === "new" || tab === "followup" ? "open" : tab
    const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(400)
    const out: Row[] = []
    for (const c of rows) {
      if (c.isArchived) continue // legacy rows have no field at all, so this is false for them
      if (status === "open") {
        if (now - c.shopUpdatedAt < ABANDON_AFTER) continue // customer may still be paying
        const isFollow = c.callCount > 0
        if (tab === "new" && isFollow) continue
        if (tab === "followup" && !isFollow) continue
      }
      const laterOrder = status === "open" ? await laterOrderFor(ctx, c) : null
      const orderInvoice = c.orderId ? await ctx.db.get(c.orderId).then((o) => (o ? o.invoiceCode ?? `BB-${o.invoiceNo}` : null)) : null
      out.push({ ...c, laterOrder, orderInvoice })
    }
    if (tab === "followup") out.sort((a, b) => (a.followUpAt ?? Infinity) - (b.followUpAt ?? Infinity))
    return out
  },
})

export const counts = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const now = Date.now()
    const open = (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open")).take(1000))
      .filter((c) => !c.isArchived && now - c.shopUpdatedAt >= ABANDON_AFTER)
    const since = now - 30 * 86400000
    const converted = (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "converted")).take(2000))
      .filter((c) => !c.isArchived && (c.closedAt ?? 0) >= since)
    return {
      new: open.filter((c) => c.callCount === 0).length,
      followup: open.filter((c) => c.callCount > 0).length,
      followupDue: open.filter((c) => c.followUpAt && c.followUpAt <= now).length,
      recovered30d: converted.length,
      // tab numbers (capped so the page stays light; shows 999+)
      recovered: (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "converted")).take(1000)).filter((c) => !c.isArchived).length,
      ordered: (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "ordered")).take(1000)).filter((c) => !c.isArchived).length,
      lost: (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "lost")).take(1000)).filter((c) => !c.isArchived).length,
      archived: (await ctx.db.query("checkouts").withIndex("by_archived", (q) => q.eq("isArchived", true)).take(1000)).length,
      recoveredValue30d: converted.reduce((s2, c) => s2 + c.total, 0),
    }
  },
})

// ---------- work on a cart ----------
export const logCall = mutation({
  args: { id: v.id("checkouts"), outcome: v.string(), note: v.optional(v.string()), followUpAt: v.optional(v.number()) },
  handler: async (ctx, { id, outcome, note, followUpAt }) => {
    const me = await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(id)
    if (!c) throw new ConvexError("Cart not found")
    if (c.isArchived) throw new ConvexError("This cart is archived — restore it before logging a call")
    await ctx.db.patch(id, {
      callCount: c.callCount + 1, lastOutcome: outcome, lastNote: note?.trim() || undefined, lastCallBy: me.staff.name, lastCallAt: Date.now(),
      followUpAt: followUpAt || undefined,
    })
  },
})

export const close = mutation({
  args: { id: v.id("checkouts"), status: v.union(v.literal("lost"), v.literal("open"), v.literal("ordered")), note: v.optional(v.string()), orderId: v.optional(v.id("orders")) },
  handler: async (ctx, { id, status, note, orderId }) => {
    const me = await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(id)
    if (!c) throw new ConvexError("Cart not found")
    if (c.isArchived) throw new ConvexError("This cart is archived — restore it first")
    if (c.status === "converted" || c.status === "ordered") throw new ConvexError("This cart already became an order")
    await ctx.db.patch(id, status === "open"
      ? { status, closedBy: undefined, closedAt: undefined }
      : { status, closedBy: me.staff.name, closedAt: Date.now(), lastNote: note?.trim() || c.lastNote, followUpAt: undefined, ...(orderId ? { orderId } : {}) })
  },
})

// ---------- Phase 1 / Task 3: recovery queue controls ----------

/** Trim, collapse whitespace, cap length. Returns undefined for an empty value so the field is cleared. */
const clean = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, max)
  return t || undefined
}

/** Discount codes: uppercase, de-duplicated, blanks dropped, capped at 10 codes of 40 chars. */
export function cleanCodes(codes: string[] | undefined): string[] | undefined {
  const out: string[] = []
  for (const c of codes ?? []) {
    const t = (c ?? "").trim().toUpperCase().slice(0, 40)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 10) break
  }
  return out.length ? out : undefined
}

/** Inline edit of a cart from the queue. Every field is optional — the modal only sends what the agent touched,
 *  so a legacy row missing notes / discountCodes is patched with just the new values and never rewritten wholesale. */
export const modify = mutation({
  args: {
    id: v.id("checkouts"),
    customerName: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    discountCodes: v.optional(v.array(v.string())),
    recoveryStatus: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(a.id)
    if (!c) throw new ConvexError("Cart not found")
    if (c.isArchived) throw new ConvexError("This cart is archived — restore it before editing")

    const patch: Record<string, unknown> = {}
    const changed: string[] = []
    // Only called for fields the caller actually sent, so `undefined` here means "clear this field" — not
    // "leave it alone". Patching a field to undefined removes it, which is what emptying an input should do.
    const set = (key: string, next: unknown, prev: unknown) => {
      if (next === prev) return
      patch[key] = next
      changed.push(key)
    }

    if (a.customerName !== undefined) {
      const name = clean(a.customerName, 80)
      if (!name) throw new ConvexError("Customer name cannot be empty")
      set("customerName", name, c.customerName)
    }
    if (a.phone !== undefined) {
      const raw = (a.phone ?? "").trim()
      // An empty phone is allowed (some leads genuinely have none) — anything else must be a real BD mobile.
      const phone = raw ? normalizePhone(raw) : ""
      if (raw && !/^01[3-9]\d{8}$/.test(phone)) throw new ConvexError("Phone must be a valid 11-digit number like 01712345678")
      set("phone", phone, c.phone)
    }
    if (a.address !== undefined) set("address", clean(a.address, 300) ?? "", c.address)
    if (a.notes !== undefined) set("notes", clean(a.notes, 1000), c.notes)
    if (a.discountCodes !== undefined) set("discountCodes", cleanCodes(a.discountCodes), c.discountCodes)
    if (a.recoveryStatus !== undefined) set("recoveryStatus", clean(a.recoveryStatus, 40), c.recoveryStatus)

    if (!changed.length) return { changed: [] as string[] }

    await ctx.db.patch(a.id, { ...patch, editedAt: Date.now(), editedBy: me.staff.name })
    await ctx.db.insert("checkoutAudit", {
      checkoutId: a.id, action: "modify", byName: me.staff.name, at: Date.now(), fields: changed,
    })
    return { changed }
  },
})

/** Soft delete. Sets isArchived: true and writes an audit row — the cart and its history are never removed,
 *  so a duplicate/invalid entry can be hidden from the queue without losing the record. */
export const archive = mutation({
  args: { id: v.id("checkouts"), reason: v.optional(v.string()) },
  handler: async (ctx, { id, reason }) => {
    const me = await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(id)
    if (!c) throw new ConvexError("Cart not found")
    // Idempotent: archiving an already-archived cart is a no-op, not an error (double-click safe).
    if (c.isArchived) return { alreadyArchived: true }
    const now = Date.now()
    const why = clean(reason, 200)
    await ctx.db.patch(id, { isArchived: true, archivedAt: now, archivedBy: me.staff.name, archiveReason: why })
    await ctx.db.insert("checkoutAudit", {
      checkoutId: id, action: "archive", byName: me.staff.name, at: now, reason: why,
    })
    return { alreadyArchived: false }
  },
})

/** Undo a soft delete. */
export const unarchive = mutation({
  args: { id: v.id("checkouts") },
  handler: async (ctx, { id }) => {
    const me = await requirePerm(ctx, "orders.view")
    const c = await ctx.db.get(id)
    if (!c) throw new ConvexError("Cart not found")
    if (!c.isArchived) return { alreadyActive: true }
    await ctx.db.patch(id, { isArchived: false, archivedAt: undefined, archivedBy: undefined, archiveReason: undefined })
    await ctx.db.insert("checkoutAudit", { checkoutId: id, action: "unarchive", byName: me.staff.name, at: Date.now() })
    return { alreadyActive: false }
  },
})

/** Who did what to this cart, newest first. Read-only. */
export const auditFor = query({
  args: { id: v.id("checkouts") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return await ctx.db.query("checkoutAudit").withIndex("by_checkout", (q) => q.eq("checkoutId", id)).order("desc").take(50)
  },
})

/** The customer confirmed on the phone: make a real order from the cart (Approved by default). */
export const convert = mutation({
  args: {
    id: v.id("checkouts"), customerName: v.string(), phone: v.string(), address: v.string(), deliveryFee: v.number(),
    status: v.union(v.literal("approved"), v.literal("pending")), note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.create")
    const c = await ctx.db.get(a.id)
    if (!c) throw new ConvexError("Cart not found")
    if (c.isArchived) throw new ConvexError("This cart is archived — restore it first")
    if (c.orderId) throw new ConvexError("This cart already has an order")
    if (!c.items.length) throw new ConvexError("This cart has no products — make the order from “New order” instead")
    const res = await insertOrder(ctx, {
      source: "Website",
      externalId: `checkout:${c.checkoutId}`,
      externalName: "Abandoned cart",
      customerName: a.customerName.trim() || c.customerName,
      phone: a.phone,
      email: c.email,
      address: a.address.trim() || c.address,
      cityName: c.cityName,
      deliveryType: "regular",
      items: (await linkItems(ctx, c.items)).items,
      discount: c.discount,
      deliveryFee: a.deliveryFee,
      status: a.status,
      additionalInfo: a.note?.trim() || undefined,
    }, me.staff.name)
    await logOrder(ctx, res.orderId, `Recovered from an abandoned cart (Shopify checkout ${c.checkoutId}) by ${me.staff.name}`, me.staff.name)
    await ctx.db.patch(c._id, { status: "converted", orderId: res.orderId, closedBy: me.staff.name, closedAt: Date.now(), followUpAt: undefined })
    if (a.status === "approved") {
      await awardPoints(ctx, { staffName: me.staff.name, ruleKey: "cx.recovered_checkout", label: `Recovered an abandoned checkout — ${c.checkoutId}`, orderId: res.orderId })
    }
    return res
  },
})

/** One-time demo cart for a screenshot (clearly marked as a demo). */
export const addDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const exists = await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", "demo-1")).first()
    if (exists) return "exists"
    const vars = (await ctx.db.query("variants").take(400)).filter((v) => v.active !== false && v.price > 0)
    const pick = vars.filter((v) => /BHSS|SH-/.test(v.sku)).slice(0, 2)
    const chosen = pick.length ? pick : vars.slice(0, 2)
    const items: Doc<"checkouts">["items"] = []
    for (const vr of chosen.slice(0, 2)) {
      const p = await ctx.db.get(vr.productId)
      items.push({ variantId: vr._id, sku: vr.sku, name: p?.name ?? vr.sku, attrs: vr.title, imageUrl: p?.imageUrl, price: vr.price, qty: 1, discount: 0, weightKg: vr.weightKg })
    }
    const subtotal = items.reduce((s, i) => s + i.price, 0)
    const now = Date.now()
    await ctx.db.insert("checkouts", {
      checkoutId: "demo-1", customerName: "Demo Customer (test)", phone: "01700000000", email: "demo@example.com",
      address: "House 12, Road 5, Dhanmondi, Dhaka", cityName: "Dhaka", items, subtotal, discount: 0, deliveryFee: 90,
      total: subtotal + 90, recoveryUrl: "https://blackbole.com/", shopCreatedAt: now - 40 * 60000, shopUpdatedAt: now - 35 * 60000,
      status: "open", callCount: 0,
    })
    return "added"
  },
})
