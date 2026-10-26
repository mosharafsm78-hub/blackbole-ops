// Website → Inventory (Shopify's Products → Inventory): one row per size/variant with Unavailable / Committed /
// Available / On hand. Stock is owned by Ops (stock table); this file only READS it. Changing a quantity on the
// Inventory screen calls Ops' own catalog.adjustStock (same permission "inventory.adjust", same stock log).
//
// Column meaning (Ops buckets → Shopify words):
//   Unavailable = damaged + wastage + expired      Committed = processing (reserved by approved orders)
//   Available   = available (ready to sell)        On hand   = unavailable + committed + available
//   (In transit = with the courier, Returning = coming back; shown as extra info, not part of On hand)
import { v } from "convex/values"
import { query } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"
import { collectionMembers, loadFacts } from "./websiteCollections"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")

export type InvRow = {
  variantId: Id<"variants">; sku: string; variantTitle: string
  productTitle: string; opsName: string; productId: Id<"products">; onWebsite: boolean; setUp: boolean; preOrder: boolean
  image: string | null; type: string; collections: string[]
  unavailable: number; committed: number; available: number; onHand: number; inTransit: number; returning: number
}

/** Pure: build the Inventory rows. `locationId` limits the quantities to one warehouse; otherwise all are added up. */
export function inventoryRows(input: {
  products: Doc<"products">[]
  variants: Doc<"variants">[]
  stock: Doc<"stock">[]
  locationId?: string | null
  collectionsByHandle?: Map<string, string[]>
}): InvRow[] {
  const byId = new Map(input.products.map((p) => [p._id as string, p]))
  type Sum = { available: number; processing: number; inTransit: number; returning: number; unavailable: number }
  const sums = new Map<string, Sum>()
  for (const r of input.stock) {
    if (input.locationId && r.locationId !== input.locationId) continue
    const s = sums.get(r.variantId as string) ?? { available: 0, processing: 0, inTransit: 0, returning: 0, unavailable: 0 }
    s.available += r.available; s.processing += r.processing; s.inTransit += r.inTransit; s.returning += r.returning
    s.unavailable += r.damaged + (r.wastage ?? 0) + (r.expired ?? 0)
    sums.set(r.variantId as string, s)
  }
  const rows: InvRow[] = []
  for (const vr of input.variants) {
    const own = byId.get(vr.productId as string)
    if (!vr.active || !own || !own.active || own.deletedAt) continue
    const parent = vr.web?.parent ? byId.get(vr.web.parent as string) : undefined
    const owner = parent && !parent.deletedAt ? parent : own
    const w: any = owner.web ?? {}
    const s = sums.get(vr._id as string) ?? { available: 0, processing: 0, inTransit: 0, returning: 0, unavailable: 0 }
    rows.push({
      variantId: vr._id, sku: vr.sku, variantTitle: vr.title,
      productTitle: String(w.title || owner.name), opsName: own.name, productId: owner._id,
      onWebsite: !!w.published && !!owner.handle, setUp: !!owner.handle && !!owner.web,
      preOrder: !!owner.preOrder || !!own.preOrder || (Array.isArray(w.tags) && w.tags.some((t: any) => String(t).toLowerCase() === "pre-order")),
      image: (vr.web?.image ?? w.images?.[0]?.url ?? owner.imageUrl ?? own.imageUrl ?? vr.imageUrl ?? null) as string | null,
      type: String(w.type || owner.category || own.category || ""),
      collections: owner.handle ? input.collectionsByHandle?.get(owner.handle) ?? [] : [],
      unavailable: s.unavailable, committed: s.processing, available: s.available,
      onHand: s.unavailable + s.processing + s.available, inTransit: s.inTransit, returning: s.returning,
    })
  }
  return rows.sort((a, b) => a.productTitle.localeCompare(b.productTitle) || a.variantTitle.localeCompare(b.variantTitle, undefined, { numeric: true }))
}

export const list = query({
  args: { locationId: v.optional(v.id("locations")) },
  handler: async (ctx, { locationId }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const { locations, stock, products, variants, facts } = await loadFacts(ctx)
    const colls = await ctx.db.query("webCollections").collect()
    const byHandle = new Map<string, string[]>()
    for (const c of colls) for (const h of collectionMembers(c, facts)) byHandle.set(h, [...(byHandle.get(h) ?? []), c._id as string])
    const rows = inventoryRows({ products, variants, stock, locationId, collectionsByHandle: byHandle })
    return {
      rows,
      locations: locations.filter((l) => l.active).sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
        .map((l) => ({ _id: l._id, name: l.name, courier: !l.noCourier })),
      collections: colls.map((c) => ({ _id: c._id, title: c.title })).sort((a, b) => a.title.localeCompare(b.title)),
      types: [...new Set(rows.map((r) => r.type).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      canAdjust: hasPerm(s.perms, "inventory.adjust"),
    }
  },
})
