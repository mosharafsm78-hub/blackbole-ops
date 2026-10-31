// Shopify → Ops product sync (the other half of shopifyProducts.ts, which goes Ops → Shopify).
// Marketing edits products in Shopify (price, compare-at price, title, description, vendor, type, tags, SEO);
// every few minutes those edits are copied into the same product in Ops so both sides stay equal.
//
// Who wins: each product keeps a snapshot of what Shopify looked like at the last sync (web.sp). A field is copied
// from Shopify to Ops only when Shopify changed it since that snapshot — so an edit made in Ops (which is pushed to
// Shopify straight away) is never overwritten by an old Shopify value. If both sides changed the same field,
// Shopify wins. Status and handle are never touched; photos only fill a product that has none in Ops (fillImages), and nothing here ever pushes back to Shopify,
// so there is no loop. Products that exist only in Shopify are left alone (Ops needs stock/cost to create one).
import { v } from "convex/values"
import { internalAction, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation } from "./functions"
import { getSetting, setSetting } from "./lib"
import { shopifyGql } from "./shopifyStock"
import { webPrice, normSku, queueRebuild } from "./website"
import { marketingChanged } from "./marketingPush"

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
    if (!a.startedAt && (!st.imagesAt || now - st.imagesAt > 24 * 3600_000) && (!st.imagesStarted || now - st.imagesStarted > 3600_000)) {
      await ctx.runMutation(internal.shopifyPull.setState, { s: { ...st, imagesStarted: now } })
      await ctx.scheduler.runAfter(0, internal.shopifyPull.imagesBackfill, {})
      st.imagesStarted = now
    }
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
      const cur: any = await ctx.runQuery(internal.shopifyPull.state, {})
      await ctx.runMutation(internal.shopifyPull.setState, { s: { ...cur, since: startedAt - 120_000, busy: 0, error: null, at: Date.now() } })
    } catch (e: any) {
      const cur: any = await ctx.runQuery(internal.shopifyPull.state, {})
      await ctx.runMutation(internal.shopifyPull.setState, { s: { ...cur, busy: 0, error: String(e?.message ?? e).slice(0, 300), at: Date.now() } })
    }
  },
})

// ---- Photos: Shopify → Ops, only where Ops has none ----------------------------------------------------------
// Products made in Shopify (or before Ops had photos) can sit in Ops with no picture, which leaves the website
// feed, emails and Marketing OS (ads, AI content) with nothing to show. This copies Shopify's photos into such
// products. A product that already has a photo in Ops is never changed, so a photo set in Ops always wins.
const imgV = v.object({ url: v.string(), alt: v.string(), w: v.union(v.number(), v.null()), h: v.union(v.number(), v.null()) })

export const fillImages = internalMutation({
  args: { handle: v.string(), skus: v.array(v.string()), images: v.array(imgV), variantImages: v.array(v.object({ sku: v.string(), url: v.string() })) },
  handler: async (ctx, a) => {
    let prod: any = a.handle ? await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", a.handle)).first() : null
    if (prod?.deletedAt) prod = null
    if (!prod) for (const sku of a.skus) {
      const vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      const cand = vr ? await ctx.db.get(vr.productId) : null
      if (cand && !cand.deletedAt) { prod = cand; break }
    }
    if (!prod || !a.images.length) return 0
    let n = 0
    const w: any = prod.web ?? null
    const hasWeb = Array.isArray(w?.images) && w.images.length > 0
    const patch: any = {}
    if (!prod.imageUrl) { patch.imageUrl = a.images[0].url; n++ }
    if (w && !hasWeb) { patch.web = { ...w, images: a.images }; n++ }
    if (Object.keys(patch).length) await ctx.db.patch(prod._id, patch)
    const bySku = new Map(a.variantImages.map((x) => [normSku(x.sku), x.url]))
    for (const vr of await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", prod._id)).collect()) {
      const url = bySku.get(normSku(vr.sku))
      if (url && !vr.imageUrl) { await ctx.db.patch(vr._id, { imageUrl: url }); n++ }
    }
    if (n) await marketingChanged(ctx, { productId: prod._id })
    return n
  },
})

/** Walk every Shopify product once and fill missing photos in Ops (runs by itself after deploy, then daily). */
export const imagesBackfill = internalAction({
  args: { cursor: v.optional(v.string()), filled: v.optional(v.number()) },
  handler: async (ctx, a) => {
    if (!(await ctx.runQuery(internal.shopifyProducts.isOn, {}))) return
    let cursor: string | null = a.cursor ?? null, filled = a.filled ?? 0
    for (let page = 0; page < 5; page++) {
      const r: any = await shopifyGql(ctx, `query($c:String){ products(first:20, after:$c){ pageInfo{ hasNextPage endCursor } nodes { handle images(first:10){ nodes { url altText width height } } variants(first:100){ nodes { sku image { url } } } } } }`, { c: cursor })
      for (const node of r.products.nodes) {
        const images = (node.images?.nodes ?? []).filter((i: any) => i?.url).map((i: any) => ({ url: String(i.url), alt: String(i.altText ?? ""), w: typeof i.width === "number" ? i.width : null, h: typeof i.height === "number" ? i.height : null }))
        const vars = (node.variants?.nodes ?? []).filter((x: any) => normSku(x.sku))
        if (!images.length) continue
        filled += await ctx.runMutation(internal.shopifyPull.fillImages, { handle: node.handle ?? "", skus: vars.map((x: any) => String(x.sku)), images, variantImages: vars.filter((x: any) => x.image?.url).map((x: any) => ({ sku: String(x.sku), url: String(x.image.url) })) })
      }
      if (!r.products.pageInfo.hasNextPage) {
        const st: any = await ctx.runQuery(internal.shopifyPull.state, {})
        await ctx.runMutation(internal.shopifyPull.setState, { s: { ...st, imagesAt: Date.now(), imagesFilled: filled } })
        return
      }
      cursor = r.products.pageInfo.endCursor ?? null
      await new Promise((res) => setTimeout(res, 8_000))
    }
    await ctx.scheduler.runAfter(10_000, internal.shopifyPull.imagesBackfill, { cursor: cursor ?? undefined, filled })
  },
})
