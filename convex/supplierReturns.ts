// Goods bought from a supplier sometimes have to go back — arrived damaged, wrong item, expired, or any other
// reason the supplier owns. This is the mirror image of catalog.receiveStock: stock leaves the warehouse the
// moment the return is created (it's no longer here to sell or use), and what the supplier actually does about
// it — refund, credit note, replacement, or rejects it — is recorded afterward as a separate step that never
// re-touches stock a second time.
import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { bumpStock, getStockRow, nextCounter, requirePerm } from "./lib"
// getStockRow (used by `create`) requires a MutationCtx since it can insert a missing row; `poStockLevels` is a
// read-only query and looks the row up directly instead (see below).
import { creditSupplierAccount } from "./purchasing"

export const srCode = (n: number) => `SR-${String(n).padStart(4, "0")}`

/** Every open (pending/sent) return for one supplier, newest first — shown on the supplier's own page. */
export const listForSupplier = query({
  args: { supplierId: v.id("suppliers") },
  handler: async (ctx, { supplierId }) => {
    await requirePerm(ctx, "purchases.manage")
    return await ctx.db.query("supplierReturns").withIndex("by_supplier", (q) => q.eq("supplierId", supplierId)).order("desc").collect()
  },
})

/** Live Damaged/Available stock for a PO's own items at its own location — what the "Return to supplier"
 *  dialog shows per line, so the person picking a quantity sees what's actually there right now, not just
 *  what the PO's own running totals say (stock may have moved since). */
export const poStockLevels = query({
  args: { poId: v.id("purchaseOrders") },
  handler: async (ctx, { poId }) => {
    await requirePerm(ctx, "purchases.manage")
    const po = await ctx.db.get(poId)
    if (!po) return null
    const out: Record<string, { damaged: number; available: number }> = {}
    for (const i of po.items) {
      // Read-only lookup — unlike bumpStock's getStockRow, this never creates a missing row, since a query
      // can't write; a variant with no stock row yet simply has nothing to return.
      const row = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", i.variantId).eq("locationId", po.locationId)).unique()
      out[i.variantId as string] = { damaged: row?.damaged ?? 0, available: row?.available ?? 0 }
    }
    return out
  },
})

/** Create a return: pick items (and the bucket they're coming out of — almost always "damaged"), validate
 *  there's actually that much stock to send back, move it out of the warehouse right away, and open the
 *  paperwork trail. */
export const create = mutation({
  args: {
    supplierId: v.id("suppliers"),
    locationId: v.id("locations"),
    poId: v.optional(v.id("purchaseOrders")),
    reason: v.string(),
    note: v.optional(v.string()),
    items: v.array(v.object({
      variantId: v.id("variants"),
      qty: v.number(),
      bucket: v.union(v.literal("damaged"), v.literal("available")),
    })),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "purchases.manage")
    const reason = a.reason.trim()
    if (!reason) throw new ConvexError("Say why these are going back — not in good condition, wrong item, etc.")
    const lines = a.items.filter((i) => i.qty > 0)
    if (!lines.length) throw new ConvexError("Enter a quantity for at least one product.")
    const sp = await ctx.db.get(a.supplierId)
    if (!sp) throw new ConvexError("Supplier not found")

    const items: Doc<"supplierReturns">["items"] = []
    for (const l of lines) {
      const vr = await ctx.db.get(l.variantId)
      if (!vr) throw new ConvexError("A product on this return no longer exists")
      const product = await ctx.db.get(vr.productId)
      const row = await getStockRow(ctx, l.variantId, a.locationId)
      const onHand = (row as any)[l.bucket] as number
      if (l.qty > onHand) throw new ConvexError(`${vr.sku}: only ${onHand} in ${l.bucket === "damaged" ? "Damaged" : "Available"} to send back`)
      items.push({ variantId: l.variantId, sku: vr.sku, name: product?.name ?? vr.sku, title: vr.title, qty: l.qty, unitCost: vr.purchasePrice || 0, bucket: l.bucket })
    }

    const code = await nextCounter(ctx, "supplierReturn", 1)
    const totalValue = items.reduce((t, i) => t + i.qty * i.unitCost, 0)
    const id = await ctx.db.insert("supplierReturns", {
      code, supplierId: a.supplierId, supplierName: sp.name, locationId: a.locationId, poId: a.poId,
      items, totalValue, reason, note: a.note?.trim() || undefined, status: "pending",
      files: [], createdBy: me.staff.name, createdAt: Date.now(),
    })
    for (const i of items) {
      await bumpStock(ctx, {
        variantId: i.variantId, locationId: a.locationId, bucket: i.bucket as "damaged" | "available", change: -i.qty,
        reason: `Sent back to ${sp.name} (${srCode(code)}): ${reason}`, byName: me.staff.name,
      })
    }
    return { id, code }
  },
})

/** Mark a return as physically on its way — purely a status/paper-trail step, no stock movement (that already
 *  happened at create time). */
export const markSent = mutation({
  args: { id: v.id("supplierReturns") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "purchases.manage")
    const r = await ctx.db.get(id)
    if (!r) throw new ConvexError("Return not found")
    if (r.status !== "pending") return
    await ctx.db.patch(id, { status: "sent", sentAt: Date.now() })
  },
})

/** Close out a return with what the supplier actually did about it. A refund or credit note is applied to the
 *  supplier's account exactly like a cash payment (reduces what we owe them), through the same due-clearing
 *  order a real payment uses — so the statement reads correctly without a second, separate "credit" concept. */
export const resolve = mutation({
  args: {
    id: v.id("supplierReturns"),
    resolution: v.union(v.literal("refunded"), v.literal("credited"), v.literal("replaced"), v.literal("rejected")),
    resolutionNote: v.optional(v.string()),
    creditedAmount: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "purchases.manage")
    const r = await ctx.db.get(a.id)
    if (!r) throw new ConvexError("Return not found")
    if (r.status === "resolved") throw new ConvexError("Already resolved")
    const creditedAmount = a.creditedAmount && a.creditedAmount > 0 ? a.creditedAmount : undefined
    if ((a.resolution === "refunded" || a.resolution === "credited") && !creditedAmount) {
      throw new ConvexError("Enter the amount actually refunded or credited.")
    }
    await ctx.db.patch(a.id, {
      status: "resolved", resolution: a.resolution, resolutionNote: a.resolutionNote?.trim() || undefined,
      creditedAmount, resolvedAt: Date.now(), resolvedByName: me.staff.name,
    })
    if (creditedAmount) {
      await creditSupplierAccount(ctx, r.supplierId, creditedAmount, {
        method: a.resolution === "refunded" ? "Supplier refund — return" : "Supplier credit note — return",
        reference: srCode(r.code), note: `${srCode(r.code)}: ${r.reason}`, byName: me.staff.name, preferPoId: r.poId,
      })
    }
  },
})
