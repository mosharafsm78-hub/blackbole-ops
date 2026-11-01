// Marketing OS clearance codes (LASTPAIRS10 …) → the live Shopify store, where checkout actually checks codes.
// Ops keeps its own discounts table; this makes the same product-scoped percent code exist in Shopify too.
// Runs right after Marketing OS asks for a code, and every hour for any active code still missing or changed.
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { shopifyGql } from "./shopifyStock"

export const activeMarketingCodes = internalQuery({
  args: { code: v.optional(v.string()) },
  handler: async (ctx, { code }) => {
    const now = Date.now()
    return (await ctx.db.query("discounts").collect())
      .filter((d) => d.active && d.kind === "products" && d.type === "percent" && /^LASTPAIRS\d+$/.test(d.code) && (!d.endsAt || d.endsAt > now) && (!code || d.code === code))
      .map((d) => ({ code: d.code, title: d.title ?? "Clearance", percent: d.value, handles: d.items, endsAt: d.endsAt ?? null }))
  },
})

/** Shopify product ids for website handles (Shopify search: handle:a OR handle:b). */
async function productIds(ctx: any, handles: string[]): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < handles.length; i += 25) {
    const part = handles.slice(i, i + 25)
    const r: any = await shopifyGql(ctx, `query($q:String){ products(first:50, query:$q){ nodes { id handle } } }`, { q: part.map((h) => `handle:${h}`).join(" OR ") })
    for (const n of r.products?.nodes ?? []) if (part.includes(n.handle)) ids.push(n.id)
  }
  return ids
}

export async function ensureShopifyCode(ctx: any, d: { code: string; title: string; percent: number; handles: string[]; endsAt: number | null }): Promise<{ ok: boolean; error?: string; products: number }> {
  const ids = await productIds(ctx, d.handles)
  if (!ids.length) return { ok: false, error: "none of the products were found in Shopify", products: 0 }
  const base = {
    title: `${d.title} (${d.code})`, startsAt: new Date().toISOString(), endsAt: d.endsAt ? new Date(d.endsAt).toISOString() : null,
    context: { all: "ALL" }, appliesOncePerCustomer: false,
    customerGets: { value: { percentage: d.percent / 100 }, items: { products: { productsToAdd: ids } } },
    combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true },
  }
  const found: any = await shopifyGql(ctx, `query($c:String!){ codeDiscountNodeByCode(code:$c){ id } }`, { c: d.code })
  const existing = found.codeDiscountNodeByCode?.id as string | undefined
  let errs: any[] = []
  if (existing) {
    // replace the product list (remove what is there, add the current products)
    const r: any = await shopifyGql(ctx, `mutation($id:ID!, $input: DiscountCodeBasicInput!){ discountCodeBasicUpdate(id:$id, basicCodeDiscount:$input){ userErrors { field message } } }`, { id: existing, input: { ...base, startsAt: undefined } })
    errs = r.discountCodeBasicUpdate.userErrors ?? []
  } else {
    const r: any = await shopifyGql(ctx, `mutation($input: DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$input){ codeDiscountNode { id } userErrors { field message } } }`, { input: { ...base, code: d.code } })
    errs = r.discountCodeBasicCreate.userErrors ?? []
  }
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; "), products: ids.length } : { ok: true, products: ids.length }
}

/** Every hour (and right after a new code): make sure each active clearance code works at the Shopify checkout. */
export const syncAll = internalAction({
  args: { code: v.optional(v.string()) },
  handler: async (ctx, { code }) => {
    const out: Record<string, string> = {}
    for (const d of await ctx.runQuery(internal.shopifyDiscounts.activeMarketingCodes, { code })) {
      try { const r = await ensureShopifyCode(ctx, d); out[d.code] = r.ok ? `ok (${r.products} products)` : `failed: ${r.error}` }
      catch (e) { out[d.code] = `failed: ${e instanceof Error ? e.message : String(e)}` }
      if (!out[d.code].startsWith("ok")) console.error(`Shopify clearance code ${d.code}: ${out[d.code]}`)
    }
    return out
  },
})
