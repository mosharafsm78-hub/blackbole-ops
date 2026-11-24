// Stock check: separates the pairs really in hand from fake (test) stock kept so a product can be advertised and
// ordered before it is bought. The team counts the real pairs; the system works out the fake part.
//
//   real = available − virtual          (never below 0)
//
// `available` itself is never changed here, so orders, the website and Pathao behave exactly as before. A stock-in
// (Purchases → receive) raises `available`, which raises real stock by itself: fake pairs turn real with no extra step.
// The revenue-target plan reads real pairs only (targets.ts).
import { v, ConvexError } from "convex/values"
import type { Doc, Id } from "./_generated/dataModel"
import { query, type MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation, mutation } from "./functions"
import { currentStaff, requirePerm } from "./lib"
import { marketingChanged } from "./marketingPush"
import { baseSku, splitVariant } from "./inventoryReport"

export const realOf = (s: { available: number; virtual?: number }) => Math.max(0, s.available - Math.max(0, s.virtual ?? 0))
export const fakeOf = (s: { available: number; virtual?: number }) => Math.min(Math.max(0, s.available), Math.max(0, s.virtual ?? 0))

const PAGE = 30

/** The colour and size of a variant, so a product with two colours doesn't show "44" twice with nothing to tell them apart.
 *  The website colour option wins (variants titled just "44" keep their colour there), then a "Black / 44" style title.
 *  A title's text only counts as a colour next to a numeric size, so letter sizes ("L", "Size: S") never read as colours. */
export function colorAndSize(x: Pick<Doc<"variants">, "title" | "attrs" | "web">): { color: string; size: string } {
  const split = splitVariant(x.title, x.attrs)
  const opts = (x.web?.options ?? {}) as Record<string, unknown>
  const key = Object.keys(opts).find((k) => /colou?r/i.test(k))
  const fromWeb = key && typeof opts[key] === "string" ? (opts[key] as string).trim() : ""
  return { color: fromWeb || (split.size ? split.color : ""), size: split.size || x.title }
}

/** Gives every line of one product a colour label it can be told apart by. The SKU decides which lines belong together
 *  (BB-X-KG-41 and BB-X-KG-42 are one colour), because saved colour names can be missing or wrong. A group shows its
 *  colour name when that name is clear (one name for the whole group, used by no other group); otherwise its SKU code. */
export function labelColors<L extends { color: string; size: string; sku: string }>(lines: L[]): L[] {
  const shoe = lines.every((l) => /^\d{2,3}$/.test(l.size))
  const groupOf = (l: L) => baseSku(l.sku, l.size)
  const groups = new Map<string, L[]>()
  for (const l of lines) groups.set(groupOf(l), [...(groups.get(groupOf(l)) ?? []), l])
  if (!lines.some((l) => l.color) && !(shoe && groups.size > 1)) return lines // one colour (or clothing sizes): leave as it is
  const nameOf = new Map<string, string>()
  for (const [g, ls] of groups) {
    const names = [...new Set(ls.map((l) => l.color))]
    nameOf.set(g, names.length === 1 ? names[0] : "")
  }
  const used = [...nameOf.values()].filter(Boolean)
  const out = lines.map((l) => {
    const g = groupOf(l)
    const name = nameOf.get(g) ?? ""
    const clear = name && used.filter((n) => n === name).length === 1
    return { ...l, color: clear ? name : groups.size > 1 ? (g.split(/[-_ ]/).pop() || g) : name }
  })
  return out.sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.sku.localeCompare(b.sku))
}

export type CheckLine = { variantId: Id<"variants">; locationId: Id<"locations">; locationName: string; title: string; color: string; size: string; sku: string; available: number; fake: number; real: number; counted: boolean; countedBy: string | null; countedAt: number | null }
export type CheckProduct = { productId: Id<"products">; name: string; preOrder: boolean; skipped: boolean; system: number; fake: number; real: number; uncounted: boolean; lines: CheckLine[] }

/** A page of products with their size lines: system stock, counted real pairs and the fake remainder. */
export const list = query({
  args: { search: v.optional(v.string()), filter: v.union(v.literal("all"), v.literal("uncounted"), v.literal("counted"), v.literal("test"), v.literal("real")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { search, filter: chosen, cursor }) => {
    if (!(await currentStaff(ctx))) return null
    // Looking for a particular product must always find it (a brand-new one has no stock yet), whatever tab is open.
    const filter = search?.trim() ? "all" : chosen
    // Searching uses the search index (one page). Browsing walks the products in creation order and keeps going past
    // products that don't match the filter until a page is full, so "Has fake stock" never shows a near-empty page.
    let scan: Doc<"products">[]
    let scanDone: boolean
    let scanCursor: string
    if (search?.trim()) {
      const res = await ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", search.trim())).paginate({ cursor, numItems: PAGE })
      scan = res.page; scanDone = res.isDone; scanCursor = res.continueCursor
    } else {
      const SCAN = filter === "all" ? PAGE : 150
      const after = cursor ? Number(cursor) : null
      scan = await ctx.db.query("products").withIndex("by_creation_time", (q) => (after === null ? q : q.gt("_creationTime", after))).take(SCAN)
      scanDone = scan.length < SCAN; scanCursor = scan.length ? String(scan[scan.length - 1]._creationTime) : ""
    }
    const allLocs = await ctx.db.query("locations").collect()
    const locs = new Map(allLocs.map((l) => [l._id as string, l.name]))
    const home = allLocs.find((l) => l.isDefault && l.active) ?? allLocs.find((l) => l.active && !l.noCourier) // where new test stock goes
    const out: CheckProduct[] = []
    for (const [pi, p] of scan.entries()) {
      if (out.length >= PAGE && !search?.trim()) { scanDone = false; scanCursor = String(scan[pi - 1]._creationTime); break }
      if (p.deletedAt || !p.active) continue
      if (p.stockCheckSkip && filter !== "all") continue // "not needed for now" products only show under All products
      const variants = (await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()).filter((x) => x.active)
      let lines: CheckLine[] = []
      for (const x of variants) {
        const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
        const cs = colorAndSize(x)
        // A size with no stock yet still gets a line at the home warehouse, so test pairs can be added to it.
        if (home && !rows.some((s) => s.locationId === home._id)) {
          lines.push({ variantId: x._id, locationId: home._id, locationName: home.name, title: x.title, ...cs, sku: x.sku, available: 0, fake: 0, real: 0, counted: true, countedBy: null, countedAt: null })
        }
        for (const s of rows) {
          if (s.available <= 0 && !(s.virtual ?? 0)) continue
          lines.push({
            variantId: x._id, locationId: s.locationId, locationName: locs.get(s.locationId as string) ?? "",
            title: x.title, ...cs, sku: x.sku, available: s.available, fake: fakeOf(s), real: realOf(s),
            counted: s.countedAt !== undefined, countedBy: s.countedBy ?? null, countedAt: s.countedAt ?? null,
          })
        }
      }
      if (lines.length === 0) continue
      // Colour by colour, sizes small to large, so the two colours of one product read as two clean blocks.
      lines = labelColors(lines)
      if (filter !== "all" && !lines.some((l) => l.available > 0 || l.fake > 0)) continue // empty products only show under "All"
      const system = lines.reduce((t, l) => t + l.available, 0)
      const fake = lines.reduce((t, l) => t + l.fake, 0)
      const uncounted = lines.some((l) => !l.counted && l.available > 0)
      if (filter === "uncounted" && !uncounted) continue
      if (filter === "counted" && uncounted) continue
      if (filter === "test" && fake === 0) continue
      if (filter === "real" && (uncounted || system - fake <= 0)) continue // counted, with pairs really in hand
      out.push({ productId: p._id, name: p.name, preOrder: !!p.preOrder, skipped: !!p.stockCheckSkip, system, fake, real: system - fake, uncounted, lines })
    }
    return { products: out, isDone: scanDone, cursor: scanCursor }
  },
})

/** How far the count has got, across all stock lines. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentStaff(ctx))) return null
    const rows = (await ctx.db.query("stock").collect()).filter((s) => s.available > 0 || (s.virtual ?? 0) > 0)
    const counted = rows.filter((s) => s.countedAt !== undefined)
    return {
      lines: rows.length,
      counted: counted.length,
      systemPairs: rows.reduce((t, s) => t + Math.max(0, s.available), 0),
      realPairs: rows.reduce((t, s) => t + realOf(s), 0),
      fakePairs: rows.reduce((t, s) => t + fakeOf(s), 0),
    }
  },
})

async function setLine(ctx: any, me: string, variantId: Id<"variants">, locationId: Id<"locations">, real: number, note: string) {
  const row = await ctx.db.query("stock").withIndex("by_variant_location", (q: any) => q.eq("variantId", variantId).eq("locationId", locationId)).unique()
  if (!row) throw new ConvexError("That stock line no longer exists.")
  if (!Number.isInteger(real) || real < 0) throw new ConvexError("Real pairs must be a whole number, zero or more.")
  if (real > row.available) throw new ConvexError(`You counted ${real} but the system shows only ${row.available}. If more pairs are really there, record them with a stock-in or an adjustment first.`)
  const virtual = row.available - real
  const before = fakeOf(row)
  await ctx.db.patch(row._id, { virtual, countedAt: Date.now(), countedBy: me })
  if (virtual !== before) {
    await ctx.db.insert("stockLogs", { variantId, locationId, bucket: "virtual", change: virtual - before, reason: "Stock check", note, byName: me, at: Date.now() })
  }
}

/** Saves the real pairs counted for some lines; the fake part of each is whatever the system shows beyond that. */
export const saveCounts = mutation({
  args: { items: v.array(v.object({ variantId: v.id("variants"), locationId: v.id("locations"), real: v.number() })) },
  handler: async (ctx, { items }) => {
    const me = await requirePerm(ctx, "inventory.adjust")
    if (items.length > 300) throw new ConvexError("Too many lines at once.")
    for (const i of items) await setLine(ctx, me.staff.name, i.variantId, i.locationId, i.real, `Counted ${i.real} real`)
  },
})

/** Whole product: nothing of it is physically in hand (all system stock is test stock), or all of it is real. */
export const markProduct = mutation({
  args: { productId: v.id("products"), mode: v.union(v.literal("test"), v.literal("real")) },
  handler: async (ctx, { productId, mode }) => {
    const me = await requirePerm(ctx, "inventory.adjust")
    const variants = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", productId)).collect()
    for (const x of variants) {
      for (const s of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()) {
        if (s.available <= 0 && !(s.virtual ?? 0)) continue
        await setLine(ctx, me.staff.name, x._id, s.locationId, mode === "test" ? 0 : Math.max(0, s.available), mode === "test" ? "Marked as fake stock — none in hand" : "Marked all real")
      }
    }
  },
})

/** Adds test (fake) pairs: they go into the system stock AND are marked as not in hand in one step, so a product can
 *  be advertised and ordered before it is bought. No counting needed afterwards. */
/** Adds test (fake) pairs: they count as stock (website, Shopify, orders) but are marked "not in hand" here. */
export async function applyTestStock(ctx: MutationCtx, items: { variantId: Id<"variants">; locationId?: Id<"locations">; qty: number }[], byName: string) {
  const locs = await ctx.db.query("locations").collect()
  const home = locs.find((l) => l.isDefault && l.active) ?? locs.find((l) => l.active && !l.noCourier)
  for (const i of items) {
    if (!Number.isInteger(i.qty) || i.qty <= 0 || i.qty > 10000) throw new ConvexError("Fake pairs must be a whole number above zero.")
    const variant = await ctx.db.get(i.variantId)
    if (!variant) throw new ConvexError("That size no longer exists.")
    const locationId = i.locationId ?? home?._id
    if (!locationId) throw new ConvexError("No active warehouse to put fake stock in.")
    const row = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", i.variantId).eq("locationId", locationId)).unique()
    if (row) await ctx.db.patch(row._id, { available: row.available + i.qty, virtual: (row.virtual ?? 0) + i.qty, countedAt: Date.now(), countedBy: byName })
    else await ctx.db.insert("stock", { variantId: i.variantId, locationId, available: i.qty, processing: 0, inTransit: 0, returning: 0, damaged: 0, virtual: i.qty, countedAt: Date.now(), countedBy: byName })
    await marketingChanged(ctx, { variantId: i.variantId })
    await ctx.db.insert("stockLogs", { variantId: i.variantId, locationId, bucket: "available", change: i.qty, reason: "Fake stock added", note: "Fake stock — not in hand", byName, at: Date.now() })
  }
}

export const addTestStock = mutation({
  args: { items: v.array(v.object({ variantId: v.id("variants"), locationId: v.id("locations"), qty: v.number() })) },
  handler: async (ctx, { items }) => {
    const me = await requirePerm(ctx, "inventory.adjust")
    if (items.length === 0 || items.length > 100) throw new ConvexError("Add test pairs to between 1 and 100 sizes at a time.")
    await applyTestStock(ctx, items, me.staff.name)
  },
})


/** Really removes a size: the size itself, its stock in every warehouse, its stock history and Shopify sync marker.
 *  Old orders / purchases keep their own copy of the SKU and name, so history still reads fine. */
async function purgeVariant(ctx: MutationCtx, variantId: Id<"variants">) {
  for (const r of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", variantId)).collect()) await ctx.db.delete(r._id)
  for (const r of await ctx.db.query("stockLogs").withIndex("by_variant", (q) => q.eq("variantId", variantId)).collect()) await ctx.db.delete(r._id)
  for (const r of await ctx.db.query("shopifyDirty").withIndex("by_variant", (q) => q.eq("variantId", variantId)).collect()) await ctx.db.delete(r._id)
  await ctx.db.delete(variantId)
}
async function openOrderWith(ctx: MutationCtx, ids: Set<string>) {
  for (const st of ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship"] as const) {
    const open = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st)).collect()
    const hit = open.find((o) => !o.deletedAt && o.items.some((i: any) => i.variantId && ids.has(i.variantId as string)))
    if (hit) return hit.invoiceCode ?? `BB-${hit.invoiceNo}`
  }
  return null
}

/** "Not needed for now": hides the product from the Not counted / Test stock lists (it stays under All products), or brings it back. */
export const skipProduct = mutation({
  args: { productId: v.id("products"), skip: v.boolean() },
  handler: async (ctx, { productId, skip }) => {
    await requirePerm(ctx, "inventory.adjust")
    const p = await ctx.db.get(productId)
    if (!p || p.deletedAt) throw new ConvexError("Product not found")
    await ctx.db.patch(productId, { stockCheckSkip: skip || undefined })
  },
})

/** Deletes a product for good: the product, every size, all their stock and history. Refused while an open order has it. */
export const deleteProduct = mutation({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const me = await requirePerm(ctx, "products.manage")
    const p = await ctx.db.get(productId)
    if (!p) throw new ConvexError("Product not found")
    const variants = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", productId)).collect()
    const open = await openOrderWith(ctx, new Set(variants.map((x) => x._id as string)))
    if (open) throw new ConvexError(`Can't delete: an open order (${open}) still has this product. Finish or cancel it first.`)
    await ctx.db.insert("archive", { table: "products", data: { name: p.name, handle: p.handle, skus: variants.map((x) => x.sku) }, reason: "Deleted from Stock check", byName: me.staff.name, at: Date.now() })
    await ctx.scheduler.runAfter(0, internal.shopifyProducts.remove, { handle: p.handle, skus: variants.map((x) => x.sku), whole: true })
    for (const x of variants) await purgeVariant(ctx, x._id)
    if (p.handle) for (const c of await ctx.db.query("webCollections").collect()) if (c.productHandles.includes(p.handle)) await ctx.db.patch(c._id, { productHandles: c.productHandles.filter((h) => h !== p.handle), updatedAt: Date.now() })
    await ctx.db.delete(productId)
    await ctx.scheduler.runAfter(0, internal.website.queueRebuildInternal, {})
  },
})

/** Deletes ONE size for good (all its warehouses). Refused while an open order has it, and for the last size left. */
export const deleteSize = mutation({
  args: { variantId: v.id("variants") },
  handler: async (ctx, { variantId }) => {
    const me = await requirePerm(ctx, "products.manage")
    const x = await ctx.db.get(variantId)
    if (!x) throw new ConvexError("Size not found")
    const siblings = (await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", x.productId)).collect()).filter((y) => y.active && y._id !== variantId)
    if (siblings.length === 0) throw new ConvexError("This is the only size left. Delete the whole product instead.")
    const open = await openOrderWith(ctx, new Set([variantId as string]))
    if (open) throw new ConvexError(`Can't delete size ${x.title}: an open order (${open}) still has it. Finish or cancel it first.`)
    await ctx.db.insert("archive", { table: "variants", data: { sku: x.sku, title: x.title, productId: x.productId }, reason: "Size deleted from Stock check", byName: me.staff.name, at: Date.now() })
    const parent = await ctx.db.get(x.productId)
    await ctx.scheduler.runAfter(0, internal.shopifyProducts.remove, { handle: parent?.handle, skus: [x.sku], whole: false })
    await purgeVariant(ctx, variantId)
    await ctx.scheduler.runAfter(0, internal.website.queueRebuildInternal, {})
  },
})

/** Removes the empty, switched-off "WEB-<id>" placeholder sizes of one product (left over from the website import once the real SKUs were set).
 *  Only sizes that are inactive, have a WEB- SKU and hold no stock are touched. Safe to re-run. */
export const purgePlaceholders = internalMutation({
  args: { productMatch: v.string() },
  handler: async (ctx, { productMatch }) => {
    const prods = (await ctx.db.query("products").collect()).filter((p) => p.name.toLowerCase().includes(productMatch.toLowerCase()))
    let purged = 0, kept = 0
    for (const p of prods) {
      for (const x of await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()) {
        if (x.active || !/^WEB-/i.test(x.sku)) continue
        const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
        if (rows.some((r) => r.available || r.processing || r.inTransit || r.returning || r.damaged)) { kept++; continue }
        await purgeVariant(ctx, x._id); purged++
      }
    }
    return { purged, kept }
  },
})

/** One-time clean-up for the Inventory page: really removes every size that was deleted earlier (switched off, an old
 *  "-DELETED" SKU, or belonging to a deleted product) and holds no stock. Sizes still holding stock are left alone. */
export const purgeRetired = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "products.manage")
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    let purged = 0, kept = 0, more = false
    for (const x of await ctx.db.query("variants").collect()) {
      const p = products.get(x.productId as string)
      if (x.active && !/-DELETED$/i.test(x.sku) && p && !p.deletedAt) continue
      const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
      if (rows.some((r) => r.available || r.processing || r.inTransit || r.returning || r.damaged)) { kept++; continue }
      if (purged >= 400) { more = true; break }
      await purgeVariant(ctx, x._id); purged++
    }
    for (const p of products.values()) {
      if (!p.deletedAt) continue
      if (!(await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).first())) await ctx.db.delete(p._id)
    }
    return { purged, kept, more }
  },
})

/** "Everything not counted yet is real": every stock line nobody has counted is marked as counted with all pairs real.
 *  Lines already counted (and the test pairs on them) are left exactly as they are. Done in chunks; `more` = run again. */
export const markUncountedReal = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requirePerm(ctx, "inventory.adjust")
    let done = 0, more = false
    const rows = await ctx.db.query("stock").collect()
    for (const s of rows) {
      if (s.countedAt !== undefined || s.available <= 0) continue
      if (done >= 400) { more = true; break }
      await setLine(ctx, me.staff.name, s.variantId, s.locationId, s.available, "Marked all real (team updated the stock)")
      done++
    }
    return { done, more }
  },
})

/** One-time: set the saved colour of every active variant whose SKU starts with a prefix (e.g. "BB-SN-BBSFN-MB-" →
 *  "Mocha Brown"). Only the colour option changes; size, stock, prices and Shopify are left alone. Safe to re-run. */
export const setColorBySku = internalMutation({
  args: { items: v.array(v.object({ skuPrefix: v.string(), color: v.string() })) },
  handler: async (ctx, { items }) => {
    let changed = 0
    for (const { skuPrefix, color } of items) {
      if (skuPrefix.length < 6 || !color.trim()) throw new ConvexError("A SKU prefix of 6+ characters and a colour are needed")
      const rows = await ctx.db.query("variants").withIndex("by_sku", (q) => q.gte("sku", skuPrefix).lt("sku", `${skuPrefix}￿`)).collect()
      for (const x of rows) {
        if (!x.active) continue
        const web = (x.web ?? {}) as Record<string, any>
        const opts = { ...((web.options ?? {}) as Record<string, string>) }
        const key = Object.keys(opts).find((k) => /colou?r/i.test(k)) ?? "Color"
        if (opts[key] === color.trim()) continue
        opts[key] = color.trim()
        await ctx.db.patch(x._id, { web: { ...web, options: opts } })
        changed++
      }
    }
    return { changed }
  },
})

/** One-time: creates a product with sizes and fake (not-in-hand) stock in the default warehouse. Safe to re-run: skips if the product name already exists. */
export const createProductWithFakeStock = internalMutation({
  args: { name: v.string(), imageUrl: v.optional(v.string()), color: v.string(), skuPrefix: v.string(), sizes: v.array(v.string()), price: v.number(), weightKg: v.number(), fakeQty: v.number() },
  handler: async (ctx, a) => {
    const exists = (await ctx.db.query("products").collect()).find((p) => !p.deletedAt && p.name.trim().toLowerCase() === a.name.trim().toLowerCase())
    if (exists) return { skipped: true }
    const productId = await ctx.db.insert("products", { name: a.name.trim(), imageUrl: a.imageUrl, active: true, createdAt: Date.now() })
    const items: { variantId: Id<"variants">; qty: number }[] = []
    for (const size of a.sizes) {
      const sku = `${a.skuPrefix}-${size}`.toUpperCase()
      if (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()) throw new ConvexError(`SKU ${sku} already exists`)
      const id = await ctx.db.insert("variants", { productId, sku, title: `${a.color} / ${size}`, attrs: `${a.color} / ${size}`, weightKg: a.weightKg, price: a.price, purchasePrice: 0, active: true, createdAt: Date.now() })
      items.push({ variantId: id, qty: a.fakeQty })
    }
    await applyTestStock(ctx, items, "Import")
    return { skipped: false, variants: items.length }
  },
})

/** One-time: fills description + key features of a product found by exact name. */
export const setProductCopy = internalMutation({
  args: { name: v.string(), description: v.string(), features: v.array(v.string()) },
  handler: async (ctx, a) => {
    const p = (await ctx.db.query("products").collect()).find((x) => !x.deletedAt && x.name.trim().toLowerCase() === a.name.trim().toLowerCase())
    if (!p) throw new ConvexError("Product not found")
    await ctx.db.patch(p._id, { description: a.description, features: a.features })
    return { ok: true }
  },
})
