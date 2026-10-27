// Stock in → Shopify. When goods are received in Ops (purchase receive or Stock in), the same good pairs
// are added to "available" at the matching Shopify location. Only additions from receipts are sent;
// Shopify already takes stock off by itself when an order is placed on the website.
// Uses a Dev Dashboard app (client credentials grant): client ID + secret → 24h token, cached.
import { v, ConvexError } from "convex/values"
// plain builders on purpose: functions.ts imports markDirty from here (no circular import), and nothing here writes orders/stock
import { internalAction, internalQuery, query, action, internalMutation, mutation } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { currentStaff, getSetting, requirePerm, setSetting } from "./lib"

const API = "2026-04"
type Conf = { shop: string; clientId: string; on: boolean }

// ---------- settings ----------
export const status = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const conf = (await getSetting<Conf>(ctx, "shopifyApi")) ?? { shop: "", clientId: "", on: false }
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.active)
    return {
      shop: conf.shop, clientId: conf.clientId, on: !!conf.on,
      hasSecret: !!(await getSetting<string>(ctx, "shopifyApiSecret")),
      lastError: (await getSetting<any>(ctx, "shopifyApiError")) ?? null,
      last: (await getSetting<{ at: number; count: number }>(ctx, "shopifyStockLast")) ?? null,
      warehouses: locs.map((l) => ({ _id: l._id, name: l.name, exchange: !!l.noCourier, shopifyLocationId: l.shopifyLocationId ?? "" })),
    }
  },
})

export const save = mutation({
  args: { shop: v.string(), clientId: v.string(), secret: v.optional(v.string()), on: v.boolean(), map: v.array(v.object({ id: v.id("locations"), shopifyLocationId: v.string() })) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const shop = a.shop.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    if (a.on && (!shop || !a.clientId.trim())) throw new ConvexError("Enter the shop domain and client ID first")
    const before = await getSetting<Conf>(ctx, "shopifyApi")
    await setSetting(ctx, "shopifyApi", { shop, clientId: a.clientId.trim(), on: a.on })
    if (a.on && !before?.on) {
      // Switching on: update the website right away for everything received in the last 14 days
      // (other products update the next time their stock changes in Ops — no big one-shot change).
      const since = Date.now() - 14 * 86400000
      const ids = new Set<string>()
      for (const r of await ctx.db.query("receipts").withIndex("by_at", (q) => q.gte("at", since)).collect()) for (const i of r.items) ids.add(i.variantId)
      for (const id of ids) {
        if (!(await ctx.db.query("shopifyDirty").withIndex("by_variant", (q) => q.eq("variantId", id as Id<"variants">)).first()))
          await ctx.db.insert("shopifyDirty", { variantId: id as Id<"variants">, at: Date.now() })
      }
      if (ids.size) await ctx.scheduler.runAfter(3000, internal.shopifyStock.flush, {})
    }
    if (a.secret?.trim()) { await setSetting(ctx, "shopifyApiSecret", a.secret.trim()); await setSetting(ctx, "shopifyApiToken", null) }
    for (const m of a.map) await ctx.db.patch(m.id, { shopifyLocationId: m.shopifyLocationId || undefined })
  },
})

// ---------- token + GraphQL ----------
export const creds = internalQuery({
  args: {},
  handler: async (ctx) => ({
    conf: (await getSetting<Conf>(ctx, "shopifyApi")) ?? null,
    secret: (await getSetting<string>(ctx, "shopifyApiSecret")) ?? null,
    token: (await getSetting<{ token: string; exp: number }>(ctx, "shopifyApiToken")) ?? null,
  }),
})
export const putToken = internalMutation({
  args: { token: v.optional(v.any()), error: v.optional(v.any()) },
  handler: async (ctx, { token, error }) => {
    if (token !== undefined) await setSetting(ctx, "shopifyApiToken", token)
    if (error !== undefined) await setSetting(ctx, "shopifyApiError", error)
  },
})

async function gql(ctx: any, query: string, variables: any = {}) {
  const c = await ctx.runQuery(internal.shopifyStock.creds, {})
  if (!c.conf?.shop || !c.conf.clientId || !c.secret) throw new Error("Shopify stock sync is not set up (Settings → Shopify)")
  let token = c.token && c.token.exp > Date.now() + 60_000 ? c.token.token : null
  if (!token) {
    // a pasted Admin API token (shpat_…) also works
    if (c.secret.startsWith("shpat_")) token = c.secret
    else {
      const r = await fetch(`https://${c.conf.shop}/admin/oauth/access_token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.conf.clientId, client_secret: c.secret }),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok || !j.access_token) throw new Error(`Shopify login failed (${r.status}): ${j.error_description ?? j.error ?? "check client ID / secret and that the app is installed"}`)
      token = j.access_token as string
      await ctx.runMutation(internal.shopifyStock.putToken, { token: { token, exp: Date.now() + (Number(j.expires_in) || 86399) * 1000 } })
    }
  }
  const r = await fetch(`https://${c.conf.shop}/admin/api/${API}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token! },
    body: JSON.stringify({ query, variables }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (r.status === 401) await ctx.runMutation(internal.shopifyStock.putToken, { token: null })
  if (!r.ok || j.errors) throw new Error(`Shopify API ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`)
  return j.data
}

/** Settings button: check the connection and list Shopify locations to link warehouses. */
export const test = action({
  args: {},
  handler: async (ctx): Promise<{ shop: string; locations: { id: string; name: string }[] }> => {
    const me = await ctx.runQuery(internal.shopifyStock.isAdmin, {})
    if (!me) throw new ConvexError("Not allowed")
    try {
      const d = await gql(ctx, `{ shop { name } locations(first: 50) { nodes { id name isActive } } }`)
      await ctx.runMutation(internal.shopifyStock.putToken, { error: null })
      return { shop: d.shop.name, locations: d.locations.nodes.filter((l: any) => l.isActive).map((l: any) => ({ id: l.id, name: l.name })) }
    } catch (e: any) {
      throw new ConvexError(String(e?.message ?? e))
    }
  },
})
export const isAdmin = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    return !!s && (s.perms.includes("*") || s.perms.includes("settings.manage"))
  },
})

// ---------- live stock mirror ----------
// Shopify "available" for each SKU = sellable stock in Ops for the warehouses linked to that Shopify location:
//   Ops available − pairs in Pending / On Hold orders (Shopify already took those off when the order was placed).
// Any change to stock or to a pending order marks the product "dirty"; a flush a few seconds later sets the
// exact number in Shopify. Setting the number (not adding) means it can never drift or double count.

const HELD = ["pending", "on_hold"]

/** Called by triggers (stock rows + orders). Cheap: one read of the switch, one small insert. */
export async function markDirty(ctx: any, variantIds: (Id<"variants"> | undefined)[]) {
  const ids = [...new Set(variantIds.filter(Boolean) as Id<"variants">[])]
  if (!ids.length) return
  const conf = await getSetting<Conf>(ctx, "shopifyApi")
  if (!conf?.on) return
  const wasEmpty = !(await ctx.innerDb.query("shopifyDirty").first())
  for (const id of ids) {
    if (!(await ctx.innerDb.query("shopifyDirty").withIndex("by_variant", (q: any) => q.eq("variantId", id)).first()))
      await ctx.innerDb.insert("shopifyDirty", { variantId: id, at: Date.now() })
  }
  if (wasEmpty) await ctx.scheduler.runAfter(5000, internal.shopifyStock.flush, {})
}

export const claimDirty = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("shopifyDirty").take(150)
    for (const r of rows) await ctx.db.delete(r._id)
    return { ids: rows.map((r) => r.variantId), more: rows.length === 150 }
  },
})

/** What each variant should show in Shopify, per Shopify location. */
export const targets = internalQuery({
  args: { variantIds: v.optional(v.array(v.id("variants"))) },
  handler: async (ctx, { variantIds }) => {
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.shopifyLocationId)
    const shopLocOf = new Map(locs.map((l) => [l._id as string, l.shopifyLocationId!]))
    const held = new Map<string, number>() // variantId|shopLoc -> pairs in pending/on hold orders
    for (const st of HELD) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", st as any)).collect()) {
        if (o.deletedAt) continue
        const sl = shopLocOf.get(o.locationId)
        if (!sl) continue
        for (const i of o.items) if (i.variantId) held.set(`${i.variantId}|${sl}`, (held.get(`${i.variantId}|${sl}`) ?? 0) + i.qty)
      }
    }
    const variants = variantIds
      ? (await Promise.all(variantIds.map((id) => ctx.db.get(id)))).filter(Boolean) as any[]
      : await ctx.db.query("variants").collect()
    const out: { variantId: string; sku: string; itemId?: string; shopLoc: string; qty: number }[] = []
    for (const vr of variants) {
      const sums = new Map<string, number>()
      for (const sl of new Set(shopLocOf.values())) sums.set(sl, 0)
      for (const r of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", vr._id)).collect()) {
        const sl = shopLocOf.get(r.locationId)
        if (sl) sums.set(sl, (sums.get(sl) ?? 0) + r.available)
      }
      for (const [sl, n] of sums) out.push({ variantId: vr._id, sku: vr.sku, itemId: vr.shopifyItemId, shopLoc: sl, qty: Math.max(0, n - (held.get(`${vr._id}|${sl}`) ?? 0)) })
    }
    return out
  },
})

export const saveItemIds = internalMutation({
  args: { list: v.array(v.object({ id: v.id("variants"), itemId: v.string() })) },
  handler: async (ctx, { list }) => { for (const x of list) await ctx.db.patch(x.id, { shopifyItemId: x.itemId }) },
})

async function itemIds(ctx: any, rows: { variantId: string; sku: string; itemId?: string }[]) {
  const need = [...new Set(rows.filter((r) => !r.itemId).map((r) => r.sku))]
  const found = new Map<string, string>()
  for (let k = 0; k < need.length; k += 40) {
    const part = need.slice(k, k + 40)
    const res = await gql(ctx, `query($q: String!) { productVariants(first: 250, query: $q) { nodes { sku inventoryItem { id } } } }`, { q: part.map((s) => `sku:"${s.replace(/"/g, "")}"`).join(" OR ") })
    for (const n of res.productVariants.nodes) if (n.sku && part.includes(n.sku)) found.set(n.sku, n.inventoryItem.id)
  }
  const save: { id: any; itemId: string }[] = []
  for (const r of rows) if (!r.itemId && found.has(r.sku)) { r.itemId = found.get(r.sku); save.push({ id: r.variantId, itemId: r.itemId! }) }
  if (save.length) await ctx.runMutation(internal.shopifyStock.saveItemIds, { list: [...new Map(save.map((x) => [x.id, x])).values()] })
}

async function setQuantities(ctx: any, rows: { itemId?: string; shopLoc: string; qty: number }[], reason = "correction") {
  const ok = rows.filter((r) => r.itemId)
  for (let k = 0; k < ok.length; k += 200) {
    const part = ok.slice(k, k + 200)
    const res = await gql(ctx, `mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") { userErrors { field message } }
      }`, { input: { name: "available", reason, referenceDocumentUri: "bbops://stock-sync", quantities: part.map((r) => ({ inventoryItemId: r.itemId, locationId: r.shopLoc, quantity: r.qty, changeFromQuantity: null })) } })
    const errs = res.inventorySetQuantities.userErrors
    if (errs?.length) throw new Error(errs.map((e: any) => e.message).join("; ").slice(0, 300))
  }
  return ok.length
}

export const flush = internalAction({
  args: {},
  handler: async (ctx) => {
    const { ids, more } = await ctx.runMutation(internal.shopifyStock.claimDirty, {})
    if (ids.length) {
      try {
        const rows = await ctx.runQuery(internal.shopifyStock.targets, { variantIds: ids })
        await itemIds(ctx, rows)
        await setQuantities(ctx, rows)
        await ctx.runMutation(internal.shopifyStock.putToken, { error: null })
        await ctx.runMutation(internal.shopifyStock.putLast, { at: Date.now(), count: rows.length })
      } catch (e: any) {
        await ctx.runMutation(internal.shopifyStock.putToken, { error: `${new Date().toISOString()} ${String(e?.message ?? e)}`.slice(0, 400) })
        await ctx.runMutation(internal.shopifyStock.requeue, { ids }) // try again shortly
        await ctx.scheduler.runAfter(60_000, internal.shopifyStock.flush, {})
        return
      }
    }
    if (more) await ctx.scheduler.runAfter(1000, internal.shopifyStock.flush, {})
  },
})
export const requeue = internalMutation({
  args: { ids: v.array(v.id("variants")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) if (!(await ctx.db.query("shopifyDirty").withIndex("by_variant", (q) => q.eq("variantId", id)).first())) await ctx.db.insert("shopifyDirty", { variantId: id, at: Date.now() })
  },
})
export const putLast = internalMutation({
  args: { at: v.number(), count: v.number() },
  handler: async (ctx, a) => { await setSetting(ctx, "shopifyStockLast", a) },
})

/** Preview before switching on: what would change on the website. Changes nothing. */
export const preview = action({
  args: {},
  handler: async (ctx): Promise<{ total: number; same: number; notInShopify: number; changes: { sku: string; shopify: number; ops: number }[] }> => {
    if (!(await ctx.runQuery(internal.shopifyStock.isAdmin, {}))) throw new ConvexError("Not allowed")
    try {
      const rows = await ctx.runQuery(internal.shopifyStock.targets, {})
      const want = new Map<string, number>(rows.map((r: { sku: string; shopLoc: string; qty: number }) => [`${r.sku}|${r.shopLoc}`, r.qty] as [string, number]))
      const have = new Map<string, number>()
      let after: string | null = null
      for (let page = 0; page < 60; page++) {
        const d: any = await gql(ctx, `query($after: String) { productVariants(first: 200, after: $after) { pageInfo { hasNextPage endCursor } nodes { sku inventoryItem { inventoryLevels(first: 5) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } } }`, { after })
        for (const n of d.productVariants.nodes) {
          if (!n.sku) continue
          for (const l of n.inventoryItem.inventoryLevels.nodes) have.set(`${n.sku}|${l.location.id}`, l.quantities[0]?.quantity ?? 0)
        }
        if (!d.productVariants.pageInfo.hasNextPage) break
        after = d.productVariants.pageInfo.endCursor
      }
      const changes: { sku: string; shopify: number; ops: number }[] = []
      let same = 0, notIn = 0
      for (const [k, q] of want) {
        if (!have.has(k)) { notIn++; continue }
        const h = have.get(k)!
        if (h === q) same++
        else changes.push({ sku: k.split("|")[0], shopify: h, ops: q })
      }
      return { total: want.size, same, notInShopify: notIn, changes: changes.sort((a, b) => Math.abs(b.ops - b.shopify) - Math.abs(a.ops - a.shopify)) }
    } catch (e: any) { throw new ConvexError(String(e?.message ?? e)) }
  },
})

/** Push every product now (used once when switching on, or to repair). */
export const pushAll = action({
  args: {},
  handler: async (ctx): Promise<{ pushed: number; missing: number }> => {
    if (!(await ctx.runQuery(internal.shopifyStock.isAdmin, {}))) throw new ConvexError("Not allowed")
    try {
      const rows = await ctx.runQuery(internal.shopifyStock.targets, {})
      await itemIds(ctx, rows)
      const n = await setQuantities(ctx, rows)
      await ctx.runMutation(internal.shopifyStock.putLast, { at: Date.now(), count: n })
      return { pushed: n, missing: rows.length - n }
    } catch (e: any) { throw new ConvexError(String(e?.message ?? e)) }
  },
})
