// Ad campaign on website orders, filled in afterwards (3 Nov 2026). COD-popup orders carry the ad's campaign in their
// order attributes, which the webhook ignored until now – so only checkout orders were matched to a campaign. Every
// 6 hours this reads the last 14 days of Shopify orders and fills in the campaign on any Ops order still missing one,
// so Marketing OS can tell which ads bring orders. Best-effort: does nothing if the Shopify API isn't set up.
import { v } from "convex/values"
import { internalAction, internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { shopifyGql } from "./shopifyStock"
import { campaignFromOrder } from "./shopify"

const DAYS = 14

const QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    nodes { id customAttributes { key value } customerJourneySummary { lastVisit { landingPage } firstVisit { landingPage } } }
    pageInfo { hasNextPage endCursor }
  }
}`

export const run = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = DAYS }) => {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const found: { externalId: string; campaignId: string }[] = []
    let after: string | null = null
    for (let page = 0; page < 30; page++) {
      let d: any
      try { d = await shopifyGql(ctx, QUERY, { q: `created_at:>=${since}`, after }) } catch (e) { console.warn("campaign backfill skipped:", e instanceof Error ? e.message : e); return { checked: 0, filled: 0 } }
      for (const n of d?.orders?.nodes ?? []) {
        const j = n.customerJourneySummary
        const campaignId = campaignFromOrder({
          note_attributes: (n.customAttributes ?? []).map((a: any) => ({ name: a.key, value: a.value })),
          landing_site: j?.lastVisit?.landingPage ?? j?.firstVisit?.landingPage,
        })
        if (campaignId) found.push({ externalId: String(n.id).split("/").pop()!, campaignId })
      }
      if (!d?.orders?.pageInfo?.hasNextPage) break
      after = d.orders.pageInfo.endCursor
    }
    let filled = 0
    for (let i = 0; i < found.length; i += 100) filled += await ctx.runMutation(internal.campaignBackfill.fill, { rows: found.slice(i, i + 100) })
    return { checked: found.length, filled }
  },
})

export const fill = internalMutation({
  args: { rows: v.array(v.object({ externalId: v.string(), campaignId: v.string() })) },
  handler: async (ctx, { rows }) => {
    let n = 0
    for (const r of rows) {
      const o = await ctx.db.query("orders").withIndex("by_external", (q) => q.eq("externalId", r.externalId)).first()
      if (!o || o.campaignId) continue
      // updatedAt moves so the Marketing OS feed picks the change up
      await ctx.db.patch(o._id, { campaignId: r.campaignId, updatedAt: Date.now() })
      n++
    }
    return n
  },
})
