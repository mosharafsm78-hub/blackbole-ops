import { v, ConvexError } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { orderItem } from "./schema"
import { currentStaff, logOrder, requirePerm } from "./lib"
import { normalizePhone } from "./rules"
import { insertOrder } from "./orders"

/** A checkout counts as abandoned once nothing has happened on it for this long. */
export const ABANDON_AFTER = 15 * 60000

// ---------- from Shopify ----------
export const upsertFromShopify = internalMutation({
  args: {
    checkoutId: v.string(), token: v.optional(v.string()), customerName: v.string(), phone: v.string(), email: v.optional(v.string()),
    address: v.string(), cityName: v.optional(v.string()), items: v.array(orderItem), subtotal: v.number(), discount: v.number(),
    deliveryFee: v.number(), total: v.number(), recoveryUrl: v.optional(v.string()), shopCreatedAt: v.number(), shopUpdatedAt: v.number(),
    completed: v.boolean(),
  },
  handler: async (ctx, { completed, ...a }) => {
    const phone = /^01\d{9}$/.test(normalizePhone(a.phone)) ? normalizePhone(a.phone) : ""
    const old = await ctx.db.query("checkouts").withIndex("by_checkout", (q) => q.eq("checkoutId", a.checkoutId)).first()
    if (old) {
      if (old.status === "converted" || old.status === "ordered") return
      await ctx.db.patch(old._id, { ...a, phone: phone || old.phone, items: a.items.length ? a.items : old.items, ...(completed ? { status: "ordered", closedAt: Date.now() } : {}) })
      return
    }
    if (completed) return
    await ctx.db.insert("checkouts", { ...a, phone, status: "open", callCount: 0 })
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
type Row = Doc<"checkouts"> & { laterOrder: { id: Id<"orders">; invoice: string } | null; orderInvoice: string | null }

async function laterOrderFor(ctx: any, c: Doc<"checkouts">) {
  if (!c.phone) return null
  const orders: Doc<"orders">[] = await ctx.db.query("orders").withIndex("by_phone", (q: any) => q.eq("phone", c.phone)).collect()
  const o = orders.filter((x) => !x.deletedAt && x.createdAt >= c.shopCreatedAt - 3600000).sort((a, b) => a.createdAt - b.createdAt)[0]
  return o ? { id: o._id, invoice: o.invoiceCode ?? `BB-${o.invoiceNo}` } : null
}

export const list = query({
  args: { tab: v.string() }, // new | followup | converted | ordered | lost
  handler: async (ctx, { tab }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const now = Date.now()
    const status = tab === "new" || tab === "followup" ? "open" : tab
    const rows = await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(400)
    const out: Row[] = []
    for (const c of rows) {
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
    const open = (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "open")).take(1000)).filter((c) => now - c.shopUpdatedAt >= ABANDON_AFTER)
    const since = now - 30 * 86400000
    const converted = (await ctx.db.query("checkouts").withIndex("by_status", (q) => q.eq("status", "converted")).take(2000)).filter((c) => (c.closedAt ?? 0) >= since)
    return {
      new: open.filter((c) => c.callCount === 0).length,
      followup: open.filter((c) => c.callCount > 0).length,
      followupDue: open.filter((c) => c.followUpAt && c.followUpAt <= now).length,
      recovered30d: converted.length,
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
    if (c.status === "converted" || c.status === "ordered") throw new ConvexError("This cart already became an order")
    await ctx.db.patch(id, status === "open"
      ? { status, closedBy: undefined, closedAt: undefined }
      : { status, closedBy: me.staff.name, closedAt: Date.now(), lastNote: note?.trim() || c.lastNote, followUpAt: undefined, ...(orderId ? { orderId } : {}) })
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
      items: c.items,
      discount: c.discount,
      deliveryFee: a.deliveryFee,
      status: a.status,
      additionalInfo: a.note?.trim() || undefined,
    }, me.staff.name)
    await logOrder(ctx, res.orderId, `Recovered from an abandoned cart (Shopify checkout ${c.checkoutId}) by ${me.staff.name}`, me.staff.name)
    await ctx.db.patch(c._id, { status: "converted", orderId: res.orderId, closedBy: me.staff.name, closedAt: Date.now(), followUpAt: undefined })
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
