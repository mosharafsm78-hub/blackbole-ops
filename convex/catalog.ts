import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { bumpStock, currentStaff, nextCounter, receiveAvailable, requirePerm } from "./lib"
import { COMMITTED_STATUSES } from "./rules"

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
          _id: vr._id, productId: vr.productId, sku: vr.sku, title: vr.title, attrs: vr.attrs, price: vr.price, purchasePrice: vr.purchasePrice,
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
    // which warehouses hold this product (any stock in any bucket), with their available count
    const locName = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
    const whOf = new Map<string, { name: string; available: number }[]>()
    for (const r of (locationId
      ? await ctx.db.query("stock").withIndex("by_location", (q) => q.eq("locationId", locationId)).collect()
      : await ctx.db.query("stock").collect())) {
      if (!r.available && !r.processing && !r.inTransit && !r.returning && !r.damaged) continue
      const list = whOf.get(r.variantId) ?? []
      list.push({ name: locName.get(r.locationId) ?? "Warehouse", available: r.available })
      whOf.set(r.variantId, list)
    }
    const rows = variants.map((vr) => {
      const st = stock.get(vr._id) ?? emptySum()
      const p = pmap.get(vr.productId)
      return {
        wh: (whOf.get(vr._id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
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
      await receiveAvailable(ctx, { variantId: i.variantId, locationId: a.locationId, qty: i.qty, reason: `Stock in GRN-${code}`, byName: me.staff.name, receiptId })
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
  args: { variantId: v.optional(v.id("variants")), locationId: v.optional(v.id("locations")) },
  handler: async (ctx, { variantId, locationId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = variantId
      ? (await ctx.db.query("stockLogs").withIndex("by_variant", (q) => q.eq("variantId", variantId)).order("desc").take(400)).filter((r) => !locationId || r.locationId === locationId).slice(0, 200)
      : locationId
        ? await ctx.db.query("stockLogs").withIndex("by_location", (q) => q.eq("locationId", locationId)).order("desc").take(200)
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

/** Internal product page (Nuport-style): one product with its size variants, live stock per size, and the
 *  bulleted features. Read-only. Powers the Order View line-item link so a CX agent can check stock and
 *  product details without leaving Ops. Additive — reads existing tables only, changes nothing.
 *
 *  Accepts any of: a product id, a variant id, or an SKU. Older order line items often carry only a SKU
 *  (no variantId), so the SKU path keeps those links working instead of falling back to the catalog. */
export const productDetail = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const product = await findProduct(ctx, id)
    if (!product) return null
    const productId = product._id
    const variants = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", productId)).collect()
    const stock = await stockByVariant(ctx)
    const locations = await ctx.db.query("locations").collect()
    const locById = new Map(locations.map((l) => [l._id as string, l]))
    // Every ACTIVE warehouse is listed for every size, even when it has no stock row for that size — a row
    // that is simply absent would otherwise look like "we don't know", when the truth is 0. Default warehouse
    // first, then alphabetical, so the table reads the same on every product page.
    const activeLocs = locations
      .filter((l) => l.active)
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
    const variantIds = new Set(variants.map((v) => v._id as string))
    // Older line items carry only a SKU — map it back to the variant so their units still land on the right size.
    const variantBySku = new Map(variants.map((v) => [v.sku.trim().toUpperCase(), v._id as string]))

    // Committed = units on orders that have not shipped yet, per variant AND per warehouse. Read from live
    // orders rather than the `stock.processing` bucket: Pending and On Hold sit in `available` (STATUS_BUCKET),
    // so the bucket alone would miss every unapproved order. Mirrors inventoryReport.summary so the two pages
    // always agree on the same number.
    const committedByVariant = new Map<string, number>()
    const committedByLoc = new Map<string, Map<string, number>>() // variantId -> locationId -> qty
    for (const status of COMMITTED_STATUSES) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", status)).collect()
      for (const o of rows) {
        if (o.deletedAt) continue
        for (const i of o.items) {
          const vid = i.variantId ? (i.variantId as string) : variantBySku.get((i.sku ?? "").trim().toUpperCase())
          if (!vid || !variantIds.has(vid)) continue
          committedByVariant.set(vid, (committedByVariant.get(vid) ?? 0) + i.qty)
          const perLoc = committedByLoc.get(vid) ?? new Map<string, number>()
          const lid = o.locationId as string
          perLoc.set(lid, (perLoc.get(lid) ?? 0) + i.qty)
          committedByLoc.set(vid, perLoc)
        }
      }
    }

    type Wh = { locationId: string; locationName: string; available: number; committed: number; inTransit: number; returning: number; active: boolean; isDefault: boolean }
    const byVariant = new Map<string, Map<string, Wh>>()
    const seed = (variantId: string) => {
      let m = byVariant.get(variantId)
      if (!m) {
        m = new Map()
        for (const l of activeLocs) {
          m.set(l._id as string, { locationId: l._id as string, locationName: l.name, available: 0, committed: 0, inTransit: 0, returning: 0, active: true, isDefault: !!l.isDefault })
        }
        byVariant.set(variantId, m)
      }
      return m
    }
    // Seed every size up front, so a size with no stock rows at all still lists each active warehouse at 0
    // (rather than rendering as "no warehouse rows", which reads as "unknown").
    for (const v of variants) seed(v._id as string)
    for (const r of await ctx.db.query("stock").collect()) {
      if (!variantIds.has(r.variantId as string)) continue
      const loc = locById.get(r.locationId as string)
      const m = seed(r.variantId as string)
      const row = m.get(r.locationId as string)
      if (row) {
        row.available = r.available
        row.inTransit = r.inTransit
        row.returning = r.returning
      } else {
        // Stock sitting in a warehouse that has since been deactivated — keep it visible (flagged) rather
        // than silently dropping real inventory off the page.
        m.set(r.locationId as string, {
          locationId: r.locationId as string, locationName: loc?.name ?? "Warehouse",
          available: r.available, committed: 0, inTransit: r.inTransit, returning: r.returning,
          active: false, isDefault: !!loc?.isDefault,
        })
      }
    }
    // Committed units can sit at a warehouse that has no stock row at all (nothing ever received there), so
    // add those rows too — otherwise the table would not add up to the Committed card above it.
    for (const [vid, perLoc] of committedByLoc) {
      const m = seed(vid)
      for (const [lid, qty] of perLoc) {
        const row = m.get(lid)
        if (row) { row.committed = qty; continue }
        const loc = locById.get(lid)
        m.set(lid, {
          locationId: lid, locationName: loc?.name ?? "Warehouse",
          available: 0, committed: qty, inTransit: 0, returning: 0,
          active: !!loc?.active, isDefault: !!loc?.isDefault,
        })
      }
    }
    return {
      _id: product._id,
      name: product.name,
      category: product.category ?? "",
      description: product.description ?? "",
      imageUrl: product.imageUrl,
      active: product.active,
      features: product.features ?? [],
      variants: variants
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
        .map((vr) => {
          const sum = stock.get(vr._id) ?? emptySum()
          return {
            _id: vr._id,
            sku: vr.sku,
            title: vr.title,
            attrs: vr.attrs,
            price: vr.price,
            purchasePrice: vr.purchasePrice,
            active: vr.active,
            stock: sum,
            // The four headline metrics, in the order the Operations Director specified. `returning` is the
            // stock bucket fed by `pending_returned` only — already-`returned` units have rolled back into
            // `available`, so they are never counted twice.
            metrics: {
              available: sum.available,
              committed: committedByVariant.get(vr._id as string) ?? 0,
              inTransit: sum.inTransit,
              returning: sum.returning,
            },
            warehouses: [...(byVariant.get(vr._id as string)?.values() ?? [])]
              .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.active) - Number(a.active) || a.locationName.localeCompare(b.locationName)),
          }
        }),
    }
  },
})

/** Resolve a free-form string to a product: product id first, then variant id, then SKU.
 *
 *  A cast id is not a table check — Convex can hand back a document from ANY table for a given id, so each
 *  result is validated by SHAPE (a product has `name`; a variant has `productId`) instead of trusting the
 *  generic. Without this, a variant id resolved "successfully" to a variant row and the page rendered a
 *  nameless product. A malformed id makes db.get throw, so each lookup is guarded. */
async function findProduct(ctx: any, id: string): Promise<Doc<"products"> | null> {
  const raw = (id ?? "").trim()
  if (!raw) return null
  const isProduct = (d: any): Doc<"products"> | null =>
    d && typeof d.name === "string" && d.productId === undefined ? d : null
  const isVariant = (d: any): Doc<"variants"> | null =>
    d && d.productId !== undefined && typeof d.sku === "string" ? d : null

  let doc: any = null
  try { doc = await ctx.db.get(raw as any) } catch { doc = null }
  const direct = isProduct(doc)
  if (direct) return direct
  const vr = isVariant(doc)
  if (vr) {
    const owner: Doc<"products"> | null = await ctx.db.get(vr.productId)
    return isProduct(owner)
  }
  // Older line items only carry the SKU — look the variant up by SKU and hop to its product.
  const bySku = await ctx.db.query("variants").withIndex("by_sku", (q: any) => q.eq("sku", raw)).first()
  if (bySku) {
    const owner: Doc<"products"> | null = await ctx.db.get(bySku.productId)
    return isProduct(owner)
  }
  return null
}

/** Link target for an order line item. Resolves in priority order — explicit productId, then the line's
 *  variantId, then the SKU — and returns both the id to put in `/products/$productId` and which rule won,
 *  so the UI can open the exact size and tests can prove the fallback. One batched call per Order View,
 *  never one per row. Read-only. */
export const resolveProductLinks = query({
  args: {
    items: v.array(v.object({
      productId: v.optional(v.string()),
      variantId: v.optional(v.string()),
      sku: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { items }) => {
    const s = await currentStaff(ctx)
    if (!s) return items.map(() => null)
    // Batch the lookups once for the whole page instead of once per line item.
    const products = new Map<string, Doc<"products">>()
    for (const p of await ctx.db.query("products").collect()) products.set(p._id as string, p)
    const variants = new Map<string, Doc<"variants">>()
    for (const vr of await ctx.db.query("variants").collect()) variants.set(vr._id as string, vr)
    const bySku = new Map<string, Doc<"variants">>()
    for (const vr of variants.values()) bySku.set(vr.sku.trim().toLowerCase(), vr)

    return items.map((item) => {
      const pid = item.productId?.trim()
      if (pid && products.has(pid)) return { id: pid, via: "productId" as const }
      const vid = item.variantId?.trim()
      if (vid && variants.has(vid)) return { id: vid, via: "variantId" as const }
      const sku = item.sku?.trim().toLowerCase()
      if (sku) {
        const vr = bySku.get(sku)
        if (vr) return { id: vr._id as string, via: "sku" as const }
      }
      return null
    })
  },
})

/** Save the bulleted features shown on the internal product page. Additive field only — never touches
 *  variants, prices or stock, so live operational data is unaffected. */
export const saveProductFeatures = mutation({
  args: { productId: v.id("products"), features: v.array(v.string()) },
  handler: async (ctx, { productId, features }) => {
    await requirePerm(ctx, "products.manage")
    const product = await ctx.db.get(productId)
    if (!product) throw new ConvexError("Product not found")
    const clean = features.map((f) => f.trim()).filter(Boolean)
    await ctx.db.patch(productId, { features: clean.length ? clean : undefined })
    return productId
  },
})
