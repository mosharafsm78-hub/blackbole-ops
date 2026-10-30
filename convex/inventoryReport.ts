// Comprehensive Inventory Report (Phase 1 · Task 2).
//
// READ-ONLY and fully additive: this module only reads the existing `products`, `variants`, `stock` and
// `orders` tables. It adds no fields, no indexes and no writes, so live customer-care and fulfillment data
// is untouched. The Inventory page renders it in a new "Report" tab next to the existing Stock / Movements
// tabs, which keep working exactly as before.
//
// One row per product + colour, with the size breakdown across 40–44, because that is how the team actually
// buys and sells (a "Harbor Shore Sandal · Black" is one decision, not five). Each row still carries the
// base SKU so it can be matched back to the variant SKUs in the Stock tab.

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

    // Available / processing / in transit, summed across every warehouse.
    const stockByVariant = new Map<string, { available: number; processing: number; inTransit: number }>()
    for (const r of await ctx.db.query("stock").collect()) {
      const cur = stockByVariant.get(r.variantId) ?? { available: 0, processing: 0, inTransit: 0 }
      cur.available += r.available
      cur.processing += r.processing
      cur.inTransit += r.inTransit
      stockByVariant.set(r.variantId, cur)
    }

    // Committed = units sitting on orders that have not shipped yet.
    const committedByVariant = new Map<string, number>()
    for (const status of COMMITTED_STATUSES) {
      const rows = await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()
      for (const o of rows) {
        if (o.deletedAt) continue
        for (const i of o.items) {
          const key = i.variantId ? (i.variantId as string) : `sku:${i.sku}`
          committedByVariant.set(key, (committedByVariant.get(key) ?? 0) + i.qty)
        }
      }
    }

    // 30-day run-rate: units actually sold (cancelled orders excluded).
    const soldByVariant = new Map<string, number>()
    const recent = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", since))
      .collect()
    for (const o of recent) {
      if (o.deletedAt || o.status === "cancelled") continue
      for (const i of o.items) {
        const key = i.variantId ? (i.variantId as string) : `sku:${i.sku}`
        soldByVariant.set(key, (soldByVariant.get(key) ?? 0) + i.qty)
      }
    }

    type Group = {
      key: string
      productId: string
      productTitle: string
      color: string
      skus: string[]
      sizes: Map<string, SizeCell>
      available: number
      committed: number
      processing: number
      inTransit: number
      units30: number
      stockValue: number
    }
    const groups = new Map<string, Group>()

    for (const vr of variants) {
      const product = productById.get(vr.productId as string)
      if (!product || product.deletedAt) continue
      const { color, size } = splitVariant(vr.title, vr.attrs)
      const key = `${vr.productId as string}|${color.toLowerCase()}`
      let g = groups.get(key)
      if (!g) {
        g = {
          key,
          productId: vr.productId as string,
          productTitle: product.name,
          color,
          skus: [],
          sizes: new Map(),
          available: 0,
          committed: 0,
          processing: 0,
          inTransit: 0,
          units30: 0,
          stockValue: 0,
        }
        groups.set(key, g)
      }
      const st = stockByVariant.get(vr._id) ?? { available: 0, processing: 0, inTransit: 0 }
      const committed = committedByVariant.get(vr._id as string) ?? 0
      const units30 = soldByVariant.get(vr._id as string) ?? 0

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
        a.productTitle.localeCompare(b.productTitle) || a.color.localeCompare(b.color),
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

    return {
      generatedAt: now,
      threshold,
      velocityDays: VELOCITY_DAYS,
      rows,
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
