// Website (blackbole.com) products and collections, edited on the Website page.
// The website (Astro on Cloudflare Pages) reads GET /website/catalog at build time; after an edit we ask
// Cloudflare to rebuild (env WEBSITE_DEPLOY_HOOK, debounced ~2 min). Stock and prices stay live from Ops.
// Contract: blackbole-storefront/OPS-WEBSITE-CONTRACT.md. Nothing here changes orders, stock or couriers.
//
// products.web  = { id, title, html, vendor, type, tags, category, seo, options, images, mf, createdAt, publishedAt, published, updatedAt }
// products.handle = URL handle (indexed)
// variants.web  = { id, compareAt, options, image, pos?, parent? }  — parent: the Ops product whose website page
//                 shows this variant when it lives in another Ops product (e.g. Ops splits colours into products).
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, setSetting } from "./lib"
import { hasPerm } from "./rules"

export const EXPORT_URL = "https://blackbole-site.pages.dev/data/catalog-export.json"
const REBUILD_DELAY = 2 * 60 * 1000
const PRODUCT_CHUNK = 15
const COLLECTION_CHUNK = 25

// ---------------- helpers (pure, tested) ----------------
export const normSku = (s?: string | null) => (s ?? "").trim().toUpperCase()

export function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "product"
}

/** Numeric-string variant id for variants made in Ops (Shopify-style, never clashes with real Shopify ids). */
export const newVariantId = (t: number) => String(9e12 + Math.floor(t))

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")

async function requireWebsite(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

type CatalogVariant = {
  id: string; title: string; sku: string; price: number; compareAt: number | null
  options: Record<string, string>; available: boolean; image: string | null
}

/** Builds the website catalog: published products only, variant title/SKU/price from the Ops variant rows.
 *  `available` is the build-time default (sellable stock > 0 in courier warehouses, or pre-order); the site re-checks live. */
export function buildCatalog(input: {
  products: Doc<"products">[]
  variants: Doc<"variants">[]
  availableByVariant: Map<string, number>
  collections: Doc<"webCollections">[]
}) {
  const byId = new Map(input.products.map((p) => [p._id as string, p]))
  const groups = new Map<string, Doc<"variants">[]>()
  for (const vr of input.variants) {
    const own = byId.get(vr.productId as string)
    if (!vr.active || !own || !own.active || own.deletedAt) continue
    const owner = (vr.web?.parent as string | undefined) ?? (vr.productId as string)
    const list = groups.get(owner) ?? []
    list.push(vr)
    groups.set(owner, list)
  }
  const products: any[] = []
  for (const p of input.products) {
    const w = p.web ?? {}
    if (!w.published || !p.handle || !p.active || p.deletedAt) continue
    const rows = (groups.get(p._id as string) ?? []).sort(
      (a, b) => (a.web?.pos ?? 1e9) - (b.web?.pos ?? 1e9) || a.title.localeCompare(b.title, undefined, { numeric: true }),
    )
    if (!rows.length) continue
    const tags: string[] = Array.isArray(w.tags) ? w.tags : []
    const preOrder = !!p.preOrder || tags.some((t) => t.toLowerCase() === "pre-order")
    const optNames: string[] = (Array.isArray(w.options) ? w.options : []).map((o: any) => String(o?.name ?? "")).filter(Boolean)
    const names = optNames.length ? optNames : ["Title"]
    const variants: CatalogVariant[] = rows.map((vr) => {
      const given = (vr.web?.options ?? {}) as Record<string, string>
      const options: Record<string, string> = {}
      names.forEach((n, i) => { options[n] = given[n] ?? (names.length === 1 || i === names.length - 1 ? vr.title : "") })
      const vp = byId.get(vr.productId as string)
      return {
        id: String(vr.web?.id ?? newVariantId(vr._creationTime)),
        title: vr.title,
        sku: vr.sku,
        price: Math.round(vr.price),
        compareAt: typeof vr.web?.compareAt === "number" && vr.web.compareAt > 0 ? Math.round(vr.web.compareAt) : null,
        options,
        available: (input.availableByVariant.get(vr._id as string) ?? 0) > 0 || preOrder || !!vp?.preOrder,
        image: vr.web?.image ?? null,
      }
    })
    const options = names.map((name) => ({ name, values: [...new Set(variants.map((x) => x.options[name]).filter(Boolean))] }))
    const title = w.title || p.name
    products.push({
      id: w.id || `ops:${p._id}`,
      handle: p.handle,
      title,
      html: w.html ?? p.description ?? "",
      vendor: w.vendor ?? "BlackBole",
      type: w.type ?? p.category ?? "",
      tags,
      category: w.category ?? null,
      seo: { title: w.seo?.title ?? "", description: w.seo?.description ?? "" },
      options,
      images: Array.isArray(w.images) && w.images.length ? w.images : p.imageUrl ? [{ url: p.imageUrl, alt: title, w: null, h: null }] : [],
      mf: w.mf ?? {},
      createdAt: w.createdAt ?? new Date(p.createdAt).toISOString(),
      publishedAt: w.publishedAt ?? new Date(p.createdAt).toISOString(),
      variants,
    })
  }
  const live = new Set(products.map((p) => p.handle as string))
  const collections = input.collections
    .slice()
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map((c) => ({
      handle: c.handle,
      title: c.title,
      html: c.html ?? "",
      image: c.image ?? null,
      seo: { title: c.seo?.title ?? "", description: c.seo?.description ?? "" },
      productHandles: c.productHandles.filter((h) => live.has(h)),
    }))
  return { products, collections, updatedAt: Date.now() }
}

// ---------------- catalog feed ----------------
export const catalogData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const locations = await ctx.db.query("locations").collect()
    const active = new Set(locations.filter((l) => l.active && !l.noCourier).map((l) => l._id as string))
    const availableByVariant = new Map<string, number>()
    for (const r of await ctx.db.query("stock").collect()) {
      if (!active.has(r.locationId as string)) continue
      availableByVariant.set(r.variantId as string, (availableByVariant.get(r.variantId as string) ?? 0) + r.available)
    }
    return buildCatalog({
      products: await ctx.db.query("products").collect(),
      variants: await ctx.db.query("variants").collect(),
      availableByVariant,
      collections: await ctx.db.query("webCollections").collect(),
    })
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

export const catalogHttp = httpAction(async (ctx, req) => {
  const key = process.env.MARKETING_FEED_KEY
  if (!key || key.length < 24 || req.headers.get("X-Feed-Key") !== key) return json({ error: "Invalid feed key" }, 401)
  return json(await ctx.runQuery(internal.website.catalogData, {}))
})

// ---------------- rebuild (debounced) ----------------
type RebuildState = { due: number; pending: boolean; queuedAt?: number }

/** Ask for a website rebuild ~2 minutes after the last edit. */
export async function queueRebuild(ctx: MutationCtx) {
  const now = Date.now()
  const cur = await getSetting<RebuildState>(ctx, "websiteRebuild")
  const stuck = cur?.pending && cur.due < now - 10 * 60 * 1000
  await setSetting(ctx, "websiteRebuild", { due: now + REBUILD_DELAY, pending: true, queuedAt: now })
  if (!cur?.pending || stuck) await ctx.scheduler.runAfter(REBUILD_DELAY, internal.website.rebuildTick, {})
}

export const rebuildTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const r = await getSetting<RebuildState>(ctx, "websiteRebuild")
    if (!r?.pending) return
    const wait = r.due - Date.now()
    if (wait > 1000) {
      await ctx.scheduler.runAfter(wait, internal.website.rebuildTick, {})
      return
    }
    await setSetting(ctx, "websiteRebuild", { ...r, pending: false })
    await ctx.scheduler.runAfter(0, internal.website.deployHook, {})
  },
})

export const deployHook = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.WEBSITE_DEPLOY_HOOK
    if (!url) return
    let ok = false, status = 0
    try {
      const res = await fetch(url, { method: "POST" })
      ok = res.ok
      status = res.status
    } catch {
      ok = false
    }
    await ctx.runMutation(internal.website.recordBuild, { ok, status })
  },
})

export const recordBuild = internalMutation({
  args: { ok: v.boolean(), status: v.number() },
  handler: async (ctx, a) => {
    await setSetting(ctx, "websiteLastBuild", { at: Date.now(), ok: a.ok, status: a.status })
  },
})

export const queueRebuildInternal = internalMutation({ args: {}, handler: async (ctx) => queueRebuild(ctx) })

export const rebuildNow = mutation({
  args: {},
  handler: async (ctx) => {
    await requireWebsite(ctx)
    const r = await getSetting<RebuildState>(ctx, "websiteRebuild")
    await setSetting(ctx, "websiteRebuild", { ...(r ?? { due: Date.now() }), pending: false })
    await ctx.scheduler.runAfter(0, internal.website.deployHook, {})
    return { hook: !!process.env.WEBSITE_DEPLOY_HOOK }
  },
})

export const status = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    return {
      hook: !!process.env.WEBSITE_DEPLOY_HOOK,
      rebuild: (await getSetting<RebuildState>(ctx, "websiteRebuild")) ?? null,
      lastBuild: (await getSetting<{ at: number; ok: boolean; status: number }>(ctx, "websiteLastBuild")) ?? null,
      lastImport: (await getSetting<any>(ctx, "websiteLastImport")) ?? null,
    }
  },
})

// ---------------- import from the current website ----------------
/** One website product from catalog-export.json → fills `web` on the Ops product/variants matched by SKU,
 *  creating what is missing. Re-running updates, never duplicates. */
async function importOne(ctx: MutationCtx, ep: any, pos: { created: number; updated: number; variantsCreated: number; variantsMatched: number }) {
  const handle = String(ep.handle ?? "").trim()
  if (!handle) return
  const evs: any[] = Array.isArray(ep.variants) ? ep.variants : []
  const matched: (Doc<"variants"> | null)[] = []
  for (const ev of evs) {
    const sku = normSku(ev.sku) || (ev.id ? `WEB-${ev.id}` : "")
    let row = sku ? await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first() : null
    if (!row && ev.sku && ev.sku !== sku) row = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", String(ev.sku))).first()
    matched.push(row)
  }
  const byHandle = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
  let productId: Id<"products"> | undefined = byHandle && !byHandle.deletedAt ? byHandle._id : undefined
  if (!productId) {
    // The Ops product holding most of the matched variants (owners of a parent link first)
    const counts = new Map<string, number>()
    for (const m of matched) if (m) { const k = (m.web?.parent ?? m.productId) as string; counts.set(k, (counts.get(k) ?? 0) + 1) }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    // ...unless that product already is another website page: then this page gets its own Ops product
    // and the matched variants are linked to it (variants.web.parent), so stock/SKUs stay where they are.
    const bestDoc = best ? await ctx.db.get(best as Id<"products">) : null
    if (bestDoc && !bestDoc.deletedAt && (!bestDoc.handle || bestDoc.handle === handle)) productId = bestDoc._id
  }
  const images: any[] = Array.isArray(ep.images) ? ep.images : []
  const prev = productId ? await ctx.db.get(productId) : null
  const web = {
    ...(prev?.web ?? {}),
    id: ep.id ?? prev?.web?.id,
    title: ep.title ?? "",
    html: ep.html ?? "",
    vendor: ep.vendor ?? "BlackBole",
    type: ep.type ?? "",
    tags: Array.isArray(ep.tags) ? ep.tags.map(String) : [],
    category: ep.category ?? null,
    seo: { title: ep.seo?.title ?? "", description: ep.seo?.description ?? "" },
    options: Array.isArray(ep.options) ? ep.options : [],
    images,
    mf: ep.mf && typeof ep.mf === "object" ? ep.mf : {},
    createdAt: ep.createdAt ?? prev?.web?.createdAt,
    publishedAt: ep.publishedAt ?? prev?.web?.publishedAt,
    published: prev?.web?.published ?? true, // keep a switch someone already flipped in Ops
    updatedAt: Date.now(),
  }
  // Another Ops product holding this handle (e.g. from an earlier import) gives it up.
  if (byHandle && byHandle._id !== productId) await ctx.db.patch(byHandle._id, { handle: undefined })
  if (productId) {
    await ctx.db.patch(productId, { handle, web })
    pos.updated++
  } else {
    productId = await ctx.db.insert("products", {
      name: ep.title || handle, category: ep.type || undefined, imageUrl: images[0]?.url, active: true, createdAt: Date.now(), handle, web,
    })
    pos.created++
  }
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]
    const vweb = {
      id: String(ev.id ?? newVariantId(Date.now() + i)),
      compareAt: typeof ev.compareAt === "number" ? ev.compareAt : null,
      options: ev.options && typeof ev.options === "object" ? ev.options : {},
      image: ev.image ?? null,
      pos: i,
      ...(matched[i] && matched[i]!.productId !== productId ? { parent: productId } : {}),
    }
    const row = matched[i]
    if (row) {
      await ctx.db.patch(row._id, { web: vweb })
      pos.variantsMatched++
    } else {
      await ctx.db.insert("variants", {
        productId, sku: normSku(ev.sku) || `WEB-${vweb.id}`, title: String(ev.title || "Default"), weightKg: 0.5,
        price: Math.round(Number(ev.price) || 0), purchasePrice: 0, active: true, createdAt: Date.now(), web: vweb,
      })
      pos.variantsCreated++
    }
  }
}

export const importProductsChunk = internalMutation({
  args: { products: v.array(v.any()) },
  handler: async (ctx, { products }) => {
    const out = { created: 0, updated: 0, variantsCreated: 0, variantsMatched: 0 }
    for (const ep of products) await importOne(ctx, ep, out)
    return out
  },
})

export const importCollectionsChunk = internalMutation({
  args: { collections: v.array(v.any()) },
  handler: async (ctx, { collections }) => {
    let n = 0
    for (const c of collections) {
      const handle = String(c.handle ?? "").trim()
      if (!handle) continue
      const row = {
        handle, title: String(c.title ?? handle), html: c.html ?? "", image: c.image ?? null,
        seo: { title: c.seo?.title ?? "", description: c.seo?.description ?? "" },
        productHandles: Array.isArray(c.productHandles) ? c.productHandles.map(String) : [], updatedAt: Date.now(),
      }
      const cur = await ctx.db.query("webCollections").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
      if (cur) await ctx.db.patch(cur._id, row)
      else await ctx.db.insert("webCollections", row)
      n++
    }
    return n
  },
})

export const finishImport = internalMutation({
  args: { summary: v.any() },
  handler: async (ctx, { summary }) => {
    await setSetting(ctx, "websiteLastImport", { ...summary, at: Date.now() })
    await queueRebuild(ctx)
  },
})

export const canManageQuery = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    return !!s && canManage(s.perms)
  },
})

/** Runs an import from export data in small batches (each batch is its own mutation). */
export async function runImport(ctx: { runMutation: any }, data: any) {
  const products: any[] = Array.isArray(data?.products) ? data.products : []
  const collections: any[] = Array.isArray(data?.collections) ? data.collections : []
  if (!products.length) throw new ConvexError("The website export has no products.")
  const sum = { products: products.length, created: 0, updated: 0, variantsCreated: 0, variantsMatched: 0, collections: 0 }
  for (let i = 0; i < products.length; i += PRODUCT_CHUNK) {
    const r = await ctx.runMutation(internal.website.importProductsChunk, { products: products.slice(i, i + PRODUCT_CHUNK) })
    sum.created += r.created; sum.updated += r.updated; sum.variantsCreated += r.variantsCreated; sum.variantsMatched += r.variantsMatched
  }
  for (let i = 0; i < collections.length; i += COLLECTION_CHUNK) {
    sum.collections += await ctx.runMutation(internal.website.importCollectionsChunk, { collections: collections.slice(i, i + COLLECTION_CHUNK) })
  }
  await ctx.runMutation(internal.website.finishImport, { summary: sum })
  return sum
}

export const importCatalog = action({
  args: {},
  handler: async (ctx) => {
    if (!(await ctx.runQuery(internal.website.canManageQuery, {}))) throw new ConvexError("You don't have permission for this action.")
    let data: any
    try {
      const res = await fetch(EXPORT_URL, { headers: { Accept: "application/json" } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
    } catch (e: any) {
      throw new ConvexError(`Could not load the website export (${e?.message ?? "network error"}).`)
    }
    return await runImport(ctx, data)
  },
})

// ---------------- Website page: queries ----------------
export const products = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const all = (await ctx.db.query("products").collect()).filter((p) => !p.deletedAt)
    const variants = await ctx.db.query("variants").collect()
    const count = new Map<string, { n: number; min: number; max: number }>()
    const parented = new Map<string, string>() // product → product whose website page shows its variants
    for (const vr of variants) {
      const owner = (vr.web?.parent ?? vr.productId) as string
      if (vr.web?.parent) parented.set(vr.productId as string, vr.web.parent)
      if (!vr.active) continue
      const c = count.get(owner) ?? { n: 0, min: Infinity, max: 0 }
      c.n++; c.min = Math.min(c.min, vr.price); c.max = Math.max(c.max, vr.price)
      count.set(owner, c)
    }
    const names = new Map(all.map((p) => [p._id as string, p.web?.title || p.name]))
    return all
      .map((p) => {
        const c = count.get(p._id as string)
        const partOf = parented.get(p._id as string)
        return {
          _id: p._id, name: p.name, title: p.web?.title || p.name, handle: p.handle ?? null, active: p.active,
          image: p.web?.images?.[0]?.url ?? p.imageUrl ?? null, published: !!p.web?.published,
          variants: c?.n ?? 0, minPrice: c ? c.min : 0, maxPrice: c ? c.max : 0,
          partOf: partOf && !c ? names.get(partOf) ?? null : null,
          updatedAt: p.web?.updatedAt ?? p.createdAt,
        }
      })
      .sort((a, b) => Number(b.published) - Number(a.published) || b.updatedAt - a.updatedAt)
  },
})

export const product = query({
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const p = await ctx.db.get(id)
    if (!p) return null
    const own = await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", id)).collect()
    const linked = (await ctx.db.query("variants").collect()).filter((vr) => vr.web?.parent === id && vr.productId !== id)
    const variants = [...own.filter((vr) => !vr.web?.parent || vr.web.parent === id), ...linked]
      .sort((a, b) => (a.web?.pos ?? 1e9) - (b.web?.pos ?? 1e9) || a.title.localeCompare(b.title, undefined, { numeric: true }))
      .map((vr) => ({ _id: vr._id, sku: vr.sku, title: vr.title, price: vr.price, active: vr.active, web: vr.web ?? null }))
    const collections = (await ctx.db.query("webCollections").collect())
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => ({ _id: c._id, handle: c.handle, title: c.title, member: !!p.handle && c.productHandles.includes(p.handle) }))
    return { product: { _id: p._id, name: p.name, handle: p.handle ?? "", web: p.web ?? null, preOrder: !!p.preOrder, imageUrl: p.imageUrl ?? null, description: p.description ?? "", category: p.category ?? "" }, variants, collections }
  },
})

export const collections = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const prods = (await ctx.db.query("products").collect()).filter((p) => p.handle && !p.deletedAt)
    const info = new Map(prods.map((p) => [p.handle as string, { title: p.web?.title || p.name, published: !!p.web?.published, image: p.web?.images?.[0]?.url ?? p.imageUrl ?? null }]))
    const rows = await ctx.db.query("webCollections").collect()
    return {
      collections: rows.sort((a, b) => a.title.localeCompare(b.title)).map((c) => ({
        ...c, products: c.productHandles.map((h) => ({ handle: h, ...(info.get(h) ?? { title: h, published: false, image: null }), missing: !info.has(h) })),
      })),
      allProducts: [...info.entries()].map(([handle, x]) => ({ handle, title: x.title, published: x.published })).sort((a, b) => a.title.localeCompare(b.title)),
    }
  },
})

// ---------------- Website page: edits ----------------
async function uniqueHandle(ctx: QueryCtx, base: string, self: Id<"products">) {
  let h = slugify(base), n = 1
  for (;;) {
    const other = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", h)).first()
    if (!other || other._id === self) return h
    h = `${slugify(base)}-${++n}`
  }
}

export const setPublished = mutation({
  args: { id: v.id("products"), published: v.boolean() },
  handler: async (ctx, { id, published }) => {
    await requireWebsite(ctx)
    const p = await ctx.db.get(id)
    if (!p || p.deletedAt) throw new ConvexError("Product not found")
    const handle = p.handle || (await uniqueHandle(ctx, p.name, id))
    const now = new Date().toISOString()
    const web = { title: p.name, html: p.description ?? "", vendor: "BlackBole", type: p.category ?? "", tags: [], seo: { title: "", description: "" }, options: [], images: p.imageUrl ? [{ url: p.imageUrl, alt: p.name, w: null, h: null }] : [], mf: {}, createdAt: now, ...(p.web ?? {}), published, publishedAt: p.web?.publishedAt ?? (published ? now : undefined), updatedAt: Date.now() }
    await ctx.db.patch(id, { handle, web })
    await queueRebuild(ctx)
  },
})

const imageV = v.object({ url: v.string(), alt: v.optional(v.string()), w: v.optional(v.union(v.number(), v.null())), h: v.optional(v.union(v.number(), v.null())) })

export const saveProduct = mutation({
  args: {
    id: v.id("products"),
    handle: v.string(),
    title: v.string(),
    html: v.string(),
    vendor: v.string(),
    type: v.string(),
    tags: v.array(v.string()),
    seo: v.object({ title: v.string(), description: v.string() }),
    options: v.array(v.string()),
    images: v.array(imageV),
    mf: v.record(v.string(), v.string()),
    published: v.boolean(),
    variants: v.array(v.object({ id: v.id("variants"), compareAt: v.union(v.number(), v.null()), options: v.record(v.string(), v.string()), image: v.optional(v.union(v.string(), v.null())) })),
    collections: v.array(v.id("webCollections")),
  },
  handler: async (ctx, a) => {
    await requireWebsite(ctx)
    const p = await ctx.db.get(a.id)
    if (!p || p.deletedAt) throw new ConvexError("Product not found")
    const handle = slugify(a.handle || a.title || p.name)
    const clash = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`The URL handle "${handle}" is already used by ${clash.web?.title || clash.name}`)
    if (!a.title.trim()) throw new ConvexError("Title is required")
    const oldHandle = p.handle
    const now = new Date().toISOString()
    const optNames = a.options.map((o) => o.trim()).filter(Boolean)
    await ctx.db.patch(a.id, {
      handle,
      web: {
        ...(p.web ?? {}),
        title: a.title.trim(), html: a.html, vendor: a.vendor.trim(), type: a.type.trim(),
        tags: [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))],
        seo: { title: a.seo.title.trim(), description: a.seo.description.trim() },
        options: optNames.map((name) => ({ name, values: [] })), // values are rebuilt from the variants in the catalog
        images: a.images.map((i) => ({ url: i.url, alt: i.alt ?? "", w: i.w ?? null, h: i.h ?? null })),
        mf: a.mf,
        published: a.published,
        createdAt: p.web?.createdAt ?? now,
        publishedAt: p.web?.publishedAt ?? (a.published ? now : undefined),
        updatedAt: Date.now(),
      },
    })
    for (const [i, x] of a.variants.entries()) {
      const vr = await ctx.db.get(x.id)
      if (!vr) continue
      const opts: Record<string, string> = {}
      for (const n of optNames) if (x.options[n]?.trim()) opts[n] = x.options[n].trim()
      await ctx.db.patch(x.id, {
        web: { ...(vr.web ?? {}), id: vr.web?.id ?? newVariantId(vr._creationTime + i), compareAt: x.compareAt && x.compareAt > 0 ? Math.round(x.compareAt) : null, options: opts, image: x.image ?? vr.web?.image ?? null, pos: i },
      })
    }
    // Collections: rename the handle everywhere, then add/remove this product
    const want = new Set(a.collections as string[])
    for (const c of await ctx.db.query("webCollections").collect()) {
      let list = c.productHandles.map((h) => (oldHandle && h === oldHandle ? handle : h))
      const has = list.includes(handle)
      if (want.has(c._id) && !has) list = [...list, handle]
      if (!want.has(c._id) && has) list = list.filter((h) => h !== handle)
      if (JSON.stringify(list) !== JSON.stringify(c.productHandles)) await ctx.db.patch(c._id, { productHandles: list, updatedAt: Date.now() })
    }
    await queueRebuild(ctx)
    return handle
  },
})

export const saveCollection = mutation({
  args: {
    id: v.optional(v.id("webCollections")),
    handle: v.string(),
    title: v.string(),
    html: v.string(),
    image: v.union(v.string(), v.null()),
    seo: v.object({ title: v.string(), description: v.string() }),
    productHandles: v.array(v.string()),
  },
  handler: async (ctx, a) => {
    await requireWebsite(ctx)
    if (!a.title.trim()) throw new ConvexError("Collection name is required")
    const handle = slugify(a.handle || a.title)
    const clash = await ctx.db.query("webCollections").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`A collection with the handle "${handle}" already exists`)
    const row = { handle, title: a.title.trim(), html: a.html, image: a.image || null, seo: a.seo, productHandles: [...new Set(a.productHandles)], updatedAt: Date.now() }
    const id = a.id ? (await ctx.db.patch(a.id, row), a.id) : await ctx.db.insert("webCollections", row)
    await queueRebuild(ctx)
    return id
  },
})

export const deleteCollection = mutation({
  args: { id: v.id("webCollections") },
  handler: async (ctx, { id }) => {
    await requireWebsite(ctx)
    await ctx.db.delete(id)
    await queueRebuild(ctx)
  },
})

// ---------------- photos (Convex file storage) ----------------
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireWebsite(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

/** Public URL for an uploaded photo (stored in web.images). */
export const fileUrl = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireWebsite(ctx)
    const url = await ctx.storage.getUrl(storageId)
    if (!url) throw new ConvexError("Upload not found")
    return url
  },
})
