// One-time repair: Shopify's price is the true selling price. Lists every size whose Ops price differs from
// Shopify (matched by SKU), then copies the Shopify price into Ops. Shopify is never changed here.
import { v, ConvexError } from "convex/values"
import { action, internalQuery, internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { shopifyGql } from "./shopifyStock"
import { normSku } from "./website"
import { isPreOrderSku } from "./rules"
import { bumpStock } from "./lib"

export type PriceDiff = { sku: string; product: string; ops: number; shopify: number }
export type Missing = { sku: string; product: string; title: string; price: number; status: string; type: string; image: string; qty: number; loc: string }

export const opsVariants = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: { id: string; sku: string; product: string; price: number }[] = []
    const names = new Map<string, string>()
    for (const x of await ctx.db.query("variants").collect()) {
      if ((x as any).deletedAt) continue
      const k = String(x.productId)
      if (!names.has(k)) names.set(k, (await ctx.db.get(x.productId))?.name ?? "")
      out.push({ id: String(x._id), sku: x.sku, product: names.get(k) ?? "", price: x.price })
    }
    return out
  },
})

export const addVariants = internalMutation({
  args: { rows: v.array(v.object({ sku: v.string(), product: v.string(), title: v.string(), price: v.number(), type: v.string(), image: v.string(), qty: v.number(), loc: v.string() })) },
  handler: async (ctx, { rows }) => {
    let created = 0
    const locs = (await ctx.db.query("locations").collect()).filter((l: any) => l.active && l.shopifyLocationId && !l.noCourier)
    const PO_PRICE = 500 // Ops convention for pre-order sizes (booking price); Shopify holds the 200 deposit price
    const pids = new Map<string, any>()
    for (const r of rows) {
      const sku = normSku(r.sku)
      if (!sku || (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first())) continue // never duplicate
      let pid = pids.get(r.product)
      if (!pid) {
        const found = (await ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", r.product)).take(5)).find((p) => p.name === r.product && !p.deletedAt)
        const po = isPreOrderSku(sku)
        pid = found?._id ?? (await ctx.db.insert("products", { name: r.product, category: r.type || undefined, imageUrl: r.image || undefined, active: true, createdAt: Date.now(), ...(po ? { preOrder: true, preOrderFrom: "china" as const } : {}) }))
        pids.set(r.product, pid)
      }
      const variantId = await ctx.db.insert("variants", { productId: pid, sku, title: r.title || "Default", weightKg: 0.5, price: isPreOrderSku(sku) ? PO_PRICE : r.price, purchasePrice: 0, active: true, createdAt: Date.now() })
      // regular sizes: start Ops with the stock Shopify already shows, so the live stock sync keeps the same number
      const loc = locs.find((l: any) => l.shopifyLocationId === r.loc)
      if (!isPreOrderSku(sku) && loc && r.qty > 0) await bumpStock(ctx, { variantId, locationId: loc._id, bucket: "available", change: r.qty, reason: "Opening stock (from Shopify)", byName: "Shopify import" })
      created++
    }
    return created
  },
})

export const setPrices = internalMutation({
  args: { rows: v.array(v.object({ id: v.string(), price: v.number() })) },
  handler: async (ctx, { rows }) => {
    let n = 0
    for (const r of rows) {
      const id = ctx.db.normalizeId("variants", r.id)
      if (!id || !(r.price > 0)) continue
      await ctx.db.patch(id, { price: r.price })
      n++
    }
    return n
  },
})

async function diffs(ctx: any): Promise<{ diffs: (PriceDiff & { id: string })[]; checked: number; notInShopify: number; missing: Missing[] }> {
  const shop = new Map<string, number>()
  const info = new Map<string, Missing>()
  let after: string | null = null
  for (let page = 0; page < 60; page++) {
    const d: any = await shopifyGql(ctx, `query($after:String){ productVariants(first:200, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ sku price title inventoryItem{ inventoryLevels(first:1){ nodes{ location{ id } quantities(names:["available"]){ quantity } } } } product{ title status productType featuredImage{ url } } } } }`, { after })
    for (const n of d.productVariants.nodes) if (normSku(n.sku)) {
      shop.set(normSku(n.sku), Math.round(Number(n.price)))
      info.set(normSku(n.sku), { sku: normSku(n.sku), product: n.product?.title ?? "", title: n.title ?? "", price: Math.round(Number(n.price)), status: n.product?.status ?? "", type: n.product?.productType ?? "", image: n.product?.featuredImage?.url ?? "", qty: Math.max(0, n.inventoryItem?.inventoryLevels?.nodes?.[0]?.quantities?.[0]?.quantity ?? 0), loc: n.inventoryItem?.inventoryLevels?.nodes?.[0]?.location?.id ?? "" })
    }
    if (!d.productVariants.pageInfo.hasNextPage) break
    after = d.productVariants.pageInfo.endCursor
  }
  const ops: any[] = await ctx.runQuery(internal.priceAlign.opsVariants, {})
  const have = new Set(ops.map((o) => normSku(o.sku)))
  const missing = [...info.values()].filter((m) => !have.has(m.sku)).sort((a, b) => a.product.localeCompare(b.product) || a.sku.localeCompare(b.sku))
  const out: (PriceDiff & { id: string })[] = []
  let notIn = 0
  for (const o of ops) {
    const s = shop.get(normSku(o.sku))
    if (s === undefined) { notIn++; continue }
    if (isPreOrderSku(o.sku)) continue // pre-order SKUs (PO-…) carry their own booking price in Shopify; never touched here
    if (s > 0 && Math.round(o.price) !== s) out.push({ id: o.id, sku: o.sku, product: o.product, ops: o.price, shopify: s })
  }
  return { diffs: out.sort((a, b) => a.product.localeCompare(b.product) || a.sku.localeCompare(b.sku)), checked: ops.length - notIn, notInShopify: notIn, missing }
}

/** Settings button 1: list the differences (changes nothing). */
export const compare = action({
  args: {},
  handler: async (ctx): Promise<{ diffs: PriceDiff[]; checked: number; notInShopify: number; missing: Missing[] }> => {
    if (!(await ctx.runQuery(internal.shopifyStock.isAdmin, {}))) throw new ConvexError("Not allowed")
    try { return await diffs(ctx) } catch (e: any) { throw new ConvexError(String(e?.message ?? e)) }
  },
})

/** Settings button 2: copy Shopify's price into Ops for every size that differs (re-checks first, so it is always current). */
export const applyShopifyPrices = action({
  args: {},
  handler: async (ctx): Promise<{ updated: number }> => {
    if (!(await ctx.runQuery(internal.shopifyStock.isAdmin, {}))) throw new ConvexError("Not allowed")
    try {
      const d = await diffs(ctx)
      let updated = 0
      for (let i = 0; i < d.diffs.length; i += 100) {
        updated += await ctx.runMutation(internal.priceAlign.setPrices, { rows: d.diffs.slice(i, i + 100).map((x) => ({ id: x.id, price: x.shopify })) })
      }
      return { updated }
    } catch (e: any) { throw new ConvexError(String(e?.message ?? e)) }
  },
})

/** Create in Ops the sizes that exist in Shopify (ACTIVE products only) but not in Ops. Price = Shopify price, stock 0, cost 0 (fill in later). */
export const addMissing = action({
  args: {},
  handler: async (ctx): Promise<{ created: number }> => {
    if (!(await ctx.runQuery(internal.shopifyStock.isAdmin, {}))) throw new ConvexError("Not allowed")
    try {
      const d = await diffs(ctx)
      const rows = d.missing.filter((m) => m.status === "ACTIVE")
      let created = 0
      for (let i = 0; i < rows.length; i += 100) created += await ctx.runMutation(internal.priceAlign.addVariants, { rows: rows.slice(i, i + 100).map(({ status, ...r }) => r) })
      return { created }
    } catch (e: any) { throw new ConvexError(String(e?.message ?? e)) }
  },
})
