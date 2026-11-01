import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"

/**
 * A SKU renamed in the Products page used to only ever change Ops' own record — nothing pushed the rename to
 * Shopify, so the website kept showing the old SKU forever. saveProduct now schedules a push for any variant
 * that already has a cached shopifyItemId (i.e. is already linked to Shopify) whenever its SKU actually changes.
 */

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  expect(await as.mutation(api.team.claim, { name: "Emon" })).toBe("ok")
  const { productId, variantId } = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { key: "shopifyApi", value: { shop: "x.myshopify.com", clientId: "c", on: true } })
    await ctx.db.insert("settings", { key: "shopifyApiSecret", value: "shpat_test" })
    const productId = await ctx.db.insert("products", { name: "Test product", active: true, createdAt: 1 })
    const variantId = await ctx.db.insert("variants", {
      productId, sku: "BB-OLD-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true,
      shopifyItemId: "gid://shopify/InventoryItem/999",
    })
    return { productId, variantId }
  })
  return { t, as, productId, variantId }
}

function stubShopify() {
  const calls: { q: string; v: any }[] = []
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body)
    calls.push({ q: query, v: variables })
    let data: any = {}
    if (query.includes("inventoryItemUpdate")) data = { inventoryItemUpdate: { userErrors: [] } }
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  return calls
}

describe("renaming a SKU in Ops pushes the rename to Shopify", () => {
  it("pushes the new SKU onto the already-linked Shopify inventory item", async () => {
    vi.useFakeTimers()
    const calls = stubShopify()
    const { t, as, productId, variantId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      id: productId, name: "Test product", active: true,
      variants: [{ id: variantId, sku: "BB-NEW-41", title: "41", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true }],
    })
    vi.advanceTimersByTime(10)
    await t.finishInProgressScheduledFunctions()
    const call = calls.find((c) => c.q.includes("inventoryItemUpdate"))
    expect(call?.v).toEqual({ id: "gid://shopify/InventoryItem/999", input: { sku: "BB-NEW-41" } })
    const vr = await t.run((ctx) => ctx.db.get(variantId))
    expect(vr!.sku).toBe("BB-NEW-41") // Ops' own record still updates as before
    vi.useRealTimers()
  })

  it("does nothing when the SKU didn't actually change", async () => {
    vi.useFakeTimers()
    const calls = stubShopify()
    const { t, as, productId, variantId } = await setup()
    await as.mutation(api.catalog.saveProduct, {
      id: productId, name: "Test product", active: true,
      variants: [{ id: variantId, sku: "BB-OLD-41", title: "41 wide", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true }],
    })
    vi.advanceTimersByTime(10)
    await t.finishInProgressScheduledFunctions()
    expect(calls.some((c) => c.q.includes("inventoryItemUpdate"))).toBe(false)
    vi.useRealTimers()
  })

  it("does nothing for a variant never linked to Shopify (no shopifyItemId yet)", async () => {
    vi.useFakeTimers()
    const calls = stubShopify()
    const { t, as, productId } = await setup()
    const variantId = await t.run((ctx) => ctx.db.insert("variants", {
      productId, sku: "BB-UNLINKED-41", title: "41b", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true,
    }))
    await as.mutation(api.catalog.saveProduct, {
      id: productId, name: "Test product", active: true,
      variants: [
        { id: variantId, sku: "BB-RENAMED-41", title: "41b", weightKg: 0.4, price: 1500, purchasePrice: 700, active: true },
      ],
    })
    vi.advanceTimersByTime(10)
    await t.finishInProgressScheduledFunctions()
    expect(calls.some((c) => c.q.includes("inventoryItemUpdate"))).toBe(false)
    vi.useRealTimers()
  })
})
