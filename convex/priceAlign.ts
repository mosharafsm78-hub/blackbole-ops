// One-time repair: Shopify's price is the true selling price. Lists every size whose Ops price differs from
// Shopify (matched by SKU), then copies the Shopify price into Ops. Shopify is never changed here.
import { v, ConvexError } from "convex/values"
import { action, internalQuery, internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { shopifyGql } from "./shopifyStock"
import { normSku } from "./website"

export type PriceDiff = { sku: string; product: string; ops: number; shopify: number }

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

async function diffs(ctx: any): Promise<{ diffs: (PriceDiff & { id: string })[]; checked: number; notInShopify: number }> {
  const shop = new Map<string, number>()
  let after: string | null = null
  for (let page = 0; page < 60; page++) {
    const d: any = await shopifyGql(ctx, `query($after:String){ productVariants(first:200, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ sku price } } }`, { after })
    for (const n of d.productVariants.nodes) if (normSku(n.sku)) shop.set(normSku(n.sku), Math.round(Number(n.price)))
    if (!d.productVariants.pageInfo.hasNextPage) break
    after = d.productVariants.pageInfo.endCursor
  }
  const ops: any[] = await ctx.runQuery(internal.priceAlign.opsVariants, {})
  const out: (PriceDiff & { id: string })[] = []
  let notIn = 0
  for (const o of ops) {
    const s = shop.get(normSku(o.sku))
    if (s === undefined) { notIn++; continue }
    if (s > 0 && Math.round(o.price) !== s) out.push({ id: o.id, sku: o.sku, product: o.product, ops: o.price, shopify: s })
  }
  return { diffs: out.sort((a, b) => a.product.localeCompare(b.product) || a.sku.localeCompare(b.sku)), checked: ops.length - notIn, notInShopify: notIn }
}

/** Settings button 1: list the differences (changes nothing). */
export const compare = action({
  args: {},
  handler: async (ctx): Promise<{ diffs: PriceDiff[]; checked: number; notInShopify: number }> => {
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
