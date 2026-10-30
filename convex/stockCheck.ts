// Stock check: separates the pairs really in hand from fake (test) stock kept so a product can be advertised and
// ordered before it is bought. The team counts the real pairs; the system works out the fake part.
//
//   real = available − virtual          (never below 0)
//
// `available` itself is never changed here, so orders, the website and Pathao behave exactly as before. A stock-in
// (Purchases → receive) raises `available`, which raises real stock by itself: fake pairs turn real with no extra step.
// The revenue-target plan reads real pairs only (targets.ts).
import { v, ConvexError } from "convex/values"
import type { Id } from "./_generated/dataModel"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import { currentStaff, requirePerm } from "./lib"

export const realOf = (s: { available: number; virtual?: number }) => Math.max(0, s.available - Math.max(0, s.virtual ?? 0))
export const fakeOf = (s: { available: number; virtual?: number }) => Math.min(Math.max(0, s.available), Math.max(0, s.virtual ?? 0))

const PAGE = 30

export type CheckLine = { variantId: Id<"variants">; locationId: Id<"locations">; locationName: string; title: string; sku: string; available: number; fake: number; real: number; counted: boolean; countedBy: string | null; countedAt: number | null }
export type CheckProduct = { productId: Id<"products">; name: string; preOrder: boolean; system: number; fake: number; real: number; uncounted: boolean; lines: CheckLine[] }

/** A page of products with their size lines: system stock, counted real pairs and the fake remainder. */
export const list = query({
  args: { search: v.optional(v.string()), filter: v.union(v.literal("all"), v.literal("uncounted"), v.literal("test")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { search, filter, cursor }) => {
    if (!(await currentStaff(ctx))) return null
    const base = search?.trim()
      ? ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", search.trim()))
      : ctx.db.query("products")
    const res = await base.paginate({ cursor, numItems: PAGE })
    const locs = new Map((await ctx.db.query("locations").collect()).map((l) => [l._id as string, l.name]))
    const out: CheckProduct[] = []
    for (const p of res.page) {
      if (p.deletedAt || !p.active) continue
      const variants = (await ctx.db.query("variants").withIndex("by_product", (q) => q.eq("productId", p._id)).collect()).filter((x) => x.active)
      const lines: CheckLine[] = []
      for (const x of variants) {
        for (const s of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()) {
          if (s.available <= 0 && !(s.virtual ?? 0)) continue
          lines.push({
            variantId: x._id, locationId: s.locationId, locationName: locs.get(s.locationId as string) ?? "",
            title: x.title, sku: x.sku, available: s.available, fake: fakeOf(s), real: realOf(s),
            counted: s.countedAt !== undefined, countedBy: s.countedBy ?? null, countedAt: s.countedAt ?? null,
          })
        }
      }
      if (lines.length === 0) continue
      const system = lines.reduce((t, l) => t + l.available, 0)
      const fake = lines.reduce((t, l) => t + l.fake, 0)
      const uncounted = lines.some((l) => !l.counted && l.available > 0)
      if (filter === "uncounted" && !uncounted) continue
      if (filter === "test" && fake === 0) continue
      out.push({ productId: p._id, name: p.name, preOrder: !!p.preOrder, system, fake, real: system - fake, uncounted, lines })
    }
    return { products: out, isDone: res.isDone, cursor: res.continueCursor }
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
        await setLine(ctx, me.staff.name, x._id, s.locationId, mode === "test" ? 0 : Math.max(0, s.available), mode === "test" ? "Marked as test stock — none in hand" : "Marked all real")
      }
    }
  },
})
