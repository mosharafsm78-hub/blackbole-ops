// Third-party outlets: stock moves between warehouses and outlets, manual outlet sales, and one combined sales view.
// Outlets are `locations` rows with isOutlet (+ noCourier), so they never reach Pathao, the website, Shopify or the feed.
import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { bumpStock, currentStaff, requirePerm } from "./lib"
import { variantLabel } from "./catalog"

const DAY = 86_400_000
const MAX_RANGE = 93 * DAY

/** Move pairs from one location to another (warehouse ↔ warehouse, warehouse ↔ outlet). Logged in both stock histories. */
export const moveStock = mutation({
  args: { variantId: v.id("variants"), fromId: v.id("locations"), toId: v.id("locations"), qty: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "inventory.receive")
    if (!Number.isInteger(a.qty) || a.qty <= 0) throw new ConvexError("Quantity must be a whole number above 0")
    if (a.fromId === a.toId) throw new ConvexError("Pick two different places")
    await moveOne(ctx, a, me.staff.name)
    return true
  },
})

export async function moveOne(ctx: any, a: { variantId: Id<"variants">; fromId: Id<"locations">; toId: Id<"locations">; qty: number; note?: string }, byName: string) {
  const from = await ctx.db.get(a.fromId) as Doc<"locations"> | null
  const to = await ctx.db.get(a.toId) as Doc<"locations"> | null
  if (!from || !to) throw new ConvexError("Location not found")
  const row = await ctx.db.query("stock").withIndex("by_variant_location", (q: any) => q.eq("variantId", a.variantId).eq("locationId", a.fromId)).unique() as Doc<"stock"> | null
  const real = (row?.available ?? 0) - (row?.virtual ?? 0)
  if (real < a.qty) {
    const vr = await ctx.db.get(a.variantId) as Doc<"variants"> | null
    throw new ConvexError(`${from.name} has only ${Math.max(0, real)} of ${vr?.sku ?? "this size"} available`)
  }
  await bumpStock(ctx, { variantId: a.variantId, locationId: a.fromId, bucket: "available", change: -a.qty, reason: `Moved to ${to.name}`, byName, note: a.note })
  await bumpStock(ctx, { variantId: a.variantId, locationId: a.toId, bucket: "available", change: a.qty, reason: `Moved from ${from.name}`, byName, note: a.note })
}

/** Type in outlet sales (shoe + size + qty + sale price). Stock leaves the outlet; undo puts it back. */
export const recordSale = mutation({
  args: {
    locationId: v.id("locations"),
    soldAt: v.number(),
    note: v.optional(v.string()),
    lines: v.array(v.object({ variantId: v.id("variants"), qty: v.number(), unitPrice: v.number() })),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "inventory.receive")
    const loc = await ctx.db.get(a.locationId)
    if (!loc?.isOutlet) throw new ConvexError("Pick an outlet")
    const lines = a.lines.filter((l) => l.qty > 0)
    if (!lines.length) throw new ConvexError("Add at least one pair")
    if (a.soldAt > Date.now() + DAY) throw new ConvexError("The sale date can't be in the future")
    for (const l of lines) {
      if (!Number.isInteger(l.qty)) throw new ConvexError("Quantity must be a whole number")
      if (l.unitPrice < 0) throw new ConvexError("Price can't be negative")
      const vr = await ctx.db.get(l.variantId)
      if (!vr) throw new ConvexError("Product not found")
      const p = await ctx.db.get(vr.productId)
      const row = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", l.variantId).eq("locationId", a.locationId)).unique()
      if ((row?.available ?? 0) < l.qty) throw new ConvexError(`${loc.name} has only ${row?.available ?? 0} of ${p?.name ?? ""} ${variantLabel(vr)}`)
      await bumpStock(ctx, { variantId: l.variantId, locationId: a.locationId, bucket: "available", change: -l.qty, reason: "Outlet sale", byName: me.staff.name, note: a.note })
      await ctx.db.insert("outletSales", {
        locationId: a.locationId, variantId: l.variantId, sku: vr.sku, productName: p?.name ?? "", title: variantLabel(vr),
        qty: l.qty, unitPrice: l.unitPrice, unitCost: vr.purchasePrice ?? 0, soldAt: a.soldAt, note: a.note, byName: me.staff.name, at: Date.now(),
      })
    }
    return lines.reduce((s, l) => s + l.qty, 0)
  },
})

export const undoSale = mutation({
  args: { id: v.id("outletSales") },
  handler: async (ctx, { id }) => {
    const me = await requirePerm(ctx, "inventory.receive")
    const s = await ctx.db.get(id)
    if (!s) throw new ConvexError("Sale not found")
    if (s.undoneAt) throw new ConvexError("Already undone")
    await bumpStock(ctx, { variantId: s.variantId, locationId: s.locationId, bucket: "available", change: s.qty, reason: "Outlet sale undone", byName: me.staff.name })
    await ctx.db.patch(id, { undoneAt: Date.now(), undoneBy: me.staff.name })
    return true
  },
})

/** Outlet sales in a date range (newest first). */
export const listSales = query({
  args: { from: v.number(), to: v.number(), locationId: v.optional(v.id("locations")) },
  handler: async (ctx, a) => {
    if (!(await currentStaff(ctx))) return []
    const to = Math.min(a.to, a.from + MAX_RANGE)
    const locs = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
    const rows = a.locationId
      ? await ctx.db.query("outletSales").withIndex("by_location_sold", (q) => q.eq("locationId", a.locationId!).gte("soldAt", a.from).lte("soldAt", to)).order("desc").take(1000)
      : await ctx.db.query("outletSales").withIndex("by_sold", (q) => q.gte("soldAt", a.from).lte("soldAt", to)).order("desc").take(1000)
    return rows.map((r) => ({ ...r, locationName: locs.get(r.locationId as string) ?? "—" }))
  },
})

/** Online + outlets side by side for a date range. Online = parcels delivered in the range. */
export const salesOverview = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, a) => {
    if (!(await currentStaff(ctx))) return null
    const to = Math.min(a.to, a.from + MAX_RANGE)
    const orders = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", a.from).lte("deliveredAt", to)).take(5000)
    const live = orders.filter((o) => !o.deletedAt && o.status.startsWith("delivered"))
    const online = { orders: live.length, pairs: 0, amount: 0, cost: 0 }
    for (const o of live) {
      online.pairs += o.items.reduce((s, i) => s + i.qty, 0)
      online.amount += o.total - o.deliveryFee
      online.cost += o.purchaseCost ?? 0
    }
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.isOutlet)
    const sales = (await ctx.db.query("outletSales").withIndex("by_sold", (q) => q.gte("soldAt", a.from).lte("soldAt", to)).take(5000)).filter((s) => !s.undoneAt)
    const outlets = locs.map((l) => {
      const mine = sales.filter((s) => s.locationId === l._id)
      return { locationId: l._id, name: l.name, active: l.active, pairs: mine.reduce((s, x) => s + x.qty, 0), amount: mine.reduce((s, x) => s + x.qty * x.unitPrice, 0), cost: mine.reduce((s, x) => s + x.qty * x.unitCost, 0) }
    })
    let left = 0
    for (const l of locs) for (const r of await ctx.db.query("stock").withIndex("by_location", (q) => q.eq("locationId", l._id)).collect()) left += r.available
    return { online, outlets, outletStockLeft: left, truncated: orders.length >= 5000 || sales.length >= 5000 }
  },
})

/** "Where is it?" — a shoe (name or SKU) and how many pairs are at each warehouse and outlet. */
export const whereIs = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    if (!(await currentStaff(ctx))) return []
    const term = q.trim().toLowerCase().split(/\s+/).filter((w) => w !== "blackbole").join(" ")
    if (term.length < 2) return []
    const up = term.toUpperCase()
    const bySku = await ctx.db.query("variants").withIndex("by_sku", (x) => x.gte("sku", up).lt("sku", up + "￿")).take(60)
    const words = term.split(/\s+/).filter(Boolean)
    const hits = await ctx.db.query("products").withSearchIndex("search_name", (x) => x.search("name", term)).take(8)
    const byName: Doc<"variants">[] = []
    for (const p of hits) for (const vr of await ctx.db.query("variants").withIndex("by_product", (x) => x.eq("productId", p._id)).take(40)) {
      if (words.every((w) => `${p.name} ${vr.title} ${vr.sku}`.toLowerCase().includes(w))) byName.push(vr)
    }
    const seen = new Set<string>()
    const variants = [...bySku, ...byName].filter((x) => (seen.has(x._id) ? false : (seen.add(x._id), true))).filter((x) => x.active).slice(0, 60)
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.active)
    const pmap = new Map<string, Doc<"products"> | null>()
    const out: { variantId: Id<"variants">; sku: string; product: string; size: string; price: number; at: { locationId: Id<"locations">; name: string; outlet: boolean; available: number }[] }[] = []
    for (const vr of variants) {
      if (!pmap.has(vr.productId)) pmap.set(vr.productId, await ctx.db.get(vr.productId))
      const rows = await ctx.db.query("stock").withIndex("by_variant", (x) => x.eq("variantId", vr._id)).collect()
      const at = locs.map((l) => ({ locationId: l._id, name: l.name, outlet: !!l.isOutlet, available: Math.max(0, (rows.find((r) => r.locationId === l._id)?.available ?? 0) - (rows.find((r) => r.locationId === l._id)?.virtual ?? 0)) }))
      out.push({ variantId: vr._id, sku: vr.sku, product: pmap.get(vr.productId)?.name ?? "", size: variantLabel(vr), price: vr.price, at })
    }
    return out.sort((a, b) => a.product.localeCompare(b.product) || a.size.localeCompare(b.size, undefined, { numeric: true }))
  },
})

/** For order lines: which outlets hold each size (only outlets with pairs). */
export const outletAvailability = query({
  args: { variantIds: v.array(v.id("variants")) },
  handler: async (ctx, { variantIds }) => {
    if (!(await currentStaff(ctx))) return {} as Record<string, { name: string; available: number }[]>
    const outlets = (await ctx.db.query("locations").collect()).filter((l) => l.isOutlet && l.active)
    const out: Record<string, { name: string; available: number }[]> = {}
    if (!outlets.length) return out
    for (const id of variantIds.slice(0, 40)) {
      for (const l of outlets) {
        const r = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", id).eq("locationId", l._id)).unique()
        if (r && r.available > 0) (out[id] ??= []).push({ name: l.name, available: r.available })
      }
    }
    return out
  },
})

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** One-time opening stock for an outlet from a stock sheet. SETS the outlet's pairs to `qty` per SKU (safe to run twice).
 *  Matches an existing size by SKU, else by product name + colour + size; creates what is missing (never published to the website). */
export const importOutletStock = internalMutation({
  args: {
    outletName: v.string(),
    rows: v.array(v.object({ sku: v.string(), name: v.string(), color: v.string(), size: v.string(), price: v.number(), qty: v.number() })),
  },
  handler: async (ctx, a) => {
    const loc = (await ctx.db.query("locations").collect()).find((l) => l.isOutlet && l.name === a.outletName)
    if (!loc) throw new ConvexError(`Outlet ${a.outletName} not found`)
    const out = { matchedSku: 0, matchedName: 0, createdVariants: 0, createdProducts: 0, pairs: 0 }
    const prodCache = new Map<string, Doc<"products"> | null>()
    for (const r of a.rows) {
      const sku = r.sku.trim().toUpperCase()
      const hasSize = !!r.size && r.size.toUpperCase() !== "N/A"
      const title = hasSize ? `${r.color.trim() ? r.color.trim()[0].toUpperCase() + r.color.trim().slice(1) : "Default"} / ${r.size}` : (r.color.trim() || "Default")
      let vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (vr) out.matchedSku++
      const key = norm(r.name)
      if (!vr || true) {
        if (!prodCache.has(key)) {
          const hits = await ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", r.name)).take(10)
          prodCache.set(key, hits.find((p) => !p.deletedAt && norm(p.name) === key) ?? null)
        }
      }
      let product = prodCache.get(key) ?? null
      if (!vr && product) {
        const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", product!._id)).take(200)
        vr = vs.find((x) => norm(x.title) === norm(title) || (hasSize && norm(x.title).split(" ").pop() === norm(r.size) && norm(x.title).includes(norm(r.color)))) ?? null
        if (vr) out.matchedName++
      }
      if (!vr) {
        if (!product) {
          const id = await ctx.db.insert("products", { name: r.name.trim(), active: true, createdAt: Date.now() })
          product = (await ctx.db.get(id))!
          prodCache.set(key, product)
          out.createdProducts++
        }
        const id = await ctx.db.insert("variants", { productId: product._id, sku, title, weightKg: 0.4, price: r.price, purchasePrice: 0, active: true, createdAt: Date.now() })
        vr = (await ctx.db.get(id))!
        out.createdVariants++
      }
      const row = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", vr!._id).eq("locationId", loc._id)).unique()
      const delta = r.qty - (row?.available ?? 0)
      if (delta !== 0) await bumpStock(ctx, { variantId: vr._id, locationId: loc._id, bucket: "available", change: delta, reason: "Opening stock (outlet sheet)", byName: "Import" })
      out.pairs += r.qty
    }
    return out
  },
})
