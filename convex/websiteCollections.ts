// Website → Collections (Shopify's Products → Collections): the list page, publishing on/off, theme layout and
// bulk actions. Product facts here use the same rules engine (convex/websiteRules.ts) as the website build, so the
// product counts shown match what shoppers see. Nothing here changes stock, prices or orders.
import { v, ConvexError } from "convex/values"
import { query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { mutation } from "./functions"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"
import { describeRules, isAutomatic, matchesRules, type Rules, type SortKey } from "./websiteRules"
import { queueRebuild, slugify, webPrice } from "./website"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")

async function requireWebsite(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

// ---------------- pure helpers (tested) ----------------
/** Sellable pairs per variant: "available" in active courier warehouses (same rule as the website's live stock). */
export function sellableByVariant(locations: Doc<"locations">[], stock: Doc<"stock">[]) {
  const ok = new Set(locations.filter((l) => l.active && !l.noCourier).map((l) => l._id as string))
  const out = new Map<string, number>()
  for (const r of stock) if (ok.has(r.locationId as string)) out.set(r.variantId as string, (out.get(r.variantId as string) ?? 0) + r.available)
  return out
}

export type ProductFact = {
  _id: Id<"products">; handle: string; title: string; published: boolean; image: string | null; type: string; vendor: string
  tags: string[]; prices: number[]; compareAts: number[]; stock: number; preOrder: boolean; createdAt: string
}

const isPreTag = (tags: unknown) => Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === "pre-order")

/** What the rules engine needs to know about every website product (one with a URL handle), keyed by handle. */
export function productFacts(products: Doc<"products">[], variants: Doc<"variants">[], sellable: Map<string, number>) {
  const agg = new Map<string, { stock: number; prices: number[]; compareAts: number[] }>()
  for (const vr of variants) {
    if (!vr.active) continue
    const owner = (vr.web?.parent ?? vr.productId) as string
    const a = agg.get(owner) ?? { stock: 0, prices: [], compareAts: [] }
    a.stock += Math.max(0, sellable.get(vr._id as string) ?? 0)
    a.prices.push(webPrice(vr))
    if (typeof vr.web?.compareAt === "number" && vr.web.compareAt > 0) a.compareAts.push(vr.web.compareAt)
    agg.set(owner, a)
  }
  const out = new Map<string, ProductFact>()
  for (const p of products) {
    if (!p.handle || p.deletedAt) continue
    const w: any = p.web ?? {}
    const a = agg.get(p._id as string)
    out.set(p.handle, {
      _id: p._id, handle: p.handle, title: String(w.title || p.name), published: !!w.published,
      image: (w.images?.[0]?.url ?? p.imageUrl ?? null) as string | null,
      type: String(w.type || p.category || ""), vendor: String(w.vendor ?? ""),
      tags: Array.isArray(w.tags) ? w.tags.map(String) : [], prices: a?.prices ?? [], compareAts: a?.compareAts ?? [],
      stock: a?.stock ?? 0, preOrder: !!p.preOrder || isPreTag(w.tags),
      createdAt: String(w.publishedAt || w.createdAt || new Date(p.createdAt).toISOString()),
    })
  }
  return out
}

/** Handles in a collection right now: the picked list for a manual one; for an automatic one every product
 *  matching its conditions (newly matching ones first), exactly like the editor preview and the website build. */
export function collectionMembers(c: { productHandles: string[]; rules?: unknown }, facts: Map<string, ProductFact>): string[] {
  const kept = c.productHandles.filter((h) => facts.has(h))
  const rules = (c.rules ?? null) as Rules | null
  if (!isAutomatic(rules)) return kept
  const hits = [...facts.values()].filter((p) => matchesRules({ tags: p.tags, type: p.type, vendor: p.vendor, title: p.title, prices: p.prices, compareAts: p.compareAts, inStock: p.stock > 0 || p.preOrder }, rules))
  const hitSet = new Set(hits.map((p) => p.handle))
  const stay = kept.filter((h) => hitSet.has(h))
  const added = hits.filter((p) => !stay.includes(p.handle)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((p) => p.handle)
  return [...added, ...stay]
}

/** Collection layouts in a theme: template keys "collection" and "collection.<suffix>". */
export function collectionTemplates(themeJson: string | null | undefined): string[] {
  if (!themeJson) return []
  try {
    const t = JSON.parse(themeJson)?.templates
    if (!t || typeof t !== "object") return []
    return Object.keys(t).filter((k) => k.startsWith("collection.")).map((k) => k.slice("collection.".length)).filter(Boolean).sort()
  } catch { return [] }
}

export async function loadFacts(ctx: QueryCtx) {
  const locations = await ctx.db.query("locations").collect()
  const stock = await ctx.db.query("stock").collect()
  const products = await ctx.db.query("products").collect()
  const variants = await ctx.db.query("variants").collect()
  return { locations, stock, products, variants, facts: productFacts(products, variants, sellableByVariant(locations, stock)) }
}

async function liveTemplates(ctx: QueryCtx) {
  const live = await ctx.db.query("webThemes").withIndex("by_role", (q) => q.eq("role", "live")).first()
  return collectionTemplates(live?.json)
}

// ---------------- reads ----------------
export const list = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const { facts } = await loadFacts(ctx)
    const rows = await ctx.db.query("webCollections").collect()
    return rows
      .map((c) => {
        const handles = collectionMembers(c, facts)
        const ps = handles.map((h) => facts.get(h)!).filter(Boolean)
        const rules = (c.rules ?? null) as Rules | null
        return {
          _id: c._id, handle: c.handle, title: c.title, updatedAt: c.updatedAt,
          image: c.image ?? null, thumbs: ps.filter((p) => p.image).slice(0, 4).map((p) => p.image as string),
          total: ps.length, live: ps.filter((p) => p.published).length,
          automatic: isAutomatic(rules), match: rules?.match ?? "all", conditions: describeRules(rules),
          published: c.published !== false, templateSuffix: c.templateSuffix ?? null, sort: (c.sort ?? "manual") as SortKey,
          hasDescription: String(c.html ?? "").replace(/<[^>]*>/g, "").trim().length > 0,
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  },
})

/** Publishing + theme layout for the collection editor (the rest comes from website.collection). */
export const meta = query({
  args: { id: v.optional(v.id("webCollections")) },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const c = id ? await ctx.db.get(id) : null
    return { published: c ? c.published !== false : true, templateSuffix: c?.templateSuffix ?? null, templates: await liveTemplates(ctx) }
  },
})

// ---------------- edits ----------------
const conditionV = v.object({ field: v.string(), op: v.string(), values: v.array(v.string()), all: v.optional(v.boolean()) })

export const save = mutation({
  args: {
    id: v.optional(v.id("webCollections")),
    handle: v.string(),
    title: v.string(),
    html: v.string(),
    image: v.union(v.string(), v.null()),
    seo: v.object({ title: v.string(), description: v.string() }),
    productHandles: v.array(v.string()),
    rules: v.optional(v.union(v.null(), v.object({ match: v.union(v.literal("all"), v.literal("any")), conditions: v.array(conditionV) }))),
    sort: v.optional(v.string()),
    published: v.boolean(),
    templateSuffix: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, a) => {
    await requireWebsite(ctx)
    if (!a.title.trim()) throw new ConvexError("Collection name is required")
    const handle = slugify(a.handle || a.title)
    const clash = await ctx.db.query("webCollections").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`A collection with the handle "${handle}" already exists`)
    if (a.id && !(await ctx.db.get(a.id))) throw new ConvexError("Collection not found")
    const conds = (a.rules?.conditions ?? []).filter((c) => c.field).map((c) => ({ field: c.field, op: c.op, values: c.values.map((x) => x.trim()).filter(Boolean), ...(c.all ? { all: true } : {}) }))
    const rules = a.rules && conds.length ? { match: a.rules.match, conditions: conds } : undefined
    const row = {
      handle, title: a.title.trim(), html: a.html, image: a.image || null, seo: { title: a.seo.title.trim(), description: a.seo.description.trim() },
      productHandles: [...new Set(a.productHandles)], rules, sort: a.sort || undefined,
      published: a.published, templateSuffix: a.templateSuffix?.trim() || undefined, updatedAt: Date.now(),
    }
    const id = a.id ? (await ctx.db.patch(a.id, row), a.id) : await ctx.db.insert("webCollections", row)
    await queueRebuild(ctx)
    return id
  },
})

export const setPublished = mutation({
  args: { ids: v.array(v.id("webCollections")), published: v.boolean() },
  handler: async (ctx, { ids, published }) => {
    await requireWebsite(ctx)
    let n = 0
    for (const id of ids.slice(0, 500)) {
      const c = await ctx.db.get(id)
      if (!c) continue
      await ctx.db.patch(id, { published, updatedAt: Date.now() })
      n++
    }
    await queueRebuild(ctx)
    return n
  },
})

export const remove = mutation({
  args: { ids: v.array(v.id("webCollections")) },
  handler: async (ctx, { ids }) => {
    await requireWebsite(ctx)
    let n = 0
    for (const id of ids.slice(0, 500)) {
      if (!(await ctx.db.get(id))) continue
      await ctx.db.delete(id)
      n++
    }
    await queueRebuild(ctx)
    return n
  },
})
