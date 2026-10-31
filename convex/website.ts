// Website (blackbole.com) products and collections, edited on the Website page.
// The website (Astro on Cloudflare Pages) reads GET /website/catalog at build time; after an edit we ask
// Cloudflare to rebuild (env WEBSITE_DEPLOY_HOOK, debounced ~2 min). Stock and prices stay live from Ops.
// Contract: blackbole-storefront/OPS-WEBSITE-CONTRACT.md. Nothing here changes orders, stock or couriers.
//
// products.web  = { id, title, html, vendor, type, tags, category, seo, options, images, mf, createdAt, publishedAt, published, updatedAt,
//                   archived?, templateSuffix? }  — archived: Shopify's "Archived" status (never on the website)
// products.handle = URL handle (indexed)
// variants.web  = { id, compareAt, options, image, pos?, parent?, price?, barcode? }  — parent: the Ops product whose website page
//                 shows this variant when it lives in another Ops product (e.g. Ops splits colours into products).
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, setSetting } from "./lib"
import { hasPerm } from "./rules"
import { applyTestStock } from "./stockCheck"
import { finishCollections, type Rules, type SortKey } from "./websiteRules"

export const EXPORT_URL = "https://blackbole-site.pages.dev/data/catalog-export.json"
const REBUILD_DELAY = 30 * 1000 // short pause so several quick edits go out together
const PRODUCT_CHUNK = 15
const COLLECTION_CHUNK = 25

// ---------------- helpers (pure, tested) ----------------
/** The website's selling price for a size: its own website price (from Shopify / set on the Website page),
 *  else the Ops price. */
export const webPrice = (vr: { price: number; web?: any }) => (typeof vr.web?.price === "number" && vr.web.price > 0 ? Math.round(vr.web.price) : Math.round(vr.price))

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
        price: webPrice(vr),
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
      ...(typeof w.templateSuffix === "string" && w.templateSuffix ? { templateSuffix: w.templateSuffix } : {}),
      createdAt: w.createdAt ?? new Date(p.createdAt).toISOString(),
      publishedAt: w.publishedAt ?? new Date(p.createdAt).toISOString(),
      variants,
    })
  }
  const live = new Set(products.map((p) => p.handle as string))
  const collections = input.collections
    .filter((c) => c.published !== false) // hidden collections (Website → Collections) leave the website
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map((c) => ({
      handle: c.handle,
      title: c.title,
      html: c.html ?? "",
      image: c.image ?? null,
      seo: { title: c.seo?.title ?? "", description: c.seo?.description ?? "" },
      productHandles: c.productHandles.filter((h) => live.has(h)),
      rules: (c.rules ?? null) as Rules | null,
      sort: (c.sort ?? "manual") as SortKey,
      templateSuffix: c.templateSuffix ?? null,
    }))
  return { products, collections, updatedAt: Date.now() }
}

// ---------------- catalog feed ----------------
/** Sellable pairs per variant (courier warehouses only), same rule as the website's live stock. */
async function availableByVariantMap(ctx: QueryCtx) {
  const locations = await ctx.db.query("locations").collect()
  const active = new Set(locations.filter((l) => l.active && !l.noCourier).map((l) => l._id as string))
  const availableByVariant = new Map<string, number>()
  for (const r of await ctx.db.query("stock").collect()) {
    if (!active.has(r.locationId as string)) continue
    availableByVariant.set(r.variantId as string, (availableByVariant.get(r.variantId as string) ?? 0) + r.available)
  }
  return availableByVariant
}

const isPreTag = (tags: unknown) => Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === "pre-order")

export const catalogData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const availableByVariant = await availableByVariantMap(ctx)
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
  const data: any = await ctx.runQuery(internal.website.catalogData, {})
  // "Best selling" order uses pairs sold per product (worked out daily in the background, see salesTick).
  // It can never block the catalog: if it isn't there, collections simply keep their saved order.
  let sold: Record<string, number> = {}
  try {
    const snap = await ctx.runQuery(internal.website.soldSnapshot, {})
    sold = Object.fromEntries(snap.pairs)
    // missing or older than 6 h: recount in the background (this build uses what's there)
    if (!snap.at || Date.now() - snap.at > 6 * 60 * 60 * 1000) await ctx.scheduler.runAfter(0, internal.website.salesTick, {})
  } catch { sold = {} }
  for (const p of data.products) p.sold = sold[p.handle] ?? 0
  finishCollections(data.products, data.collections)
  return json(data)
})

export const soldSnapshot = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ at: number; pairs: [string, number][] }> => {
    const x = await getSetting<{ at: number; pairs: [string, number][] }>(ctx, "websiteSold")
    return { at: x?.at ?? 0, pairs: Array.isArray(x?.pairs) ? x!.pairs : [] }
  },
})

/** One page of recent orders → pairs sold per Ops product id (small pages keep every read well under Convex limits). */
export const soldPage = internalQuery({
  args: { since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { since, cursor }) => {
    const page = await ctx.db.query("orders").withIndex("by_creation_time", (q) => q.gt("_creationTime", since)).paginate({ cursor, numItems: 150 })
    // lists, not objects: Convex return values allow at most 1024 fields per object
    const byVariant = new Map<string, number>()
    for (const o of page.page) {
      if (o.deletedAt || o.status === "cancelled") continue
      for (const i of o.items) if (i.variantId) byVariant.set(i.variantId as string, (byVariant.get(i.variantId as string) ?? 0) + (i.qty || 1))
    }
    return { pairs: [...byVariant], cursor: page.continueCursor, done: page.isDone }
  },
})

export const soldOwners = internalQuery({
  args: {},
  handler: async (ctx) => {
    const handleOf = new Map<string, string>()
    for (const p of await ctx.db.query("products").collect()) if (p.handle && !p.deletedAt) handleOf.set(p._id as string, p.handle)
    const owner: [string, string][] = []
    for (const vr of await ctx.db.query("variants").collect()) {
      const h = handleOf.get((vr.web?.parent ?? vr.productId) as string)
      if (h) owner.push([vr._id as string, h])
    }
    return owner
  },
})

export const saveSold = internalMutation({
  args: { pairs: v.array(v.array(v.union(v.string(), v.number()))) },
  handler: async (ctx, { pairs }) => { await setSetting(ctx, "websiteSold", { at: Date.now(), pairs }) },
})

/** Daily: pairs sold per website product in the last 90 days (cancelled orders left out), read in small pages. */
export const salesTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const since = Date.now() - 90 * 24 * 60 * 60 * 1000
    const byVariant = new Map<string, number>()
    let cursor: string | null = null
    for (let n = 0; n < 400; n++) {
      const r: { pairs: [string, number][]; cursor: string; done: boolean } = await ctx.runQuery(internal.website.soldPage, { since, cursor })
      for (const [k, q] of r.pairs) byVariant.set(k, (byVariant.get(k) ?? 0) + q)
      if (r.done) break
      cursor = r.cursor
    }
    const owner = new Map<string, string>(await ctx.runQuery(internal.website.soldOwners, {}))
    const byHandle = new Map<string, number>()
    for (const [vid, q] of byVariant) { const h = owner.get(vid); if (h) byHandle.set(h, (byHandle.get(h) ?? 0) + q) }
    await ctx.runMutation(internal.website.saveSold, { pairs: [...byHandle] })
  },
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
const isPlaceholder = (v: Doc<"variants">) => /^WEB-/i.test(v.sku)

type ImportStats = { created: number; updated: number; variantsCreated: number; variantsMatched: number; skipped?: number; relinked?: number; moved?: number }

async function importOne(ctx: MutationCtx, ep: any, pos: ImportStats) {
  const handle = String(ep.handle ?? "").trim()
  if (!handle) return
  const evs: any[] = Array.isArray(ep.variants) ? ep.variants : []
  const matched: (Doc<"variants"> | null)[] = []
  for (const ev of evs) {
    const real = normSku(ev.sku)
    let row = real ? await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", real)).first() : null
    if (!row && ev.sku && ev.sku !== real) row = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", String(ev.sku))).first()
    if (!row && !real && ev.id) {
      // No SKU on the website: the size keeps its own WEB-<id> placeholder (revived if an earlier run retired it).
      // (Name matching is not used here: the same pair is listed on several Shopify pages and would be pulled across.)
      row = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", `WEB-${ev.id}`)).first()
      if (!row) {
        const retired = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", `WEB-${ev.id}-DELETED`)).first()
        if (retired) { await ctx.db.patch(retired._id, { sku: `WEB-${ev.id}`, active: true }); row = await ctx.db.get(retired._id) }
      }
    }
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
    published: prev?.web?.published ?? (ep.published !== false), // keep a switch someone already flipped in Ops; drafts stay hidden
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
      // the website's own selling price for this size (from Shopify), kept apart from the Ops price
      price: Number(ev.price) > 0 ? Math.round(Number(ev.price)) : undefined,
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

/** Undo of a short-lived import change (27 Oct): pages that were moved from their import-made product to another
 *  Ops product go back, with their WEB- sizes. Recognised by: soft-deleted, import-made (only WEB- sizes before),
 *  and another product now carrying the same website id. */
export const undoPageMoves = internalMutation({
  args: {},
  handler: async (ctx) => {
    const since = Date.UTC(2026, 9, 26, 20, 0) // 27 Oct 02:00 Dhaka
    const all = await ctx.db.query("products").collect()
    let n = 0
    // Real sizes that were name-matched to a no-SKU website size carry that size's website id; clear their website
    // link (their own page, if any, sets it again during this import).
    const vars = await ctx.db.query("variants").collect()
    const placeholderIds = new Set(vars.map((v) => /^WEB-(\d+)/i.exec(v.sku)?.[1]).filter(Boolean) as string[])
    for (const v of vars) if (!/^WEB-/i.test(v.sku) && v.web?.id && placeholderIds.has(String(v.web.id))) { await ctx.db.patch(v._id, { web: undefined }); n++ }
    for (const ph of all) {
      if (!ph.deletedAt || ph.deletedAt < since || ph.handle || !ph.web?.id) continue
      const target = all.find((t) => t._id !== ph._id && !t.deletedAt && t.handle && t.web?.id === ph.web.id)
      if (!target) continue
      for (const v of await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", target._id)).collect())
        if (/^WEB-/i.test(v.sku)) await ctx.db.patch(v._id, { productId: ph._id })
      const handle = target.handle
      await ctx.db.patch(target._id, { handle: undefined })
      await ctx.db.patch(ph._id, { handle, active: true, deletedAt: undefined })
      n++
    }
    return n
  },
})

export const importProductsChunk = internalMutation({
  args: { products: v.array(v.any()) },
  handler: async (ctx, { products }) => {
    const out: ImportStats = { created: 0, updated: 0, variantsCreated: 0, variantsMatched: 0, skipped: 0, relinked: 0, moved: 0 }
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
        rules: c.rules && Array.isArray(c.rules.conditions) && c.rules.conditions.length ? c.rules : undefined,
        sort: typeof c.sort === "string" ? c.sort : undefined,
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
  await ctx.runMutation(internal.website.undoPageMoves, {})
  const sum = { products: products.length, created: 0, updated: 0, variantsCreated: 0, variantsMatched: 0, collections: 0, relinked: 0, moved: 0 }
  for (let i = 0; i < products.length; i += PRODUCT_CHUNK) {
    const r = await ctx.runMutation(internal.website.importProductsChunk, { products: products.slice(i, i + PRODUCT_CHUNK) })
    sum.created += r.created; sum.updated += r.updated; sum.variantsCreated += r.variantsCreated; sum.variantsMatched += r.variantsMatched
    sum.relinked += r.relinked ?? 0; sum.moved += r.moved ?? 0
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
export type WebStatus = "active" | "draft" | "archived" | "new"
/** Shopify-style status: Active = on the website, Draft = set up but hidden, Archived = put away, New = not on the website yet. */
export function productStatus(p: { handle?: string; web?: any }): WebStatus {
  if (!p.handle || !p.web) return "new"
  if (p.web.published) return "active"
  return p.web.archived ? "archived" : "draft"
}

/** Product page layouts in the live theme ("product", "product.wide"…), as template suffixes ("" = default). */
async function productTemplates(ctx: QueryCtx): Promise<string[]> {
  try {
    const live = await ctx.db.query("webThemes").withIndex("by_role", (q) => q.eq("role", "live")).first()
    if (!live) return [""]
    const t = JSON.parse(live.json)?.templates ?? {}
    const out = Object.keys(t).filter((k) => k.startsWith("product.")).map((k) => k.slice("product.".length)).filter(Boolean)
    return ["", ...new Set(out)]
  } catch { return [""] }
}

/** Product page layouts of the live theme (for Add product → Theme template). */
export const productTemplateList = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return [""]
    return await productTemplates(ctx)
  },
})

export const products = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const all = (await ctx.db.query("products").collect()).filter((p) => !p.deletedAt)
    const variants = await ctx.db.query("variants").collect()
    const stock = await availableByVariantMap(ctx)
    const count = new Map<string, { n: number; min: number; max: number; stock: number; inStock: number; noSku: number; fullMin: number; fullMax: number }>()
    const parented = new Map<string, string>() // product → product whose website page shows its variants
    for (const vr of variants) {
      const owner = (vr.web?.parent ?? vr.productId) as string
      if (vr.web?.parent) parented.set(vr.productId as string, vr.web.parent)
      if (!vr.active) continue
      const c = count.get(owner) ?? { n: 0, min: Infinity, max: 0, stock: 0, inStock: 0, noSku: 0, fullMin: Infinity, fullMax: 0 }
      const full = typeof vr.web?.compareAt === "number" && vr.web.compareAt > webPrice(vr) ? vr.web.compareAt : webPrice(vr) * 2
      c.fullMin = Math.min(c.fullMin, full); c.fullMax = Math.max(c.fullMax, full)
      const a = Math.max(0, stock.get(vr._id as string) ?? 0)
      const wp = webPrice(vr)
      c.n++; c.min = Math.min(c.min, wp); c.max = Math.max(c.max, wp); c.stock += a; if (a > 0) c.inStock++
      if (vr.sku.startsWith("WEB-")) c.noSku++
      count.set(owner, c)
    }
    const colls = await ctx.db.query("webCollections").collect()
    const inColls = new Map<string, string[]>()
    for (const c of colls) for (const h of c.productHandles) inColls.set(h, [...(inColls.get(h) ?? []), c._id as string])
    const names = new Map(all.map((p) => [p._id as string, p.web?.title || p.name]))
    return all
      .map((p) => {
        const c = count.get(p._id as string)
        const partOf = parented.get(p._id as string)
        const w: any = p.web ?? {}
        return {
          _id: p._id, name: p.name, title: w.title || p.name, handle: p.handle ?? null, active: p.active,
          image: w.images?.[0]?.url ?? p.imageUrl ?? null, published: !!w.published, setUp: !!p.handle && !!p.web,
          variants: c?.n ?? 0, minPrice: c ? c.min : 0, maxPrice: c ? c.max : 0,
          fullMin: c && c.fullMin !== Infinity ? c.fullMin : 0, fullMax: c ? c.fullMax : 0,
          stock: c?.stock ?? 0, sizesInStock: c?.inStock ?? 0, noSku: c?.noSku ?? 0,
          preOrder: !!p.preOrder || isPreTag(w.tags),
          type: (w.type || p.category || "") as string,
          collections: p.handle ? inColls.get(p.handle) ?? [] : [],
          photos: Array.isArray(w.images) ? w.images.length : p.imageUrl ? 1 : 0,
          hasDescription: String(w.html ?? p.description ?? "").replace(/<[^>]*>/g, "").trim().length > 0,
          partOf: partOf && !c ? names.get(partOf) ?? null : null,
          updatedAt: (w.updatedAt ?? p.createdAt) as number,
          status: productStatus(p),
          vendor: String(w.vendor ?? ""),
          tags: (Array.isArray(w.tags) ? w.tags.map(String) : []) as string[],
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
      .map((vr) => ({ _id: vr._id, sku: vr.sku, title: vr.title, price: vr.price, active: vr.active, web: vr.web ?? null, cost: vr.purchasePrice, weightKg: vr.weightKg }))
    const stock = await availableByVariantMap(ctx)
    // stock per location (read-only here; stock is managed in Ops)
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.active)
    const byLoc = new Map<string, Record<string, { available: number; committed: number }>>()
    for (const vr of variants) {
      const m: Record<string, { available: number; committed: number }> = {}
      for (const r of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", vr._id)).collect())
        m[r.locationId as string] = { available: r.available, committed: r.processing }
      byLoc.set(vr._id as string, m)
    }
    const collections = (await ctx.db.query("webCollections").collect())
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => ({ _id: c._id, handle: c.handle, title: c.title, count: c.productHandles.length, member: !!p.handle && c.productHandles.includes(p.handle) }))
    // Suggestions for the organisation fields (from every website product)
    const types = new Set<string>(), vendors = new Set<string>(), tags = new Set<string>()
    const siblings: { id: string; title: string; image: string | null; published: boolean }[] = []
    for (const o of await ctx.db.query("products").collect()) {
      const w: any = o.web
      if (!w) continue
      if (o.handle && !o.deletedAt && o._id !== p._id) siblings.push({ id: String(w.id || `ops:${o._id}`), title: String(w.title || o.name), image: w.images?.[0]?.url ?? o.imageUrl ?? null, published: !!w.published })
      if (w.type) types.add(String(w.type))
      if (w.vendor) vendors.add(String(w.vendor))
      for (const t of Array.isArray(w.tags) ? w.tags : []) tags.add(String(t))
    }
    const sort = (x: Set<string>) => [...x].sort((a, b) => a.localeCompare(b))
    return {
      product: { _id: p._id, name: p.name, handle: p.handle ?? "", web: p.web ?? null, preOrder: !!p.preOrder, active: p.active, imageUrl: p.imageUrl ?? null, description: p.description ?? "", category: p.category ?? "" },
      variants: variants.map((vr) => ({ ...vr, stock: Math.max(0, stock.get(vr._id as string) ?? 0), byLocation: byLoc.get(vr._id as string) ?? {} })),
      locations: locs.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name)).map((l) => ({ _id: l._id as string, name: l.name, sellable: !l.noCourier })),
      templates: await productTemplates(ctx),
      status: productStatus(p),
      collections,
      suggest: { types: sort(types), vendors: sort(vendors), tags: sort(tags) },
      siblings: siblings.sort((a, b) => a.title.localeCompare(b.title)),
      webId: String((p.web as any)?.id || `ops:${p._id}`),
    }
  },
})

async function productInfoByHandle(ctx: QueryCtx) {
  const prods = (await ctx.db.query("products").collect()).filter((p) => p.handle && !p.deletedAt)
  const variants = await ctx.db.query("variants").collect()
  const stock = await availableByVariantMap(ctx)
  const agg = new Map<string, { stock: number; min: number; n: number; prices: number[]; compareAts: number[] }>()
  for (const vr of variants) {
    if (!vr.active) continue
    const owner = (vr.web?.parent ?? vr.productId) as string
    const a = agg.get(owner) ?? { stock: 0, min: Infinity, n: 0, prices: [], compareAts: [] }
    a.stock += Math.max(0, stock.get(vr._id as string) ?? 0); a.min = Math.min(a.min, webPrice(vr)); a.n++
    a.prices.push(webPrice(vr)); if (typeof vr.web?.compareAt === "number" && vr.web.compareAt > 0) a.compareAts.push(vr.web.compareAt)
    agg.set(owner, a)
  }
  type Info = {
    _id: Id<"products">; title: string; published: boolean; image: string | null; stock: number; price: number; preOrder: boolean; type: string
    tags: string[]; vendor: string; prices: number[]; compareAts: number[]; createdAt: string
  }
  return new Map<string, Info>(prods.map((p): [string, Info] => {
    const w: any = p.web ?? {}
    const a = agg.get(p._id as string)
    return [p.handle as string, {
      _id: p._id, title: (w.title || p.name) as string, published: !!w.published,
      image: (w.images?.[0]?.url ?? p.imageUrl ?? null) as string | null,
      stock: a?.stock ?? 0, price: a && a.n ? a.min : 0, preOrder: !!p.preOrder || isPreTag(w.tags), type: (w.type || p.category || "") as string,
      tags: Array.isArray(w.tags) ? w.tags.map(String) : [], vendor: String(w.vendor ?? ""), prices: a?.prices ?? [], compareAts: a?.compareAts ?? [],
      createdAt: String(w.publishedAt || w.createdAt || new Date(p.createdAt).toISOString()),
    }]
  }))
}

export const collections = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const info = await productInfoByHandle(ctx)
    const rows = await ctx.db.query("webCollections").collect()
    return {
      collections: rows.sort((a, b) => a.title.localeCompare(b.title)).map((c) => {
        const ps = c.productHandles.map((h) => info.get(h)).filter(Boolean) as NonNullable<ReturnType<typeof info.get>>[]
        return {
          _id: c._id, handle: c.handle, title: c.title, image: c.image ?? null, updatedAt: c.updatedAt,
          total: c.productHandles.length, live: ps.filter((p) => p.published).length,
          thumbs: ps.filter((p) => p.image).slice(0, 4).map((p) => p.image as string),
          hasDescription: String(c.html ?? "").replace(/<[^>]*>/g, "").trim().length > 0,
          productHandles: c.productHandles,
        }
      }),
    }
  },
})

export const collection = query({
  args: { id: v.optional(v.id("webCollections")) },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const info = await productInfoByHandle(ctx)
    const c = id ? await ctx.db.get(id) : null
    if (id && !c) return { missing: true as const }
    return {
      missing: false as const,
      collection: c ? { _id: c._id, handle: c.handle, title: c.title, html: c.html ?? "", image: c.image ?? null, seo: c.seo ?? { title: "", description: "" }, productHandles: c.productHandles, rules: (c.rules ?? null) as Rules | null, sort: (c.sort ?? "manual") as SortKey } : null,
      products: [...info.entries()].map(([handle, x]) => ({ handle, ...x })).sort((a, b) => Number(b.published) - Number(a.published) || a.title.localeCompare(b.title)),
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
    await publish(ctx, id, published)
    await queueRebuild(ctx)
  },
})

async function publish(ctx: MutationCtx, id: Id<"products">, published: boolean) {
  const p = await ctx.db.get(id)
  if (!p || p.deletedAt) throw new ConvexError("Product not found")
  const handle = p.handle || (await uniqueHandle(ctx, p.name, id))
  const now = new Date().toISOString()
  const web = { title: p.name, html: p.description ?? "", vendor: "BlackBole", type: p.category ?? "", tags: [], seo: { title: "", description: "" }, options: [], images: p.imageUrl ? [{ url: p.imageUrl, alt: p.name, w: null, h: null }] : [], mf: {}, createdAt: now, ...(p.web ?? {}), published, publishedAt: p.web?.publishedAt ?? (published ? now : undefined), updatedAt: Date.now() }
  await ctx.db.patch(id, { handle, web })
}

export const bulkPublish = mutation({
  args: { ids: v.array(v.id("products")), published: v.boolean() },
  handler: async (ctx, { ids, published }) => {
    await requireWebsite(ctx)
    for (const id of ids.slice(0, 500)) await publish(ctx, id, published)
    await queueRebuild(ctx)
    return ids.length
  },
})

/** Status for one product (Shopify: Active / Draft / Archived). Archived products are never on the website. */
async function setStatus(ctx: MutationCtx, id: Id<"products">, status: "active" | "draft" | "archived") {
  await publish(ctx, id, status === "active")
  const p = (await ctx.db.get(id))!
  await ctx.db.patch(id, { web: { ...p.web, archived: status === "archived" ? true : undefined } })
}

export const bulkStatus = mutation({
  args: { ids: v.array(v.id("products")), status: v.union(v.literal("active"), v.literal("draft"), v.literal("archived")) },
  handler: async (ctx, { ids, status }) => {
    await requireWebsite(ctx)
    for (const id of ids.slice(0, 500)) await setStatus(ctx, id, status)
    await queueRebuild(ctx)
    return ids.length
  },
})

/** Adds or removes tags on website products (products not on the website yet are skipped). */
export const bulkTags = mutation({
  args: { ids: v.array(v.id("products")), tags: v.array(v.string()), add: v.boolean() },
  handler: async (ctx, { ids, tags, add }) => {
    await requireWebsite(ctx)
    const list = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    if (!list.length) throw new ConvexError("Add a tag first")
    const lower = new Set(list.map((t) => t.toLowerCase()))
    let n = 0
    for (const id of ids.slice(0, 500)) {
      const p = await ctx.db.get(id)
      if (!p || p.deletedAt || !p.web) continue
      const cur: string[] = Array.isArray(p.web.tags) ? p.web.tags.map(String) : []
      const next = add
        ? [...cur, ...list.filter((t) => !cur.some((c) => c.toLowerCase() === t.toLowerCase()))]
        : cur.filter((t) => !lower.has(t.toLowerCase()))
      if (next.length === cur.length && next.every((t, i) => t === cur[i])) continue
      await ctx.db.patch(id, { web: { ...p.web, tags: next, updatedAt: Date.now() } })
      n++
    }
    if (n) await queueRebuild(ctx)
    return n
  },
})

export const bulkCollection = mutation({
  args: { ids: v.array(v.id("products")), collection: v.id("webCollections"), add: v.boolean() },
  handler: async (ctx, { ids, collection, add }) => {
    await requireWebsite(ctx)
    const c = await ctx.db.get(collection)
    if (!c) throw new ConvexError("Collection not found")
    let list = [...c.productHandles]
    for (const id of ids.slice(0, 500)) {
      const p = await ctx.db.get(id)
      if (!p || p.deletedAt) continue
      if (add) {
        if (!p.web || !p.handle) await publish(ctx, id, !!p.web?.published)
        const h = (await ctx.db.get(id))!.handle as string
        if (!list.includes(h)) list.push(h)
      } else if (p.handle) list = list.filter((h) => h !== p.handle)
    }
    await ctx.db.patch(collection, { productHandles: list, updatedAt: Date.now() })
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
    // Shopify status; when given it decides `published` (Archived = hidden and put away)
    status: v.optional(v.union(v.literal("active"), v.literal("draft"), v.literal("archived"))),
    templateSuffix: v.optional(v.string()),
    category: v.optional(v.union(v.string(), v.null())), // product category (text); left as it is when not sent
    variants: v.array(v.object({
      id: v.id("variants"), price: v.optional(v.union(v.number(), v.null())), compareAt: v.union(v.number(), v.null()), options: v.record(v.string(), v.string()), image: v.optional(v.union(v.string(), v.null())),
      barcode: v.optional(v.string()), cost: v.optional(v.number()), weightKg: v.optional(v.number()),
    })),
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
    const published = a.status ? a.status === "active" : a.published
    const archived = a.status ? a.status === "archived" : !published && !!p.web?.archived
    await ctx.db.patch(a.id, {
      handle,
      web: {
        ...(p.web ?? {}),
        archived: archived || undefined,
        templateSuffix: a.templateSuffix === undefined ? p.web?.templateSuffix : a.templateSuffix.trim() || undefined,
        category: a.category === undefined ? p.web?.category ?? null : a.category?.trim() || null,
        title: a.title.trim(), html: a.html, vendor: a.vendor.trim(), type: a.type.trim(),
        tags: [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))],
        seo: { title: a.seo.title.trim(), description: a.seo.description.trim() },
        options: optNames.map((name) => ({ name, values: [] })), // values are rebuilt from the variants in the catalog
        images: a.images.map((i) => ({ url: i.url, alt: i.alt ?? "", w: i.w ?? null, h: i.h ?? null })),
        mf: a.mf,
        published,
        createdAt: p.web?.createdAt ?? now,
        publishedAt: p.web?.publishedAt ?? (published ? now : undefined),
        updatedAt: Date.now(),
      },
    })
    for (const [i, x] of a.variants.entries()) {
      const vr = await ctx.db.get(x.id)
      if (!vr) continue
      const opts: Record<string, string> = {}
      for (const n of optNames) if (x.options[n]?.trim()) opts[n] = x.options[n].trim()
      await ctx.db.patch(x.id, {
        // cost and weight are Ops fields (cost per item, courier weight): only changed when sent
        ...(typeof x.cost === "number" && x.cost >= 0 ? { purchasePrice: Math.round(x.cost) } : {}),
        ...(typeof x.weightKg === "number" && x.weightKg > 0 ? { weightKg: x.weightKg } : {}),
        web: {
          ...(vr.web ?? {}), id: vr.web?.id ?? newVariantId(vr._creationTime + i),
          price: x.price === undefined ? vr.web?.price : x.price && x.price > 0 ? Math.round(x.price) : undefined,
          compareAt: x.compareAt && x.compareAt > 0 ? Math.round(x.compareAt) : null, options: opts, image: x.image ?? vr.web?.image ?? null, pos: i,
          barcode: x.barcode === undefined ? vr.web?.barcode : x.barcode.trim() || undefined,
        },
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
    await ctx.scheduler.runAfter(0, internal.shopifyProducts.push, { productId: a.id, oldHandle: oldHandle ?? undefined })
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
    rules: v.optional(v.union(v.null(), v.object({ match: v.union(v.literal("all"), v.literal("any")), conditions: v.array(v.object({ field: v.string(), op: v.string(), values: v.array(v.string()) })) }))),
    sort: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireWebsite(ctx)
    if (!a.title.trim()) throw new ConvexError("Collection name is required")
    const handle = slugify(a.handle || a.title)
    const clash = await ctx.db.query("webCollections").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`A collection with the handle "${handle}" already exists`)
    const rules = a.rules && a.rules.conditions.length ? a.rules : undefined
    const row = { handle, title: a.title.trim(), html: a.html, image: a.image || null, seo: a.seo, productHandles: [...new Set(a.productHandles)], rules, sort: a.sort || undefined, updatedAt: Date.now() }
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

/** Takes a product off the website (Shopify "delete" for the website only): hidden, out of every collection, URL freed.
 *  The Ops product, its sizes, stock and orders are not touched; it can be added back from "Not added yet". */
export const removeFromWebsite = mutation({
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => {
    await requireWebsite(ctx)
    const p = await ctx.db.get(id)
    if (!p) throw new ConvexError("Product not found")
    if (p.handle) {
      for (const c of await ctx.db.query("webCollections").collect())
        if (c.productHandles.includes(p.handle)) await ctx.db.patch(c._id, { productHandles: c.productHandles.filter((h) => h !== p.handle), updatedAt: Date.now() })
    }
    await ctx.db.patch(id, { handle: undefined, web: p.web ? { ...p.web, published: false, updatedAt: Date.now() } : undefined })
    await queueRebuild(ctx)
  },
})

// ---------------- new product (Website → Add product) ----------------
/** Creates a new product the Shopify way, in one step: the product and its sizes (SKU, price, cost, weight) in Ops,
 *  plus its website page (photos, text, collections, SEO). Pre-order: the website price is the booking money
 *  (Tk 500 China / Tk 90 Bangladesh), the full price is the compare-at and the Ops price. */
export const createProduct = mutation({
  args: {
    title: v.string(),
    handle: v.string(),
    html: v.string(),
    vendor: v.string(),
    type: v.string(),
    tags: v.array(v.string()),
    seo: v.object({ title: v.string(), description: v.string() }),
    options: v.array(v.string()),
    images: v.array(imageV),
    mf: v.record(v.string(), v.string()),
    published: v.boolean(),
    preOrder: v.boolean(),
    preOrderFrom: v.union(v.literal("china"), v.literal("bangladesh")),
    collections: v.array(v.id("webCollections")),
    variants: v.array(v.object({
      sku: v.string(),
      title: v.string(),
      options: v.record(v.string(), v.string()),
      price: v.number(), // website selling price (pre-order: booking money)
      fullPrice: v.number(), // Ops price (the pair's full price)
      compareAt: v.union(v.number(), v.null()),
      cost: v.number(),
      weightKg: v.number(),
      barcode: v.optional(v.string()),
      testQty: v.optional(v.number()), // test (fake) pairs: stock on the website and in Shopify, marked "not in hand" in Ops
    })),
    templateSuffix: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requireWebsite(ctx)
    if (a.variants.some((x) => (x.testQty ?? 0) > 0) && !hasPerm(me.perms, "inventory.adjust")) throw new ConvexError("You don't have permission to add test stock.")
    const title = a.title.trim()
    if (!title) throw new ConvexError("Add a title")
    if (!a.variants.length) throw new ConvexError("Add at least one size")
    const skus = a.variants.map((x) => x.sku.trim().toUpperCase())
    if (skus.some((x) => !x)) throw new ConvexError("Every size needs a SKU")
    if (new Set(skus).size !== skus.length) throw new ConvexError("Two sizes have the same SKU")
    for (const sku of skus) {
      const clash = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (clash) throw new ConvexError(`SKU ${sku} is already used by another product`)
    }
    if (a.variants.some((x) => !(x.price > 0))) throw new ConvexError("Every size needs a price")
    const now = Date.now(), iso = new Date().toISOString()
    const optNames = a.options.map((o) => o.trim()).filter(Boolean)
    const tags = [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))]
    if (a.preOrder && !tags.some((t) => t.toLowerCase() === "pre-order")) tags.push("pre-order")
    const productId = await ctx.db.insert("products", {
      name: title, category: a.type.trim() || undefined, description: a.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || undefined,
      imageUrl: a.images[0]?.url, active: true, preOrder: a.preOrder || undefined, preOrderFrom: a.preOrder ? a.preOrderFrom : undefined, createdAt: now,
    })
    const handle = await uniqueHandle(ctx, a.handle || title, productId)
    await ctx.db.patch(productId, {
      handle,
      web: {
        id: `ops:${productId}`, title, html: a.html, vendor: a.vendor.trim() || "BlackBole", type: a.type.trim(), tags, category: a.category?.trim() || null,
        seo: { title: a.seo.title.trim(), description: a.seo.description.trim() },
        options: optNames.map((name) => ({ name, values: [] })),
        images: a.images.map((i) => ({ url: i.url, alt: i.alt ?? "", w: i.w ?? null, h: i.h ?? null })),
        mf: a.mf, published: a.published, createdAt: iso, publishedAt: a.published ? iso : undefined, updatedAt: now,
        ...(a.templateSuffix?.trim() ? { templateSuffix: a.templateSuffix.trim() } : {}),
      },
    })
    const testItems: { variantId: Id<"variants">; qty: number }[] = []
    for (const [i, x] of a.variants.entries()) {
      const opts: Record<string, string> = {}
      for (const n of optNames) if (x.options[n]?.trim()) opts[n] = x.options[n].trim()
      const variantId = await ctx.db.insert("variants", {
        productId, sku: skus[i], title: x.title.trim() || "Default", weightKg: x.weightKg > 0 ? x.weightKg : 0.5,
        price: Math.round(x.fullPrice > 0 ? x.fullPrice : x.price), purchasePrice: Math.max(0, Math.round(x.cost)), active: true, createdAt: now,
        web: { id: newVariantId(now + i), price: Math.round(x.price), compareAt: x.compareAt && x.compareAt > 0 ? Math.round(x.compareAt) : null, options: opts, image: null, pos: i, ...(x.barcode?.trim() ? { barcode: x.barcode.trim() } : {}) },
      })
      if ((x.testQty ?? 0) > 0 && !a.preOrder) testItems.push({ variantId, qty: Math.round(x.testQty!) })
    }
    if (testItems.length) await applyTestStock(ctx, testItems, me.staff.name)
    for (const cid of a.collections) {
      const c = await ctx.db.get(cid)
      if (c && !c.productHandles.includes(handle)) await ctx.db.patch(cid, { productHandles: [...c.productHandles, handle], updatedAt: now })
    }
    await queueRebuild(ctx)
    return productId
  },
})

/** SKUs already used (for the new-product form to warn early). */
export const skusTaken = query({
  args: { skus: v.array(v.string()) },
  handler: async (ctx, { skus }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return []
    const out: string[] = []
    for (const sku of skus.slice(0, 200)) {
      const x = sku.trim().toUpperCase()
      if (x && (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", x)).first())) out.push(x)
    }
    return out
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

/** Pre-order booking money, for every China pre-order pair at once (Settings → Booking money). Changes the website price of
 *  each size that is currently `from` (default Tk 500) to `to` (e.g. Tk 200), keeps the full price (compare-at), and pushes the
 *  change to Shopify. Bangladesh pre-orders (Tk 90 delivery advance) and anything not priced `from` are left alone.
 *  `apply: false` only counts what would change. */
export const setBookingMoney = mutation({
  args: { from: v.number(), to: v.number(), apply: v.boolean() },
  handler: async (ctx, { from, to, apply }) => {
    await requireWebsite(ctx)
    if (!(from > 0) || !(to > 0) || to > 5000) throw new ConvexError("Booking money must be between Tk 1 and Tk 5,000.")
    if (from === to) throw new ConvexError("The new amount is the same as the current one.")
    const prods = (await ctx.db.query("products").collect()).filter((p) => !p.deletedAt && p.preOrder && p.preOrderFrom !== "bangladesh")
    let products = 0, variants = 0
    const toPush: Id<"products">[] = []
    for (const p of prods) {
      const vs = (await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()).filter((x: any) => !x.deletedAt)
      const hit = vs.filter((x: any) => typeof x.web?.price === "number" && Math.round(x.web.price) === from)
      if (!hit.length) continue
      products++
      variants += hit.length
      if (!apply) continue
      for (const x of hit) await ctx.db.patch(x._id, { web: { ...x.web, price: to } })
      toPush.push(p._id)
    }
    if (apply && toPush.length) {
      await queueRebuild(ctx)
      for (const [i, id] of toPush.entries()) await ctx.scheduler.runAfter(i * 3000, internal.shopifyProducts.push, { productId: id }) // spaced out: Shopify rate limits
    }
    return { products, variants, applied: apply }
  },
})
