export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let q = false
  const s = text.replace(/^﻿/, "")
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ",") { row.push(cell); cell = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++
      row.push(cell); rows.push(row); row = []; cell = ""
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim()))
}

export type ImportRow = {
  product: string
  category?: string
  imageUrl?: string
  sku: string
  title: string
  weightKg: number
  price: number
  purchasePrice: number
  stock?: number
}

/** Accepts our template or a Shopify "Export products" CSV. */
export function mapProductCsv(text: string): { rows: ImportRow[]; format: "shopify" | "template" | "unknown" } {
  const grid = parseCsv(text)
  if (grid.length < 2) return { rows: [], format: "unknown" }
  const head = grid[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => head.indexOf(name)
  const n = (x?: string) => Number(String(x ?? "").replace(/[^\d.]/g, "")) || 0

  if (col("handle") >= 0 && col("variant sku") >= 0) {
    const titles = new Map<string, { title: string; type?: string; image?: string }>()
    const out: ImportRow[] = []
    for (const r of grid.slice(1)) {
      const handle = r[col("handle")]
      const t = r[col("title")]
      if (t) titles.set(handle, { title: t, type: r[col("type")] || r[col("product category")] || undefined, image: r[col("image src")] || undefined })
      const base = titles.get(handle)
      const sku = r[col("variant sku")]
      if (!sku || !base) continue
      const opts = ["option1 value", "option2 value", "option3 value"].map((k) => r[col(k)]).filter((x) => x && x !== "Default Title")
      const inv = col("variant inventory qty") >= 0 ? n(r[col("variant inventory qty")]) : undefined
      out.push({
        product: base.title,
        category: base.type,
        imageUrl: r[col("variant image")] || base.image,
        sku,
        title: opts.join(" / ") || "Default",
        weightKg: n(r[col("variant grams")]) / 1000,
        price: n(r[col("variant price")]),
        purchasePrice: col("cost per item") >= 0 ? n(r[col("cost per item")]) : 0,
        stock: inv,
      })
    }
    return { rows: out, format: "shopify" }
  }

  if (col("sku") >= 0 && col("product") >= 0) {
    return {
      format: "template",
      rows: grid.slice(1).map((r) => ({
        product: r[col("product")]?.trim() ?? "",
        category: r[col("category")] || undefined,
        imageUrl: r[col("image_url")] || undefined,
        sku: r[col("sku")]?.trim() ?? "",
        title: r[col("variant")]?.trim() || "Default",
        weightKg: n(r[col("weight_kg")]),
        price: n(r[col("price")]),
        purchasePrice: n(r[col("purchase_price")]),
        stock: col("stock") >= 0 ? n(r[col("stock")]) : undefined,
      })),
    }
  }
  return { rows: [], format: "unknown" }
}

export const TEMPLATE_CSV =
  "product,category,sku,variant,price,purchase_price,weight_kg,stock,image_url\n" +
  "BlackBole Harbor Shore Sandal - Black,Sandals,BB-SH-HSS-BLACK-41,41,1480,520,0.4,10,\n" +
  "BlackBole Harbor Shore Sandal - Black,Sandals,BB-SH-HSS-BLACK-42,42,1480,520,0.4,12,\n"
