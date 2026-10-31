// Tells BlackBole Marketing OS the moment a product's price, sizes, cost or stock change, so it never waits for its
// 30-minute sync. Changes are collected for a few seconds (an order touches several sizes at once) and sent as one call,
// signed with the same feed key Marketing OS reads Ops with. Marketing OS then fetches just those products.

import { internalAction, internalMutation, type MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { getSetting, setSetting } from "./lib"

const KEY = "marketing.dirty"
const WAIT_MS = 3000
type Dirty = { ids: string[]; all?: boolean; scheduledAt?: number | null }

/** Marketing OS's address (its Convex HTTP actions). Override with MARKETING_OS_URL. */
export const marketingOsUrl = () => (process.env.MARKETING_OS_URL || "https://perfect-guanaco-78.convex.site").replace(/\/+$/, "")

/** Note that a product changed. Pass a product, a size (variant) or `all` for a bulk change. */
export async function marketingChanged(ctx: MutationCtx, ref: { productId?: Id<"products">; variantId?: Id<"variants">; all?: boolean }) {
  if (!process.env.MARKETING_FEED_KEY) return // Marketing OS isn't linked
  let productId = ref.productId as string | undefined
  if (!productId && ref.variantId) productId = (await ctx.db.get(ref.variantId))?.productId as string | undefined
  if (!productId && !ref.all) return
  const cur = (await getSetting<Dirty>(ctx, KEY)) ?? { ids: [] }
  const ids = productId && !cur.ids.includes(productId) ? [...cur.ids, productId] : cur.ids
  const all = cur.all || !!ref.all
  const due = cur.scheduledAt && Date.now() - cur.scheduledAt < 60_000 // a send is already on its way
  if (due && ids === cur.ids && all === !!cur.all) return
  await setSetting(ctx, KEY, { ids, all, scheduledAt: due ? cur.scheduledAt : Date.now() })
  if (!due) await ctx.scheduler.runAfter(WAIT_MS, internal.marketingPush.send, {})
}

export const take = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cur = (await getSetting<Dirty>(ctx, KEY)) ?? { ids: [] }
    await setSetting(ctx, KEY, { ids: [], all: false, scheduledAt: null })
    const names: string[] = []
    if (!cur.all) for (const id of cur.ids.slice(0, 200)) {
      const p = await ctx.db.get(id as Id<"products">)
      if (p && "name" in p) names.push(p.name)
    }
    return { names, all: !!cur.all || cur.ids.length > 200 }
  },
})

export const send = internalAction({
  args: {},
  handler: async (ctx) => {
    const key = process.env.MARKETING_FEED_KEY
    const { names, all } = await ctx.runMutation(internal.marketingPush.take, {})
    if (!key || (!all && !names.length)) return
    try {
      await fetch(`${marketingOsUrl()}/ops/changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Feed-Key": key },
        body: JSON.stringify({ products: names, all }),
      })
    } catch { /* Marketing OS's own 30-minute sync still catches up */ }
  },
})

/** Push everything now (e.g. after a bulk import). */
export const sendAll = internalMutation({
  args: {},
  handler: async (ctx) => { await marketingChanged(ctx, { all: true }) },
})

