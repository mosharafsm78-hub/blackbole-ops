import { v, ConvexError } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { bumpStock, currentStaff, nextCounter, requirePerm } from "./lib"

const variantInput = v.object({
  id: v.optional(v.id("variants")),
  sku: v.string(),
  title: v.string(),
  attrs: v.optional(v.string()),
  weightKg: v.number(),
  price: v.number(),
  purchasePrice: v.number(),
  active: v.boolean(),
})

type StockSum = { available: number; processing: number; inTransit: number; returning: number; damaged: number }
const emptySum = (): StockSum => ({ available: 0, processing: 0, inTransit: 0, returning: 0, damaged: 0 })

async function stockByVariant(ctx: any, locationId?: Id<"locations">) {
  const rows: Doc<"stock">[] = locationId
    ? await ctx.db.query("stock").withIndex("by_location", (q: any) => q.eq("locationId", locationId)).collect()
    : await ctx.db.query("stock").collect()
  const map = new Map<string, StockSum>()
  for (const r of rows) {
    const s = map.get(r.variantId) ?? emptySum()
    s.available += r.available
    s.processing += r.processing
    s.inTransit += r.inTransit
    s.returning += r.returning
    s.damaged += r.damaged
    map.set(r.variantId, s)
  }
  return map
}

export const listProducts = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const products = await ctx.db.query("products").collect()
    const variants = await ctx.db.query("variants").collect()
    const stock = await stockByVariant(ctx)
    const byProduct = new Map<string, any[]>()
    for (const vr of variants) {
      const list = byProduct.get(vr.productId) ?? []
      list.push({ ...vr, stock: stock.get(vr._id) ?? emptySum() })
      byProduct.set(vr.productId, list)
    }
    return products
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({ ...p, variants: (byProduct.get(p._id) ?? []).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })) }))
  },
})

export const saveProduct = mutation({
  args: {
    id: v.optional(v.id("products")),
    name: v.string(),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    active: v.boolean(),
    preOrder: v.optional(v.boolean()),
    preOrderFrom: v.optional(v.union(v.literal("china"), v.literal("bangladesh"))),
    variants: v.array(variantInput),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "products.manage")
    if (!a.name.trim()) throw new ConvexError("Product name is required")
    if (a.variants.length === 0) throw new ConvexError("Add at least one variant (SKU)")
    const skus = a.variants.map((x) => x.sku.trim().toUpperCase())
    if (skus.some((s) => !s)) throw new ConvexError("Every variant needs a SKU")
    if (new Set(skus).size !== skus.length) throw new ConvexError("SKUs must be unique")
    for (const vr of a.variants) {
      const clash = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", vr.sku.trim().toUpperCase())).first()
      if (clash && clash._id !== vr.id) throw new ConvexError(`SKU ${vr.sku} is already used by another product`)
    }
    const data = { name: a.name.trim(), category: a.category, description: a.description, imageUrl: a.imageUrl, active: a.active, preOrder: a.preOrder || undefined, preOrderFrom: a.preOrderFrom }
    let productId = a.id
    if (productId) await ctx.db.patch(productId, data)
    else productId = await ctx.db.insert("products", { ...data, createdAt: Date.now() })

    for (const vr of a.variants) {
      const row = {
        productId, sku: vr.sku.trim().toUpperCase(), title: vr.title.trim() || "Default",
        attrs: vr.attrs, weightKg: vr.weightKg, price: vr.price, purchasePrice: vr.purchasePrice, active: vr.active,
      }
      if (vr.id) await ctx.db.patch(vr.id, row)
      else await ctx.db.insert("variants", row)
    }
    return productId
  },
})

/** Bulk import rows (from our CSV template or a Shopify product export). Groups by product name. */
export const importProducts = mutation({
  args: {
    locationId: v.optional(v.id("locations")),
    rows: v.array(
      v.object({
        product: v.string(),
        category: v.optional(v.string()),
        imageUrl: v.optional(v.string()),
        sku: v.string(),
        title: v.string(),
        weightKg: v.number(),
        price: v.number(),
        purchasePrice: v.number(),
        stock: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { rows, locationId }) => {
    const me = await requirePerm(ctx, "products.manage")
    let created = 0, updated = 0, skipped = 0
    const productIds = new Map<string, Id<"products">>()
    for (const r of rows) {
      const sku = r.sku.trim().toUpperCase()
      if (!sku || !r.product.trim()) { skipped++; continue }
      const existing = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (existing) {
        await ctx.db.patch(existing._id, { price: r.price, purchasePrice: r.purchasePrice || existing.purchasePrice, weightKg: r.weightKg || existing.weightKg })
        updated++
        continue
      }
      let pid = productIds.get(r.product)
      if (!pid) {
        const found = (await ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", r.product)).take(5))
          .find((p) => p.name === r.product)
        pid = found?._id ?? (await ctx.db.insert("products", {
          name: r.product, category: r.category, imageUrl: r.imageUrl, active: true, createdAt: Date.now(),
        }))
        productIds.set(r.product, pid)
      }
      const variantId = await ctx.db.insert("variants", {
        productId: pid, sku, title: r.title || "Default", weightKg: r.weightKg, price: r.price, purchasePrice: r.purchasePrice, active: true,
      })
      if (locationId && r.stock && r.stock > 0) {
        await bumpStock(ctx, { variantId, locationId, bucket: "available", change: r.stock, reason: "Opening stock (import)", byName: me.staff.name })
      }
      created++
    }
    return { created, updated, skipped }
  },
})

/** Variant search for the create-order screen and stock-in. */
export const searchVariants = query({
  args: { q: v.string(), locationId: v.optional(v.id("locations")) },
  handler: async (ctx, { q, locationId }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const term = q.trim().toLowerCase()
    // Read only what can match (was: every product, variant and stock row on each keystroke)
    let variants: Doc<"variants">[] = []
    if (!term) variants = await ctx.db.query("variants").take(120)
    else {
      const up = term.toUpperCase()
      const bySku = await ctx.db.query("variants").withIndex("by_sku", (x) => x.gte("sku", up).lt("sku", up + "\uffff")).take(60)
      const words = term.split(/\s+/).filter(Boolean)
      const hits = await ctx.db.query("products").withSearchIndex("search_name", (x) => x.search("name", term)).take(15)
      const byName: Doc<"variants">[] = []
      for (const p of hits) {
        for (const vr of await ctx.db.query("variants").withIndex("by_product", (x) => x.eq("productId", p._id)).take(40)) {
          const text = `${p.name} ${vr.title} ${vr.sku}`.toLowerCase()
          if (words.every((w) => text.includes(w))) byName.push(vr)
        }
      }
      const seen = new Set<string>()
      variants = [...bySku, ...byName].filter((x) => (seen.has(x._id) ? false : (seen.add(x._id), true)))
      // SKU typed from the middle (e.g. "RCS-BR"): fall back to a full scan only when nothing else matched
      if (!variants.length) variants = (await ctx.db.query("variants").collect()).filter((vr) => vr.sku.toLowerCase().includes(term))
    }
    const pmap = new Map<string, Doc<"products"> | null>()
    for (const vr of variants) if (!pmap.has(vr.productId)) pmap.set(vr.productId, await ctx.db.get(vr.productId))
    const picked = variants.filter((vr) => vr.active && pmap.get(vr.productId)?.active !== false).slice(0, 40)
    const stock = new Map<string, StockSum>()
    for (const vr of picked) {
      const rows = locationId
        ? await ctx.db.query("stock").withIndex("by_variant_location", (x) => x.eq("variantId", vr._id).eq("locationId", locationId)).collect()
        : await ctx.db.query("stock").withIndex("by_variant_location", (x) => x.eq("variantId", vr._id)).collect()
      const s = emptySum()
      for (const r of rows) s.available += r.available
      stock.set(vr._id, s)
    }
    return picked
      .map((vr) => {
        const p = pmap.get(vr.productId)
        return {
          _id: vr._id, sku: vr.sku, title: vr.title, attrs: vr.attrs, price: vr.price, purchasePrice: vr.purchasePrice,
          weightKg: vr.weightKg, productName: p?.name ?? "", imageUrl: p?.imageUrl,
          available: stock.get(vr._id)?.available ?? 0,
        }
      })
  },
})

export const inventory = query({
  args: { locationId: v.optional(v.id("locations")) },
  handler: async (ctx, { locationId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const products = await ctx.db.query("products").collect()
    const pmap = new Map(products.map((p) => [p._id as string, p]))
    const variants = await ctx.db.query("variants").collect()
    const stock = await stockByVariant(ctx, locationId)
    const rows = variants.map((vr) => {
      const st = stock.get(vr._id) ?? emptySum()
      const p = pmap.get(vr.productId)
      return {
        _id: vr._id, sku: vr.sku, title: vr.title, productName: p?.name ?? "", imageUrl: p?.imageUrl,
        price: vr.price, purchasePrice: vr.purchasePrice, ...st,
        stockValue: st.available * vr.price, costValue: st.available * vr.purchasePrice,
      }
    })
    const totals = rows.reduce(
      (t, r) => ({
        available: t.available + Math.max(0, r.available),
        shortage: t.shortage + (r.available < 0 ? -r.available : 0),
        processing: t.processing + r.processing,
        inTransit: t.inTransit + r.inTransit,
        returning: t.returning + r.returning,
        damaged: t.damaged + r.damaged,
        stockValue: t.stockValue + Math.max(0, r.stockValue),
        costValue: t.costValue + Math.max(0, r.costValue),
      }),
      { available: 0, shortage: 0, processing: 0, inTransit: 0, returning: 0, damaged: 0, stockValue: 0, costValue: 0 },
    )
    return { rows: rows.sort((a, b) => a.productName.localeCompare(b.productName) || a.title.localeCompare(b.title, undefined, { numeric: true })), totals }
  },
})

export const receiveStock = mutation({
  args: {
    locationId: v.id("locations"),
    supplier: v.optional(v.string()),
    note: v.optional(v.string()),
    updateCost: v.boolean(),
    items: v.array(v.object({ variantId: v.id("variants"), qty: v.number(), unitCost: v.number() })),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "inventory.receive")
    const items = a.items.filter((i) => i.qty > 0)
    if (items.length === 0) throw new ConvexError("Add at least one item with a quantity")
    const code = await nextCounter(ctx, "receipt", 1)
    const full: { variantId: Id<"variants">; sku: string; name: string; qty: number; unitCost: number }[] = []
    for (const i of items) {
      const vr = await ctx.db.get(i.variantId)
      if (!vr) continue
      const p = await ctx.db.get(vr.productId)
      full.push({ variantId: i.variantId, sku: vr.sku, name: `${p?.name ?? ""} - ${vr.title}`, qty: i.qty, unitCost: i.unitCost })
    }
    const receiptId = await ctx.db.insert("receipts", {
      code, locationId: a.locationId, supplier: a.supplier, note: a.note, items: full,
      totalQty: full.reduce((s, i) => s + i.qty, 0),
      totalCost: full.reduce((s, i) => s + i.qty * i.unitCost, 0),
      byName: me.staff.name, at: Date.now(),
    })
    for (const i of full) {
      await bumpStock(ctx, { variantId: i.variantId, locationId: a.locationId, bucket: "available", change: i.qty, reason: `Stock in GRN-${code}`, byName: me.staff.name, receiptId })
      if (a.updateCost && i.unitCost > 0) await ctx.db.patch(i.variantId, { purchasePrice: i.unitCost })
    }
    return code
  },
})

export const adjustStock = mutation({
  args: {
    variantId: v.id("variants"),
    locationId: v.id("locations"),
    bucket: v.union(v.literal("available"), v.literal("damaged")),
    change: v.number(),
    note: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "inventory.adjust")
    if (!a.note.trim()) throw new ConvexError("Write a reason for the adjustment")
    await bumpStock(ctx, { variantId: a.variantId, locationId: a.locationId, bucket: a.bucket, change: a.change, reason: "Manual adjustment", note: a.note, byName: me.staff.name })
  },
})

export const listReceipts = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const locs = await ctx.db.query("locations").collect()
    const rows = await ctx.db.query("receipts").withIndex("by_at").order("desc").take(100)
    return rows.map((r) => ({ ...r, locationName: locs.find((l) => l._id === r.locationId)?.name ?? "" }))
  },
})

export const stockLogs = query({
  args: { variantId: v.optional(v.id("variants")) },
  handler: async (ctx, { variantId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = variantId
      ? await ctx.db.query("stockLogs").withIndex("by_variant", (q) => q.eq("variantId", variantId)).order("desc").take(200)
      : await ctx.db.query("stockLogs").withIndex("by_at").order("desc").take(200)
    const locs = await ctx.db.query("locations").collect()
    return await Promise.all(
      rows.map(async (r) => {
        const vr = await ctx.db.get(r.variantId)
        return { ...r, sku: vr?.sku ?? "", locationName: locs.find((l) => l._id === r.locationId)?.name ?? "" }
      }),
    )
  },
})
