// Stock in → Shopify. When goods are received in Ops (purchase receive or Stock in), the same good pairs
// are added to "available" at the matching Shopify location. Only additions from receipts are sent;
// Shopify already takes stock off by itself when an order is placed on the website.
// Uses a Dev Dashboard app (client credentials grant): client ID + secret → 24h token, cached.
import { v, ConvexError } from "convex/values"
import { internalAction, internalQuery, query, action } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
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
    await setSetting(ctx, "shopifyApi", { shop, clientId: a.clientId.trim(), on: a.on })
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
  args: { token: v.any(), error: v.optional(v.any()) },
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

// ---------- push a receipt ----------
export const receiptData = internalQuery({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id)
    if (!r) return null
    const loc = await ctx.db.get(r.locationId)
    const conf = await getSetting<Conf>(ctx, "shopifyApi")
    return { r, shopifyLocationId: loc?.shopifyLocationId ?? null, locName: loc?.name ?? "", on: !!conf?.on }
  },
})
export const markReceipt = internalMutation({
  args: { id: v.id("receipts"), sync: v.any() },
  handler: async (ctx, { id, sync }) => { await ctx.db.patch(id, { shopifySync: sync }) },
})

export const pushReceipt = internalAction({
  args: { id: v.id("receipts"), force: v.optional(v.boolean()) },
  handler: async (ctx, { id, force }) => {
    const d = await ctx.runQuery(internal.shopifyStock.receiptData, { id })
    if (!d) return
    if (d.r.shopifySync?.status === "done") return // never add twice
    if (!d.on && !force) return
    if (!d.shopifyLocationId) {
      await ctx.runMutation(internal.shopifyStock.markReceipt, { id, sync: { status: "skipped", at: Date.now(), error: `${d.locName} is not linked to a Shopify location` } })
      return
    }
    const qty = new Map<string, number>()
    for (const i of d.r.items) if (i.qty > 0) qty.set(i.sku, (qty.get(i.sku) ?? 0) + i.qty)
    if (!qty.size) return
    try {
      const skus = [...qty.keys()]
      const found = new Map<string, string>()
      for (let k = 0; k < skus.length; k += 25) {
        const part = skus.slice(k, k + 25)
        const q = part.map((s) => `sku:"${s.replace(/"/g, "")}"`).join(" OR ")
        const res = await gql(ctx, `query($q: String!) { productVariants(first: 100, query: $q) { nodes { sku inventoryItem { id tracked } } } }`, { q })
        for (const n of res.productVariants.nodes) if (n.sku && part.includes(n.sku)) found.set(n.sku, n.inventoryItem.id)
      }
      const missing = skus.filter((s) => !found.has(s))
      const changes = skus.filter((s) => found.has(s)).map((s) => ({ inventoryItemId: found.get(s), locationId: d.shopifyLocationId, delta: qty.get(s), changeFromQuantity: null }))
      if (changes.length) {
        const res = await gql(ctx, `mutation($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) @idempotent(key: "${`bbops-grn-${id}`}") { userErrors { field message } }
          }`, { input: { name: "available", reason: "received", referenceDocumentUri: `bbops://receipt/GRN-${d.r.code}`, changes } })
        const errs = res.inventoryAdjustQuantities.userErrors
        if (errs?.length) throw new Error(errs.map((e: any) => e.message).join("; "))
      }
      await ctx.runMutation(internal.shopifyStock.markReceipt, {
        id, sync: { status: "done", at: Date.now(), pushed: changes.reduce((t, c) => t + (c.delta ?? 0), 0), missing: missing.length ? missing : undefined },
      })
    } catch (e: any) {
      await ctx.runMutation(internal.shopifyStock.markReceipt, { id, sync: { status: "failed", at: Date.now(), error: String(e?.message ?? e).slice(0, 400) } })
    }
  },
})

/** Button on a receipt that failed / was skipped: send it again. */
export const retry = mutation({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "inventory.receive")
    const r = await ctx.db.get(id)
    if (!r) throw new ConvexError("Receipt not found")
    if (r.shopifySync?.status === "done") throw new ConvexError("Already added to Shopify")
    await ctx.scheduler.runAfter(0, internal.shopifyStock.pushReceipt, { id, force: true })
  },
})

export async function queueReceipt(ctx: { scheduler: any }, id: Id<"receipts">) {
  await ctx.scheduler.runAfter(0, internal.shopifyStock.pushReceipt, { id })
}
