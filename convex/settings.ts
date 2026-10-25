import { v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import { currentStaff, getSetting, pathaoBookAt, requirePerm, setSetting } from "./lib"

export const general = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return {
      invoiceStart: (await getSetting<number>(ctx, "invoiceStart")) ?? 20001,
      feeInsideDhaka: (await getSetting<number>(ctx, "feeInsideDhaka")) ?? 90,
      feeOutsideDhaka: (await getSetting<number>(ctx, "feeOutsideDhaka")) ?? 130,
      pathaoAutoBook: (await getSetting<boolean>(ctx, "pathaoAutoBook")) ?? true,
      pathaoBookAt: await pathaoBookAt(ctx),
    }
  },
})

export const saveGeneral = mutation({
  args: {
    invoiceStart: v.number(), feeInsideDhaka: v.number(), feeOutsideDhaka: v.number(), pathaoAutoBook: v.boolean(),
    pathaoBookAt: v.optional(v.union(v.literal("in_transit"), v.literal("ready_to_ship"), v.literal("manual"))),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const used = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "invoice")).unique()
    if (!used) await setSetting(ctx, "invoiceStart", Math.max(1, Math.floor(a.invoiceStart)))
    await setSetting(ctx, "feeInsideDhaka", a.feeInsideDhaka)
    await setSetting(ctx, "feeOutsideDhaka", a.feeOutsideDhaka)
    if (a.pathaoBookAt) {
      await setSetting(ctx, "pathaoBookAt", a.pathaoBookAt)
      await setSetting(ctx, "pathaoAutoBook", a.pathaoBookAt !== "manual")
    } else await setSetting(ctx, "pathaoAutoBook", a.pathaoAutoBook)
  },
})

export const integrations = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const creds = await getSetting<any>(ctx, "pathao")
    const secret = await getSetting<string>(ctx, "shopifySecret")
    const invoiceUsed = !!(await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "invoice")).unique())
    return {
      webhookUrl: `${process.env.CONVEX_SITE_URL}/shopify/orders`,
      shopifyConnected: !!secret || !!(await getSetting<string>(ctx, "shopifyUrlKey")),
      shopifyLinked: !!(await getSetting<string>(ctx, "shopifyUrlKey")),
      shopifyLast: (await getSetting<any>(ctx, "shopifyLast")) ?? null,
      pathao: creds
        ? { env: creds.env, username: creds.username, clientIdHint: `${String(creds.clientId).slice(0, 4)}••••` }
        : null,
      invoiceUsed,
    }
  },
})

export const savePathao = mutation({
  args: {
    env: v.union(v.literal("sandbox"), v.literal("production")),
    clientId: v.string(),
    clientSecret: v.string(),
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    const old = await getSetting<any>(ctx, "pathao")
    // Blank secret/password fields keep the saved values.
    await setSetting(ctx, "pathao", {
      env: a.env,
      clientId: a.clientId.trim() || old?.clientId,
      clientSecret: a.clientSecret.trim() || old?.clientSecret,
      username: a.username.trim(),
      password: a.password || old?.password,
    })
    await setSetting(ctx, "pathaoToken", null)
  },
})

async function makeShopifyLink(ctx: any) {
  let key = await getSetting<string>(ctx, "shopifyUrlKey")
  if (!key) {
    const arr = new Uint32Array(32)
    crypto.getRandomValues(arr)
    key = Array.from(arr, (n) => "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36]).join("")
    await setSetting(ctx, "shopifyUrlKey", key)
  }
  return `${process.env.CONVEX_SITE_URL}/shopify/orders?key=${key}`
}

/** Internal: create (once) the private webhook link used for API-created Shopify webhooks. */
export const ensureShopifyLink = internalMutation({
  args: {},
  handler: async (ctx) => makeShopifyLink(ctx),
})

/** Admin: get the private Shopify webhook link (creates it once). */
export const shopifyLink = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "settings.manage")
    return await makeShopifyLink(ctx)
  },
})

/** Internal: connect Pathao's public sandbox account for testing. */
export const setPathaoInternal = internalMutation({
  args: { env: v.union(v.literal("sandbox"), v.literal("production")), clientId: v.string(), clientSecret: v.string(), username: v.string(), password: v.string() },
  handler: async (ctx, a) => {
    await setSetting(ctx, "pathao", a)
    await setSetting(ctx, "pathaoToken", null)
  },
})

export const saveShopifySecret = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    await requirePerm(ctx, "settings.manage")
    await setSetting(ctx, "shopifySecret", secret.trim() || null)
  },
})
