// Ops → Shopify product sync. When a product is saved on the Website page, its title, description, vendor, type,
// tags, SEO and each size's price / compare-at price are copied to the same product in Shopify (found by its URL
// handle, then by SKU). Best effort: if Shopify is not connected or the product is not there, nothing happens
// and the reason is kept for Settings. Status, handle and images are never touched.
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation } from "./functions"
import { getSetting, setSetting } from "./lib"
import { shopifyGql } from "./shopifyStock"
import { webPrice, normSku } from "./website"

export const forSync = internalQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const p = await ctx.db.get(productId)
    if (!p || p.deletedAt) return null
    const vs = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", productId)).collect()
    return {
      handle: p.handle as string | undefined,
      web: p.web ?? null,
      name: p.name as string,
      variants: vs.filter((x: any) => !x.deletedAt).map((x: any) => ({ sku: x.sku as string, price: webPrice(x), compareAt: typeof x.web?.compareAt === "number" && x.web.compareAt > 0 ? Math.round(x.web.compareAt) : null })),
    }
  },
})
export const note = internalMutation({
  args: { error: v.union(v.string(), v.null()) },
  handler: async (ctx, { error }) => { await setSetting(ctx, "shopifyProductSync", { at: Date.now(), error }) },
})
export const isOn = internalQuery({ args: {}, handler: async (ctx) => !!(await getSetting<any>(ctx, "shopifyApi"))?.on })

export const push = internalAction({
  args: { productId: v.id("products"), oldHandle: v.optional(v.string()) },
  handler: async (ctx, { productId, oldHandle }) => {
    if (!(await ctx.runQuery(internal.shopifyProducts.isOn, {}))) return
    const d = await ctx.runQuery(internal.shopifyProducts.forSync, { productId })
    if (!d || !d.web) return
    try {
      let found: any = null
      for (const h of [d.handle, oldHandle].filter(Boolean) as string[]) {
        const r = await shopifyGql(ctx, `query($q:String!){ products(first:1, query:$q){ nodes { id handle variants(first:100){ nodes { id sku } } } } }`, { q: `handle:${h}` })
        if (r.products.nodes[0]) { found = r.products.nodes[0]; break }
      }
      if (!found) { await ctx.runMutation(internal.shopifyProducts.note, { error: null }); return } // not on Shopify: nothing to update
      const w = d.web
      const u = await shopifyGql(ctx, `mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ userErrors{ field message } } }`, {
        p: { id: found.id, title: w.title || d.name, descriptionHtml: w.html ?? "", vendor: w.vendor ?? "", productType: w.type ?? "", tags: w.tags ?? [], seo: { title: w.seo?.title ?? "", description: w.seo?.description ?? "" } },
      })
      const e1 = u.productUpdate.userErrors
      if (e1?.length) throw new Error(e1.map((e: any) => e.message).join("; "))
      const bySku = new Map(d.variants.map((x: any) => [normSku(x.sku), x]))
      const upd = found.variants.nodes.map((n: any) => { const m: any = bySku.get(normSku(n.sku)); return m ? { id: n.id, price: String(m.price), compareAtPrice: m.compareAt ? String(m.compareAt) : null } : null }).filter(Boolean)
      if (upd.length) {
        const r = await shopifyGql(ctx, `mutation($id:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$id, variants:$v){ userErrors{ field message } } }`, { id: found.id, v: upd })
        const e2 = r.productVariantsBulkUpdate.userErrors
        if (e2?.length) throw new Error(e2.map((e: any) => e.message).join("; "))
      }
      await ctx.runMutation(internal.shopifyProducts.note, { error: null })
    } catch (e: any) {
      await ctx.runMutation(internal.shopifyProducts.note, { error: String(e?.message ?? e).slice(0, 400) })
    }
  },
})
