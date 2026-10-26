// Automatic collections (Shopify "smart collections"): a collection with rules fills itself with every website
// product that matches, every time the website is built. Pure functions, shared by the catalog feed and the
// Website → Collections editor preview, so both always agree.

export type RuleField = "tag" | "type" | "vendor" | "title" | "price" | "compareAt" | "stock"
export type RuleOp = "is" | "is_not" | "contains" | "not_contains" | "lt" | "gt" | "eq"
export type Condition = { field: RuleField; op: RuleOp; values: string[]; all?: boolean } // all: every value must match (Shopify matchType ALL)
export type Rules = { match: "all" | "any"; conditions: Condition[] }
export type SortKey = "manual" | "best" | "newest" | "oldest" | "price-asc" | "price-desc" | "title-asc" | "title-desc"

export const FIELD_LABEL: Record<RuleField, string> = {
  tag: "Product tag", type: "Product type", vendor: "Brand", title: "Product title", price: "Price", compareAt: "Compare-at price", stock: "Stock",
}
export const OPS_FOR: Record<RuleField, RuleOp[]> = {
  tag: ["is", "is_not"], type: ["is", "is_not"], vendor: ["is", "is_not"], title: ["contains", "not_contains", "is"],
  price: ["lt", "gt", "eq"], compareAt: ["lt", "gt", "eq"], stock: ["gt"],
}
export const OP_LABEL: Record<RuleOp, string> = {
  is: "is", is_not: "is not", contains: "contains", not_contains: "does not contain", lt: "is less than", gt: "is greater than", eq: "is equal to",
}

/** What a rule needs to know about a product. */
export type RuleProduct = { tags: string[]; type: string; vendor: string; title: string; prices: number[]; compareAts: number[]; inStock: boolean }

const low = (s: string) => s.trim().toLowerCase()

function test(p: RuleProduct, c: Condition): boolean {
  const vals = (c.values ?? []).map(String).filter((x) => x.trim() !== "")
  if (c.field === "stock") return p.inStock
  if (!vals.length) return true
  const num = Number(vals[0])
  switch (c.field) {
    case "tag": {
      const tags = p.tags.map(low)
      if (c.op === "is_not") return !vals.some((v) => tags.includes(low(v)))
      return c.all ? vals.every((v) => tags.includes(low(v))) : vals.some((v) => tags.includes(low(v)))
    }
    case "type": case "vendor": {
      const own = low(c.field === "type" ? p.type : p.vendor)
      const hit = vals.some((v) => low(v) === own)
      return c.op === "is_not" ? !hit : hit
    }
    case "title": {
      const t = low(p.title)
      if (c.op === "is") return vals.some((v) => low(v) === t)
      const hit = vals.some((v) => t.includes(low(v)))
      return c.op === "not_contains" ? !hit : hit
    }
    case "price": case "compareAt": {
      const list = c.field === "price" ? p.prices : p.compareAts
      if (!list.length || !Number.isFinite(num)) return false
      return list.some((x) => (c.op === "lt" ? x < num : c.op === "gt" ? x > num : x === num))
    }
  }
  return false
}

export function matchesRules(p: RuleProduct, rules: Rules | null | undefined): boolean {
  const conds = (rules?.conditions ?? []).filter((c) => c && c.field)
  if (!conds.length) return false
  return rules!.match === "any" ? conds.some((c) => test(p, c)) : conds.every((c) => test(p, c))
}

export const isAutomatic = (rules: Rules | null | undefined) => !!rules && (rules.conditions ?? []).some((c) => c && c.field)

/** Turn a Shopify collection ruleSet (from the export) into our rules; null when it has none or uses something we can't do. */
export function fromShopifyRuleSet(ruleSet: any): Rules | null {
  const sources: any[] = Array.isArray(ruleSet) ? ruleSet : ruleSet ? [ruleSet] : []
  const src = sources.find((s) => Array.isArray(s?.conditions) && s.conditions.length)
  if (!src) return null
  const conditions: Condition[] = []
  for (const q of src.conditions) {
    const t = String(q?.__typename ?? "")
    const values: string[] = Array.isArray(q?.values) ? q.values.map(String) : q?.value?.amount != null ? [String(Number(q.value.amount))] : q?.value != null ? [String(q.value)] : []
    const rel = String(q?.relation ?? "")
    const all = String(q?.matchType ?? "ANY").toUpperCase() === "ALL"
    if (/ProductTag$/.test(t)) conditions.push({ field: "tag", op: rel === "NOT_TAGGED_WITH" ? "is_not" : "is", values, all })
    else if (/ProductType$/.test(t)) conditions.push({ field: "type", op: rel === "NOT_EQUALS" ? "is_not" : "is", values, all })
    else if (/ProductVendor$/.test(t)) conditions.push({ field: "vendor", op: rel === "NOT_EQUALS" ? "is_not" : "is", values, all })
    else if (/ProductTitle$/.test(t)) conditions.push({ field: "title", op: rel === "NOT_CONTAINS" ? "not_contains" : rel === "EQUALS" ? "is" : "contains", values, all })
    else if (/VariantPrice$/.test(t)) conditions.push({ field: "price", op: rel === "LESS_THAN" ? "lt" : rel === "GREATER_THAN" ? "gt" : "eq", values })
    else if (/VariantCompareAtPrice$/.test(t)) conditions.push({ field: "compareAt", op: rel === "LESS_THAN" ? "lt" : rel === "GREATER_THAN" ? "gt" : "eq", values })
    else if (/VariantInventory$/.test(t)) conditions.push({ field: "stock", op: "gt", values: ["0"] })
    else return null // unknown rule: keep the collection's fixed list rather than guess
  }
  return { match: String(src.matchType ?? "ALL").toUpperCase() === "ANY" ? "any" : "all", conditions }
}

export function fromShopifySort(s: unknown): SortKey {
  switch (String(s ?? "").toUpperCase()) {
    case "BEST_SELLING": return "best"
    case "CREATED_DESC": return "newest"
    case "CREATED": return "oldest"
    case "PRICE_ASC": return "price-asc"
    case "PRICE_DESC": return "price-desc"
    case "ALPHA_ASC": return "title-asc"
    case "ALPHA_DESC": return "title-desc"
    default: return "manual"
  }
}

type CatProduct = { handle: string; title: string; vendor?: string; type?: string; tags?: string[]; createdAt?: string; publishedAt?: string; variants: { price: number; compareAt: number | null; available: boolean }[]; sold?: number }
type CatCollection = { handle: string; productHandles: string[]; rules?: Rules | null; sort?: SortKey | null }

export const toRuleProduct = (p: CatProduct): RuleProduct => ({
  tags: (p.tags ?? []).map(String), type: p.type ?? "", vendor: p.vendor ?? "", title: p.title,
  prices: p.variants.map((v) => v.price), compareAts: p.variants.map((v) => v.compareAt ?? 0).filter((x) => x > 0),
  inStock: p.variants.some((v) => v.available),
})

/** Fill automatic collections and apply each collection's sort order. Mutates and returns `collections`. */
export function finishCollections<C extends CatCollection>(products: CatProduct[], collections: C[]): C[] {
  const byHandle = new Map(products.map((p) => [p.handle, p]))
  const minPrice = (p: CatProduct) => Math.min(...p.variants.map((v) => v.price), Infinity)
  const created = (p: CatProduct) => Date.parse(p.publishedAt || p.createdAt || "") || 0
  for (const c of collections) {
    let list = c.productHandles.filter((h) => byHandle.has(h))
    if (isAutomatic(c.rules)) {
      const hits = new Set(products.filter((p) => matchesRules(toRuleProduct(p), c.rules)).map((p) => p.handle))
      const kept = list.filter((h) => hits.has(h))
      // products newly matching go first (newest first), like a new product appearing at the top on Shopify
      const added = [...hits].filter((h) => !kept.includes(h)).sort((a, b) => created(byHandle.get(b)!) - created(byHandle.get(a)!))
      list = [...added, ...kept]
    }
    const by: Partial<Record<SortKey, (a: CatProduct, b: CatProduct) => number>> = {
      best: (a, b) => (b.sold ?? 0) - (a.sold ?? 0),
      newest: (a, b) => created(b) - created(a),
      oldest: (a, b) => created(a) - created(b),
      "price-asc": (a, b) => minPrice(a) - minPrice(b),
      "price-desc": (a, b) => minPrice(b) - minPrice(a),
      "title-asc": (a, b) => a.title.localeCompare(b.title),
      "title-desc": (a, b) => b.title.localeCompare(a.title),
    }
    const cmp = c.sort ? by[c.sort] : undefined
    if (cmp) {
      const idx = new Map(list.map((h, i) => [h, i]))
      list = [...list].sort((a, b) => cmp(byHandle.get(a)!, byHandle.get(b)!) || idx.get(a)! - idx.get(b)!)
    }
    c.productHandles = list
  }
  return collections
}

// ---------------- plain-English summaries (Shopify's "Product tag is equal to X") ----------------
const SUMMARY_OP: Record<RuleOp, string> = {
  is: "is equal to", is_not: "is not equal to", contains: "contains", not_contains: "does not contain", lt: "is less than", gt: "is greater than", eq: "is equal to",
}

/** One condition in words, e.g. "Product tag is equal to bb-men". */
export function describeCondition(c: Condition): string {
  if (c.field === "stock") return "Inventory stock is greater than 0"
  const vals = (c.values ?? []).map((x) => String(x).trim()).filter(Boolean)
  const money = c.field === "price" || c.field === "compareAt"
  const shown = vals.map((x) => (money && Number.isFinite(Number(x)) ? `৳${Number(x).toLocaleString("en-US")}` : x))
  const joiner = c.all ? " and " : " or "
  return `${FIELD_LABEL[c.field] ?? c.field} ${SUMMARY_OP[c.op] ?? c.op} ${shown.length ? shown.join(joiner) : "(empty)"}`
}

/** Every condition in words; empty for a manual collection. */
export function describeRules(rules: Rules | null | undefined): string[] {
  if (!isAutomatic(rules)) return []
  return rules!.conditions.filter((c) => c && c.field).map(describeCondition)
}
