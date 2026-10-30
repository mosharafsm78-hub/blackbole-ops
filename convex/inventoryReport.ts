// Comprehensive Inventory Report (Phase 1 · Task 2).
//
// READ-ONLY and fully additive: this module only reads the existing `products`, `variants`, `stock` and
// `orders` tables. It adds no fields, no indexes and no writes, so live customer-care and fulfillment data
// is untouched. The Inventory page renders it in a new "Report" tab next to the existing Stock / Movements
// tabs, which keep working exactly as before.
//
// One row per product + colour + WAREHOUSE, with the size breakdown across 40–44, because that is how the
// team actually buys and sells (a "Harbor Shore Sandal · Black" is one decision, not five) *and* because
// stock physically sits at one warehouse at a time — a row with no location was impossible to act on
// ("where do I even send someone to go count this?"). Each row still carries the base SKU so it can be
// matched back to the variant SKUs in the Stock tab.

import { v } from "convex/values"
import { query } from "./_generated/server"
import { currentStaff } from "./lib"
import { COMMITTED_STATUSES } from "./rules"

/** The sizes the report breaks down. Anything else a product has is still counted in the totals. */
export const REPORT_SIZES = ["40", "41", "42", "43", "44"] as const

const DAY = 86400000
const VELOCITY_DAYS = 30

/** "Black / 42" → { color: "Black", size: "42" }. Tolerates "Black-42", "42", "Black / 42 / Wide". */
export function splitVariant(title: string, attrs?: string): { color: string; size: string } {
  const raw = (attrs || title || "").trim()
  if (!raw) return { color: "", size: "" }
  // "Black-41" / "Black_41" read the same as "Black / 41" — normalise the separator before splitting.
  const parts = raw
    .replace(/(\d{2,3})\s*$/, " / $1")
    .split(/\s*[/|,]\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
  let size = ""
  let color = ""
  for (const p of parts) {
    if (!size && /^\d{2,3}$/.test(p)) size = p
    else if (!color) color = p
  }
  if (!size) {
    const m = raw.match(/(\d{2,3})\s*$/)
    if (m) size = m[1]
  }
  if (!color && parts.length > 1) color = parts[0]
  // "Black-" / "Black_" left over from a hyphenated title.
  color = color.replace(/[-_/|,\s]+$/, "").trim()
  return { color, size }
}

/** "BB-HSS-41" + size "41" → "BB-HSS". Falls back to the full SKU when there is nothing to strip. */
export function baseSku(sku: string, size: string): string {
  if (!size) return sku
  const stripped = sku.replace(new RegExp(`[-_/ ]?${size}$`), "")
  return stripped || sku
}

type SizeCell = { size: string; sku: string; available: number; committed: number; exists: boolean }

export const summary = query({
  args: { lowStockThreshold: v.optional(v.number()) },
  handler: async (ctx, { lowStockThreshold }) => {
    const staff = await currentStaff(ctx)
    if (!staff) return null

    const threshold = Math.max(0, Math.floor(lowStockThreshold ?? 3))
    const now = Date.now()
    const since = now - VELOCITY_DAYS * DAY

    const products = await ctx.db.query("products").collect()
    const productById = new Map(products.map((p) => [p._id as string, p]))
    const variants = await ctx.db.query("variants").collect()
    const variantById = new Map(variants.map((vr) => [vr._id as string, vr]))

    const locations = await ctx.db.query("locations").collect()
    const locationById = new Map(locations.map((l) => [l._id as string, l]))
    const locationName = (id: string) => locationById.get(id)?.name ?? "Unknown warehouse"

    // Available / processing / in transit, per (variant, warehouse) — stock physically sits at one
    // warehouse, so a row that doesn't say which one is useless to someone trying to go count it.
    const stockByVariantLoc = new Map<string, { available: number; processing: number; inTransit: number }>()
    const locationsByVariant = new Map<string, Set<string>>()
    const stockRows = await ctx.db.query("stock").collect()
    for (const r of stockRows) {
      const variantId = r.variantId as string
      const locId = r.locationId as string
      stockByVariantLoc.set(`${variantId}|${locId}`, {
        available: r.available,
        processing: r.processing,
        inTransit: r.inTransit,
      })
      const set = locationsByVariant.get(variantId) ?? new Set<string>()
      set.add(locId)
      locationsByVariant.set(variantId, set)
    }

    // Committed = units sitting on orders that have not shipped yet, attributed to the order's own
    // warehouse (`order.locationId`) so "Committed" lines up with the same warehouse as the stock cards.
    const committedByVariantLoc = new Map<string, number>()
    for (const status of COMMITTED_STATUSES) {
      const rows = await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()
      for (const o of rows) {
        if (o.deletedAt) continue
        for (const i of o.items) {
          if (!i.variantId) continue
          const key = `${i.variantId}|${o.locationId}`
          committedByVariantLoc.set(key, (committedByVariantLoc.get(key) ?? 0) + i.qty)
        }
      }
    }

    // 30-day run-rate: units actually sold (cancelled orders excluded), also by warehouse.
    const soldByVariantLoc = new Map<string, number>()
    const recent = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", since))
      .collect()
    for (const o of recent) {
      if (o.deletedAt || o.status === "cancelled") continue
      for (const i of o.items) {
        if (!i.variantId) continue
        const key = `${i.variantId}|${o.locationId}`
        soldByVariantLoc.set(key, (soldByVariantLoc.get(key) ?? 0) + i.qty)
      }
    }

    type Group = {
      key: string
      productId: string
      productTitle: string
      color: string
      locationId: string
      locationName: string
      skus: string[]
      sizes: Map<string, SizeCell>
      available: number
      committed: number
      processing: number
      inTransit: number
      units30: number
      stockValue: number
    }

    // Pass 1: group variants by product + colour, same as before splitting by warehouse — this is what
    // keeps a size that has never been stocked (e.g. a new size 40 with zero units) showing as a real,
    // zero-stock cell instead of silently vanishing from the report.
    type ColorGroup = { productId: string; productTitle: string; color: string; variantIds: string[] }
    const colorGroups = new Map<string, ColorGroup>()
    for (const vr of variants) {
      const product = productById.get(vr.productId as string)
      if (!product || product.deletedAt) continue
      const { color } = splitVariant(vr.title, vr.attrs)
      const key = `${vr.productId as string}|${color.toLowerCase()}`
      let cg = colorGroups.get(key)
      if (!cg) {
        cg = { productId: vr.productId as string, productTitle: product.name, color, variantIds: [] }
        colorGroups.set(key, cg)
      }
      cg.variantIds.push(vr._id as string)
    }

    const defaultLocationId = (locations.find((l) => l.isDefault) ?? locations[0])?._id as string | undefined

    // Pass 2: fan each colour group out across every warehouse that actually holds stock for one of its
    // variants (falling back to the default warehouse if the colour has never been stocked anywhere, so
    // a brand-new product still shows up as one row rather than disappearing entirely).
    const groups = new Map<string, Group>()
    for (const cg of colorGroups.values()) {
      const locIds = new Set<string>()
      for (const variantId of cg.variantIds) {
        for (const locId of locationsByVariant.get(variantId) ?? []) locIds.add(locId)
      }
      if (locIds.size === 0 && defaultLocationId) locIds.add(defaultLocationId)

      for (const locId of locIds) {
        const key = `${cg.productId}|${cg.color.toLowerCase()}|${locId}`
        const g: Group = {
          key,
          productId: cg.productId,
          productTitle: cg.productTitle,
          color: cg.color,
          locationId: locId,
          locationName: locationName(locId),
          skus: [],
          sizes: new Map(),
          available: 0,
          committed: 0,
          processing: 0,
          inTransit: 0,
          units30: 0,
          stockValue: 0,
        }
        for (const variantId of cg.variantIds) {
          const vr = variantById.get(variantId)
          if (!vr) continue
          const { size } = splitVariant(vr.title, vr.attrs)
          const vlKey = `${variantId}|${locId}`
          const st = stockByVariantLoc.get(vlKey) ?? { available: 0, processing: 0, inTransit: 0 }
          const committed = committedByVariantLoc.get(vlKey) ?? 0
          const units30 = soldByVariantLoc.get(vlKey) ?? 0

          g.skus.push(vr.sku)
          g.available += st.available
          g.committed += committed
          g.processing += st.processing
          g.inTransit += st.inTransit
          g.units30 += units30
          g.stockValue += Math.max(0, st.available) * vr.price

          const sizeKey = size || "—"
          const cell = g.sizes.get(sizeKey)
          if (cell) {
            cell.available += st.available
            cell.committed += committed
          } else {
            g.sizes.set(sizeKey, { size: sizeKey, sku: vr.sku, available: st.available, committed, exists: true })
          }
        }
        groups.set(key, g)
      }
    }

    const rows = [...groups.values()].map((g) => {
      // Every report size is shown, so a missing size reads as "no such variant" rather than a silent gap.
      const breakdown: SizeCell[] = REPORT_SIZES.map((size) => {
        const cell = g.sizes.get(size)
        return cell ?? { size, sku: "", available: 0, committed: 0, exists: false }
      })
      const extra = [...g.sizes.values()].filter((c) => !(REPORT_SIZES as readonly string[]).includes(c.size))
      const all = [...breakdown, ...extra]

      // A row is only "ok" when the total is healthy AND no single size has run down to the threshold —
      // 10 pairs in size 41 does not help a customer who wants a 42.
      const anySizeLow = all.some((c) => c.exists && c.available <= threshold)
      const status: "out" | "low" | "ok" =
        g.available <= 0 ? "out" : g.available <= threshold || anySizeLow ? "low" : "ok"

      const perDay = g.units30 / VELOCITY_DAYS
      const daysCover = perDay > 0 ? Math.round((g.available / perDay) * 10) / 10 : null

      return {
        key: g.key,
        productId: g.productId,
        productTitle: g.productTitle,
        color: g.color || "—",
        locationId: g.locationId,
        locationName: g.locationName,
        sku: baseSku(g.skus[0] ?? "", all.find((c) => c.exists)?.size ?? ""),
        variantSkus: g.skus.sort(),
        sizes: all,
        sizeBreakdown: all
          .map((c) => `${c.size}: ${c.exists ? c.available : "–"}`)
          .join(" · "),
        available: g.available,
        committed: g.committed,
        processing: g.processing,
        inTransit: g.inTransit,
        units30: g.units30,
        perDay: Math.round(perDay * 100) / 100,
        daysCover,
        stockValue: g.stockValue,
        status,
      }
    })

    rows.sort(
      (a, b) =>
        a.productTitle.localeCompare(b.productTitle) ||
        a.color.localeCompare(b.color) ||
        a.locationName.localeCompare(b.locationName),
    )

    // Dashboard aggregates.
    const bySize = REPORT_SIZES.map((size) => {
      let available = 0
      let committed = 0
      let skus = 0
      for (const g of groups.values()) {
        const cell = g.sizes.get(size)
        if (!cell) continue
        available += cell.available
        committed += cell.committed
        skus++
      }
      return { size, available, committed, skus }
    })

    const totals = rows.reduce(
      (t, r) => ({
        available: t.available + Math.max(0, r.available),
        shortage: t.shortage + (r.available < 0 ? -r.available : 0),
        committed: t.committed + r.committed,
        processing: t.processing + r.processing,
        inTransit: t.inTransit + r.inTransit,
        units30: t.units30 + r.units30,
        stockValue: t.stockValue + r.stockValue,
        low: t.low + (r.status === "low" ? 1 : 0),
        out: t.out + (r.status === "out" ? 1 : 0),
      }),
      {
        available: 0,
        shortage: 0,
        committed: 0,
        processing: 0,
        inTransit: 0,
        units30: 0,
        stockValue: 0,
        low: 0,
        out: 0,
      },
    )

    const perDay = totals.units30 / VELOCITY_DAYS

    const warehouses = locations
      .filter((l) => l.active)
      .map((l) => ({ id: l._id as string, name: l.name }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return {
      generatedAt: now,
      threshold,
      velocityDays: VELOCITY_DAYS,
      rows,
      warehouses,
      bySize,
      totals: {
        ...totals,
        products: rows.length,
        skus: variants.length,
        perDay: Math.round(perDay * 100) / 100,
        daysCover: perDay > 0 ? Math.round((totals.available / perDay) * 10) / 10 : null,
      },
      topMovers: [...rows].sort((a, b) => b.units30 - a.units30).slice(0, 8),
      needsAttention: rows
        .filter((r) => r.status !== "ok")
        .sort((a, b) => a.available - b.available)
        .slice(0, 10),
    }
  },
})
