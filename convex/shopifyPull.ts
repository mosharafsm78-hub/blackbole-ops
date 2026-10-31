// Shopify → Ops product sync (the other half of shopifyProducts.ts, which goes Ops → Shopify).
// Marketing edits products in Shopify (price, compare-at price, title, description, vendor, type, tags, SEO);
// every few minutes those edits are copied into the same product in Ops so both sides stay equal.
//
// Who wins: each product keeps a snapshot of what Shopify looked like at the last sync (web.sp). A field is copied
// from Shopify to Ops only when Shopify changed it since that snapshot — so an edit made in Ops (which is pushed to
// Shopify straight away) is never overwritten by an old Shopify value. If both sides changed the same field,
// Shopify wins. Status, handle and images are never touched, and nothing here ever pushes back to Shopify,
// so there is no loop. Products that exist only in Shopify are left alone (Ops needs stock/cost to create one).
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation } from "./functions"
import { getSetting, setSetting } from "./lib"
import { shopifyGql } from "./shopifyStock"
import { webPrice, normSku, queueRebuild } from "./website"

type Snap = { title: string; html: string; vendor: string; type: string; tags: string; seoT: string; seoD: string; v: Record<string, [number, number]> }
const money = (x: unknown) => (x === null || x === undefined || x === "" ? 0 : Math.round(Number(x)) || 0)
const tagKey = (t: unknown) => (Array.isArray(t) ? t.map(String).sort().join("|") : "")

/** What a Shopify product looks like, in the shape we compare. */
export function snapFromShopify(p: any): Snap {
  const v: Record<string, [number, number]> = {}
  for (const x of p?.variants?.nodes ?? p?.variants ?? []) if (normSku(x.sku)) v[normSku(x.sku)] = [money(x.price), money(x.compareAtPrice)]
  return { title: p?.title ?? "", html: p?.descriptionHtml ?? "", vendor: p?.vendor ?? "", type: p?.productType ?? "", tags: tagKey(p?.tags), seoT: p?.seo?.title ?? "", seoD: p?.seo?.description ?? "", v }
}

/** Called after Ops pushed a product: remember what Shopify now holds, so that is not mistaken for a Shopify-side edit. */
export const saveSnapshot = internalMutation({
  args: { productId: v.id("products"), snap: v.any() },
  handler: async (ctx, { productId, snap }) => {
    const p = await ctx.db.get(productId)
    if (!p) return
    const old = (p.web as any)?.sp
    await ctx.db.patch(productId, { web: { ...(p.web ?? {}), sp: { ...snap, v: { ...(old?.v ?? {}), ...(snap.v ?? {}) } } } })
  },
})

const shopifyProduct = v.object({
  handle: v.string(), title: v.string(), html: v.string(), vendor: v.string(), type: v.string(), tags: v.array(v.string()),
  seoT: v.string(), seoD: v.string(), variants: v.array(v.object({ sku: v.string(), price: v.number(), compareAt: v.number() })),
})

/** Copy one Shopify product's changes into Ops. Returns what was changed. */
export const applyFromShopify = internalMutation({
  args: { p: shopifyProduct },
  handler: async (ctx, { p: s }) => {
    let prod: any = s.handle ? await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", s.handle)).first() : null
    if (prod?.deletedAt) prod = null
    if (!prod) {
      for (const x of s.variants) {
        const vr = normSku(x.sku) ? await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", x.sku)).first() : null
        const cand = vr ? await ctx.db.get(vr.productId) : null
        if (cand && !cand.deletedAt) { prod = cand; break }
      }
    }
    if (!prod) return { found: false, changed: [] as string[] }
    const w: any = prod.web ?? {}
    const X: Snap | undefined = w.sp
    const S: Snap = { title: s.title, html: s.html, vendor: s.vendor, type: s.type, tags: tagKey(s.tags), seoT: s.seoT, seoD: s.seoD, v: {} }
    for (const x of s.variants) if (normSku(x.sku)) S.v[normSku(x.sku)] = [Math.round(x.price), Math.round(x.compareAt)]
    const changed: string[] = []
    const next: any = { ...w }
    const cur = { title: w.title ?? prod.name ?? "", html: w.html ?? "", vendor: w.vendor ?? "", type: w.type ?? "", tags: tagKey(w.tags), seoT: w.seo?.title ?? "", seoD: w.seo?.description ?? "" }
    const shopifyMoved = (f: keyof typeof cur) => !X || S[f] !== X[f]
    if (shopifyMoved("title") && S.title !== cur.title) { next.title = s.title; changed.push("title") }
    if (shopifyMoved("html") && S.html !== cur.html) { next.html = s.html; changed.push("description") }
    if (shopifyMoved("vendor") && S.vendor !== cur.vendor) { next.vendor = s.vendor; changed.push("vendor") }
    if (shopifyMoved("type") && S.type !== cur.type) { next.type = s.type; changed.push("type") }
    if (shopifyMoved("tags") && S.tags !== cur.tags) { next.tags = s.tags; changed.push("tags") }
    if ((shopifyMoved("seoT") && S.seoT !== cur.seoT) || (shopifyMoved("seoD") && S.seoD !== cur.seoD)) {
      next.seo = { ...(w.seo ?? {}), ...(shopifyMoved("seoT") && S.seoT !== cur.seoT ? { title: s.seoT } : {}), ...(shopifyMoved("seoD") && S.seoD !== cur.seoD ? { description: s.seoD } : {}) }
      changed.push("SEO")
    }
    // sizes: matched by SKU; price + compare-at price
    const vs = (await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", prod._id)).collect()).filter((x: any) => !x.deletedAt)
    const seen = new Map<string, number>()
    for (const x of vs) seen.set(normSku(x.sku), (seen.get(normSku(x.sku)) ?? 0) + 1)
    let priceChanged = false
    for (const x of vs) {
      const k = normSku(x.sku)
      const sv = S.v[k]
      if (!sv || seen.get(k) !== 1) continue // not in Shopify, or the SKU is ambiguous
      const ov = X?.v?.[k]
      const curP = webPrice(x), curC = typeof x.web?.compareAt === "number" && x.web.compareAt > 0 ? Math.round(x.web.compareAt) : 0
      const moved = !ov || ov[0] !== sv[0] || ov[1] !== sv[1]
      if (!moved || (sv[0] === curP && sv[1] === curC)) continue
      await ctx.db.patch(x._id, { web: { ...(x.web ?? {}), ...(sv[0] > 0 ? { price: sv[0] } : {}), compareAt: sv[1] > 0 ? sv[1] : null } })
      priceChanged = true
    }
    if (priceChanged) changed.push("prices")
    next.sp = S
    if (changed.length) next.updatedAt = Date.now()
    await ctx.db.patch(prod._id, { web: next })
    if (changed.length) await queueRebuild(ctx)
    return { found: true, changed }
  },
})

export const state = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "shopifyPull")) ?? {} })
export const setState = internalMutation({ args: { s: v.any() }, handler: async (ctx, { s }) => { await setSetting(ctx, "shopifyPull", s) } })

const PAGE = 8 // products per request (each with up to 100 sizes) — keeps one request under Shopify's cost limit
const PAGES_PER_RUN = 5

/** Every few minutes: read products Shopify changed since the last run and copy them into Ops. */
export const run = internalAction({
  args: { cursor: v.optional(v.string()), q: v.optional(v.string()), startedAt: v.optional(v.number()) },
  handler: async (ctx, a) => {
    if (!(await ctx.runQuery(internal.shopifyProducts.isOn, {}))) return
    const st: any = await ctx.runQuery(internal.shopifyPull.state, {})
    const now = Date.now()
    const continuing = a.startedAt !== undefined
    if (!continuing && st.busy && now - st.busy < 10 * 60_000) return // an earlier run is still going
    const startedAt = a.startedAt ?? now
    const q = continuing ? a.q : st.since ? `updated_at:>='${new Date(st.since).toISOString()}'` : undefined
    await ctx.runMutation(internal.shopifyPull.setState, { s: { ...st, busy: now } })
    try {
      let cursor: string | null = a.cursor ?? null, more = true, n = 0
      while (more && n < PAGES_PER_RUN) {
        const r: any = await shopifyGql(ctx, `query($c:String,$q:String){ products(first:${PAGE}, after:$c, query:$q){ pageInfo{ hasNextPage endCursor } nodes { handle title descriptionHtml vendor productType tags seo{ title description } variants(first:100){ nodes { sku price compareAtPrice } } } } }`, { c: cursor, q: q ?? null })
        for (const node of r.products.nodes) {
          const sn = snapFromShopify(node)
          await ctx.runMutation(internal.shopifyPull.applyFromShopify, {
            p: { handle: node.handle, title: sn.title, html: sn.html, vendor: sn.vendor, type: sn.type, tags: node.tags ?? [], seoT: sn.seoT, seoD: sn.seoD,
              variants: (node.variants?.nodes ?? []).filter((x: any) => normSku(x.sku)).map((x: any) => ({ sku: x.sku, price: money(x.price), compareAt: money(x.compareAtPrice) })) },
          })
        }
        more = !!r.products.pageInfo.hasNextPage
        cursor = r.products.pageInfo.endCursor ?? null
        n++
        if (more && n < PAGES_PER_RUN) await new Promise((res) => setTimeout(res, 12_000)) // Shopify refills its request budget at a fixed rate
      }
      if (more) {
        await ctx.scheduler.runAfter(15_000, internal.shopifyPull.run, { cursor: cursor ?? undefined, q, startedAt })
        return
      }
      await ctx.runMutation(internal.shopifyPull.setState, { s: { since: startedAt - 120_000, busy: 0, error: null, at: Date.now() } })
    } catch (e: any) {
      await ctx.runMutation(internal.shopifyPull.setState, { s: { ...st, busy: 0, error: String(e?.message ?? e).slice(0, 300), at: Date.now() } })
    }
  },
})
